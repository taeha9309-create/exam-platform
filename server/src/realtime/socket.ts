import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { EV } from '@exam/shared';
import type { Attempt, Exam } from '@prisma/client';
import { parse as parseCookie } from 'cookie';
import jwt from 'jsonwebtoken';
import { Server, type Socket } from 'socket.io';
import { authenticateStaff, STAFF_COOKIE } from '../auth/staffAuth';
import { findAttemptByToken } from '../auth/studentSession';
import { prisma } from '../db';
import { AppError } from '../errors';
import { normalizeIpKey } from '../security/loginProtection';
import { createRateLimiter } from '../security/rateLimit';
import { saveAnswer } from '../services/submission';
import { attemptRoom, attemptStatePayload, setIo, staffRoom, studentsRoom } from './broadcast';

/** 연결 거부 사유는 항상 이 고정 문자열이다. 토큰 없음·위조·삭제된 계정·모르는 학생 토큰을 밖에서 구별할 수 없게 한다. */
const AUTH_ERROR = 'UNAUTHORIZED';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sessionTokenHash: 소켓 인증 때의 토큰 해시(원문 아님). answer:save가 저장할 때마다 DB의 현재 해시와 비교한다(세션 폐기 감지). */
type SocketData =
  | { role: 'student'; attemptId: string; examId: string; sessionTokenHash: string }
  | { role: 'staff'; staffId: string; tokenExpMs: number };

/** 같은 주체(같은 학생 응시·같은 교수자 계정)가 동시에 가질 수 있는 소켓 수. 넘으면 가장 오래된 것을 끊는다. 탭 두세 개는 정상 사용이다. */
export const MAX_SOCKETS_PER_PRINCIPAL = 3;
/** 소켓 인증 실패 한도: IP당 1분 30회. 성공한 연결은 세지 않는다(교실 NAT에서 여러 학생이 같은 IP로 입장한다). */
export const AUTH_FAIL_MAX = 30;
export const AUTH_FAIL_WINDOW_MS = 60_000;
/** 열린 교수자 소켓의 계정 재확인 기본 주기 */
export const STAFF_RECHECK_MS = 60_000;
/** setTimeout이 다룰 수 있는 최대 지연(약 24.8일). 넘으면 즉시 실행되어 버린다. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface AttachSocketOptions {
  /** 교수자 소켓의 DB 계정 재확인 주기(ms). 기본 60초. 테스트에서 줄여 넣는다 */
  staffRecheckMs?: number;
  /** 서버 시계(ms). 토큰 exp 비교와 인증 실패 한도에 쓴다. 기본 Date.now. 테스트에서 가짜 시계를 넣는다 */
  now?: () => number;
  /**
   * 앞단 프록시 수(app.ts의 trustProxy와 같은 값, index.ts가 한 변수로 둘에 넘긴다). 운영에서 프록시가 N겹이면 N, 비운영·프록시 없음은 생략(0).
   * 프록시 뒤인데 0이면 모든 클라이언트가 프록시 주소 하나로 보여 인증 실패 한도가 서비스 전체에 걸린다. 0(기본)이면 X-Forwarded-For를 전혀 믿지 않고 소켓 주소를 쓴다.
   * n>0이면 오른쪽에서 n번째(프록시가 붙인) 항목을 쓴다. 클라이언트가 왼쪽에 끼워 넣은 값은 무시된다.
   */
  trustProxy?: number;
}

/** 한도 집계용 클라이언트 IP. 기본은 TCP 소켓 주소(위조 불가). trustProxy가 있을 때만 X-Forwarded-For의 신뢰 가능한 항목을 쓴다. */
function clientIp(req: IncomingMessage, trustProxy: number): string | undefined {
  if (trustProxy > 0) {
    const raw = req.headers['x-forwarded-for'];
    const parts = (Array.isArray(raw) ? raw.join(',') : raw)?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
    const picked = parts[parts.length - trustProxy];
    if (picked) return picked;
  }
  return req.socket.remoteAddress;
}

/**
 * answer:save 소켓당 속도 제한(토큰 버킷). 정상 자동 저장은 문항당 1초 디바운스 + 5초 주기라 초당 몇 건이지만,
 * 오프라인 뒤 재연결하면 미저장 문항(최대 100개)을 한꺼번에 보낼 수 있어 버스트를 넉넉히 허용한다.
 * 한도를 넘으면 DB에 가지 않고 BUSY(SPEC 코드 목록에 속도 제한 전용 코드가 없어 가장 가까운 "잠시 후 다시")로 답한다.
 */
export const ANSWER_SAVE_BURST = 100;
export const ANSWER_SAVE_REFILL_PER_SEC = 20;

interface Bucket {
  tokens: number;
  at: number;
}

function takeToken(bucket: Bucket, nowMs: number): boolean {
  bucket.tokens = Math.min(ANSWER_SAVE_BURST, bucket.tokens + ((nowMs - bucket.at) / 1000) * ANSWER_SAVE_REFILL_PER_SEC);
  bucket.at = nowMs;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** URL의 출처(소문자 스킴://호스트[:기본 포트 생략]). 형식이 틀렸거나 "null" 출처면 null. */
function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * 교차 출처 웹소켓 하이재킹(CSWSH) 방어. HTTP의 originCheck(security/originCheck.ts)와 같은 규칙이다:
 * Origin이 있으면 자기 출처(스킴://Host 헤더) 또는 ALLOWED_ORIGINS와 문자열 전체가 같아야 한다. 접두사·부분 일치 없음.
 * 웹소켓 핸드셰이크와 fetch/XHR 폴링은 브라우저가 Origin을 붙이지만, <script src> 요청(JSONP 폴링)은 Origin이 없고
 * SameSite=Lax 쿠키가 실릴 수 있다. 그래서 (1) JSONP(`j` 쿼리)는 allowRequest에서 막고, (2) Origin이 없는 요청은
 * 비브라우저 클라이언트(테스트·curl)로 보고 허용하되 Sec-Fetch-Site가 있고 same-origin·none이 아니면 거부한다.
 * (originCheck.ts의 함수를 export해 재사용하려면 그 파일 수정이 필요해 규칙만 복제했다. 규칙을 바꿀 때는 두 곳을 함께 고친다.)
 */
function isAllowedOrigin(req: IncomingMessage): boolean {
  const originHeader = req.headers.origin;
  if (originHeader === undefined) {
    const site = req.headers['sec-fetch-site'];
    if (site === undefined) return true;
    return site === 'same-origin' || site === 'none';
  }
  const requestOrigin = typeof originHeader === 'string' ? originOf(originHeader) : null;
  if (!requestOrigin) return false;

  // 운영(Railway)은 프록시 뒤에 있어 그때만 X-Forwarded-Proto를 믿는다(app.ts의 trust proxy와 같은 조건).
  let proto = (req.socket as TLSSocket).encrypted ? 'https' : 'http';
  if (process.env.NODE_ENV === 'production') {
    const forwarded = req.headers['x-forwarded-proto'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first === 'http' || first === 'https') proto = first;
  }
  const host = req.headers.host;
  const self = host ? originOf(`${proto}://${host}`) : null;
  if (requestOrigin === self) return true;

  for (const part of (process.env.ALLOWED_ORIGINS ?? '').split(',')) {
    if (originOf(part.trim()) === requestOrigin) return true;
  }
  return false;
}

/** Cookie 헤더에서 staff_token 값. HTTP의 cookie-parser와 같은 `cookie` 패키지로 파싱하므로 중복 이름은 첫 값, 잘못된 인코딩은 원문 유지. */
function staffTokenFromCookieHeader(header: string | undefined): unknown {
  if (typeof header !== 'string') return undefined;
  try {
    return parseCookie(header)[STAFF_COOKIE];
  } catch {
    return undefined;
  }
}

async function authenticate(socket: Socket): Promise<SocketData | null> {
  const auth: unknown = socket.handshake.auth;
  const sessionToken = typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>).sessionToken : undefined;

  // 학생: auth.sessionToken이 있으면 학생으로만 취급한다(실패해도 교수자 쿠키로 되돌아가지 않는다).
  if (sessionToken !== undefined) {
    const attempt = await findAttemptByToken(sessionToken);
    if (!attempt) return null;
    socket.data.attempt = attempt; // 연결 직후 attempt:state에 쓴다. 토큰 원문은 어디에도 보관·기록하지 않는다.
    return { role: 'student', attemptId: attempt.id, examId: attempt.examId, sessionTokenHash: attempt.sessionTokenHash };
  }

  // 교수자: HTTP와 같은 authenticateStaff(서명·만료 검증 + DB 재조회).
  const rawToken = staffTokenFromCookieHeader(socket.handshake.headers.cookie);
  const staff = await authenticateStaff(rawToken);
  if (!staff) return null;
  // authenticateStaff가 서명·만료를 이미 검증했으므로 여기서는 exp만 읽는다(검증된 토큰이라 decode로 충분하다).
  const exp = typeof rawToken === 'string' ? (jwt.decode(rawToken) as { exp?: unknown } | null)?.exp : undefined;
  if (typeof exp !== 'number') return null; // exp 없는 토큰은 만료 시각에 끊을 수 없어 받지 않는다(우리가 발급한 토큰에는 항상 있다).
  return { role: 'staff', staffId: staff.id, tokenExpMs: exp * 1000 };
}

type Ack = (res: { ok: boolean; code?: string }) => void;

async function handleDashboardJoin(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  // 페이로드 없이 emitWithAck하면 ack가 첫 인자로 들어온다.
  if (typeof payload === 'function' && ack === undefined) {
    ack = payload;
    payload = undefined;
  }
  const reply: Ack = typeof ack === 'function' ? (ack as Ack) : () => {};
  const data = socket.data as SocketData;
  // 인증된 교수자만. 학생 소켓은 어떤 방에도 이 경로로 들어갈 수 없다.
  if (data.role !== 'staff') return reply({ ok: false, code: 'UNAUTHORIZED' });
  const examId = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).examId : undefined;
  if (typeof examId !== 'string' || !UUID.test(examId)) return reply({ ok: false, code: 'INVALID_INPUT' });
  try {
    // 연결 후 계정이 삭제됐을 수 있으므로 join 때 다시 확인한다. 교수자는 모든 시험에 접근한다(D-016).
    const [staff, exam] = await Promise.all([
      prisma.staff.findUnique({ where: { id: data.staffId }, select: { id: true } }),
      prisma.exam.findUnique({ where: { id: examId }, select: { id: true } }),
    ]);
    if (!staff) return reply({ ok: false, code: 'UNAUTHORIZED' });
    if (!exam) return reply({ ok: false, code: 'NOT_FOUND' });
    // 방 이름은 서버가 만든다. 스냅샷 ack는 계획 2에서 확장한다.
    await socket.join(staffRoom(exam.id));
    reply({ ok: true });
  } catch {
    reply({ ok: false, code: 'INTERNAL' });
  }
}

type SaveAck = (res: { ok: true; savedAt: string } | { ok: false; code: string }) => void;

/**
 * 답안 저장(F-11). 학생 소켓만. ack는 {ok:true,savedAt} 또는 {ok:false,code}뿐이고 내부 오류 내용은 내보내지 않는다.
 * 저장할 때마다 saveAnswer가 DB에서 토큰 해시·상태·마감을 다시 확인한다(소켓은 인증 뒤에도 세션이 폐기될 수 있다).
 */
async function handleAnswerSave(socket: Socket, payload: unknown, ack: unknown, bucket: Bucket): Promise<void> {
  // 페이로드 없이 emitWithAck하면 ack가 첫 인자로 들어온다.
  if (typeof payload === 'function' && ack === undefined) {
    ack = payload;
    payload = undefined;
  }
  const send: SaveAck = (res) => {
    if (typeof ack !== 'function') return;
    try {
      (ack as SaveAck)(res);
    } catch {
      // 연결이 이미 끊겼어도 서버는 계속 동작한다.
    }
  };
  const data = socket.data as SocketData;
  if (data.role !== 'student') return send({ ok: false, code: 'UNAUTHORIZED' });
  if (!takeToken(bucket, Date.now())) return send({ ok: false, code: 'BUSY' });
  try {
    const res = await saveAnswer(data.attemptId, data.sessionTokenHash, payload, new Date());
    if (res.ok) return send({ ok: true, savedAt: res.savedAt.toISOString() });
    send({ ok: false, code: res.code });
    if (res.revoked) setTimeout(() => socket.disconnect(true), 50).unref(); // ack가 먼저 전달되도록 잠깐 뒤에 끊는다.
  } catch (err) {
    console.error('답안 저장 실패', err instanceof Error ? err.message : 'unknown');
    send({ ok: false, code: err instanceof AppError && err.code === 'BUSY' ? 'BUSY' : 'INTERNAL' });
  }
}

/**
 * 학생 소켓 연결 직후 현재 상태를 보낸다. 인증이 끝난 연결에서만 호출된다.
 * 방에 먼저 들어간 뒤 DB를 읽는다: 읽기 이후의 상태 변경은 방 브로드캐스트로 받으므로 놓치는 틈이 없다.
 * 응시가 그 사이 삭제됐으면 보낼 상태가 없으므로 연결을 끊는다. 종착 상태(제출·종료·거절)는 그대로 보낸다.
 */
async function syncStudentState(socket: Socket, attemptId: string, examId: string): Promise<void> {
  await socket.join([attemptRoom(attemptId), studentsRoom(examId)]);
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) {
    socket.disconnect(true);
    return;
  }
  if (!socket.connected) return;
  socket.emit(EV.ATTEMPT_STATE, attemptStatePayload(attempt, attempt.exam));
  if (attempt.state === 'WAITING') {
    // broadcast.waitingCount와 같은 조건(준비 완료 = WAITING + 동의 + 환경 점검). 이 소켓에만 보낸다.
    const [ready, total] = await Promise.all([
      prisma.attempt.count({ where: { examId: attempt.examId, state: 'WAITING', consentAt: { not: null }, envCheckedAt: { not: null } } }),
      prisma.rosterEntry.count({ where: { examId: attempt.examId } }),
    ]);
    if (socket.connected) socket.emit(EV.WAITING_COUNT, { ready, total });
  }
}

/** http 서버에 Socket.IO를 붙인다. 교수자는 쿠키 staff_token, 학생은 handshake.auth.sessionToken으로 인증한다. */
export function attachSocket(httpServer: HttpServer, options: AttachSocketOptions = {}): Server {
  const now = options.now ?? Date.now;
  const staffRecheckMs = options.staffRecheckMs ?? STAFF_RECHECK_MS;
  const trustProxy = options.trustProxy ?? 0;
  // 인증 실패 전용 한도(로그인·입장 한도와 별도 인스턴스). 프로세스 메모리에만 있다(rateLimit.ts의 한계와 같다).
  const authFailLimiter = createRateLimiter({ windowMs: AUTH_FAIL_WINDOW_MS, max: AUTH_FAIL_MAX, maxKeys: 10_000, now });
  // 주체별 열린 소켓(연결 순서). 끊기면 항상 지우므로 빈 키는 남지 않는다.
  const byPrincipal = new Map<string, Socket[]>();
  const io = new Server(httpServer, {
    // cors 옵션을 주지 않는다: 다른 출처에 CORS 허용 헤더를 내지 않는다(같은 출처 서비스).
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    connectTimeout: 10_000,
    allowRequest: (req, callback) => {
      // JSONP 폴링은 <script src>로 호출되어 Origin 없이 쿠키가 실린다. 응답의 sid를 공격자가 쓸 수 있으므로 끈다.
      if (new URL(req.url ?? '/', 'http://x').searchParams.has('j')) return callback('JSONP disabled', false);
      callback(null, isAllowedOrigin(req));
    },
  });

  io.use((socket, next) => {
    const ipKey = normalizeIpKey(clientIp(socket.request, trustProxy));
    // 한도를 넘은 IP는 DB를 조회하지 않고 같은 고정 메시지로 거절한다(성공·실패·한도를 밖에서 구별할 수 없다).
    if (!authFailLimiter.check(ipKey).allowed) return next(new Error(AUTH_ERROR));
    authenticate(socket)
      .then((data) => {
        if (!data) {
          authFailLimiter.hit(ipKey); // 실패만 센다. 성공한 연결은 세지 않는다.
          return next(new Error(AUTH_ERROR));
        }
        socket.data.role = data.role;
        Object.assign(socket.data, data);
        next();
      })
      .catch(() => next(new Error(AUTH_ERROR))); // 내부 오류 내용은 밖으로 보내지 않는다.
  });

  io.on('connection', (socket) => {
    // 학생이 dashboard:join을 보내도 핸들러가 거부 ack를 준다(방에는 들어가지 못한다).
    socket.on(EV.DASHBOARD_JOIN, (payload: unknown, ack: unknown) => void handleDashboardJoin(socket, payload, ack));

    const data = socket.data as SocketData & { attempt?: Attempt & { exam: Exam } };
    const bucket: Bucket = { tokens: ANSWER_SAVE_BURST, at: Date.now() };
    socket.on(EV.ANSWER_SAVE, (payload: unknown, ack: unknown) => void handleAnswerSave(socket, payload, ack, bucket));

    if (socket.disconnected) return; // 연결 직후 이미 끊긴 소켓은 등록·타이머를 만들지 않는다(정리할 disconnect 이벤트가 이미 지나갔을 수 있다).
    registerPrincipal(socket, data);
    if (data.role === 'staff') watchStaff(socket, data);

    if (data.role === 'student') {
      delete data.attempt; // authenticate가 읽은 값은 낡을 수 있어 쓰지 않는다(아래에서 DB를 다시 읽는다).
      void syncStudentState(socket, data.attemptId, data.examId).catch(() => socket.disconnect(true));
    }
  });

  /** 같은 주체의 소켓을 MAX_SOCKETS_PER_PRINCIPAL개까지만 허용한다. 넘으면 가장 오래된 것을 끊는다. 연결 끊김은 응시 상태를 바꾸지 않는다. */
  function registerPrincipal(socket: Socket, data: SocketData): void {
    const key = data.role === 'student' ? `student:${data.attemptId}` : `staff:${data.staffId}`;
    const list = byPrincipal.get(key) ?? [];
    list.push(socket);
    byPrincipal.set(key, list);
    socket.once('disconnect', () => {
      const cur = byPrincipal.get(key);
      if (!cur) return;
      const rest = cur.filter((x) => x !== socket);
      if (rest.length === 0) byPrincipal.delete(key);
      else byPrincipal.set(key, rest);
    });
    // 끊긴 소켓의 방은 socket.io가 disconnect 때 정리하고, 위 disconnect 핸들러가 목록에서 뺀다.
    while (list.length > MAX_SOCKETS_PER_PRINCIPAL) list.shift()!.disconnect(true);
  }

  /** 교수자 소켓: 토큰 exp 시각에 끊고, 주기적으로 계정이 남아 있는지 DB로 다시 확인한다. 타이머는 disconnect 때 모두 정리한다. */
  function watchStaff(socket: Socket, data: Extract<SocketData, { role: 'staff' }>): void {
    let rechecking = false;
    let expiryTimer: NodeJS.Timeout | undefined;
    let recheckTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (recheckTimer) clearInterval(recheckTimer);
      expiryTimer = recheckTimer = undefined;
    };
    socket.once('disconnect', stop);

    const armExpiry = (): void => {
      const remaining = data.tokenExpMs - now();
      if (remaining <= 0) return void socket.disconnect(true);
      // 아주 긴 지연은 잘라서 다시 건다(깨어날 때마다 서버 시계로 남은 시간을 다시 계산한다).
      expiryTimer = setTimeout(armExpiry, Math.min(remaining, MAX_TIMER_MS));
      expiryTimer.unref();
    };
    armExpiry();

    recheckTimer = setInterval(() => {
      if (now() >= data.tokenExpMs) return void socket.disconnect(true);
      if (rechecking) return;
      rechecking = true;
      prisma.staff
        .findUnique({ where: { id: data.staffId }, select: { id: true } })
        .then((staff) => {
          if (!staff) socket.disconnect(true);
        })
        .catch(() => {}) // 일시적인 DB 오류로 연결을 끊지 않는다. 다음 주기에 다시 확인한다.
        .finally(() => {
          rechecking = false;
        });
    }, staffRecheckMs);
    recheckTimer.unref();
  }

  setIo(io);
  return io;
}
