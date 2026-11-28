import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { EV } from '@exam/shared';
import type { Attempt, Exam } from '@prisma/client';
import { parse as parseCookie } from 'cookie';
import { Server, type Socket } from 'socket.io';
import { authenticateStaff, STAFF_COOKIE } from '../auth/staffAuth';
import { findAttemptByToken } from '../auth/studentSession';
import { prisma } from '../db';
import { AppError } from '../errors';
import { loadDashboardSnapshot } from '../services/dashboard';
import { saveAnswer } from '../services/submission';
import { attemptRoom, attemptStatePayload, setIo, staffRoom, studentsRoom } from './broadcast';

/** 연결 거부 사유는 항상 이 고정 문자열이다. 토큰 없음·위조·삭제된 계정·모르는 학생 토큰을 밖에서 구별할 수 없게 한다. */
const AUTH_ERROR = 'UNAUTHORIZED';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sessionTokenHash: 소켓 인증 때의 토큰 해시(원문 아님). answer:save가 저장할 때마다 DB의 현재 해시와 비교한다(세션 폐기 감지). */
type SocketData = { role: 'student'; attemptId: string; examId: string; sessionTokenHash: string } | { role: 'staff'; staffId: string };

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
  const staff = await authenticateStaff(staffTokenFromCookieHeader(socket.handshake.headers.cookie));
  return staff ? { role: 'staff', staffId: staff.id } : null;
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
    // 방 이름은 서버가 만든다. 방에 먼저 들어간 뒤 스냅샷을 읽는다: 읽은 이후의 변경은 방 이벤트로 받으므로 놓치는 틈이 없다.
    await socket.join(staffRoom(exam.id));
    const snapshot = await loadDashboardSnapshot(exam.id);
    if (!snapshot) return reply({ ok: false, code: 'NOT_FOUND' });
    // 스냅샷은 이 소켓에만 보낸다(ack보다 먼저: 같은 연결에서 순서가 보장된다).
    socket.emit(EV.DASHBOARD_SNAPSHOT, snapshot);
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
export function attachSocket(httpServer: HttpServer): Server {
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
    authenticate(socket)
      .then((data) => {
        if (!data) return next(new Error(AUTH_ERROR));
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

    if (data.role === 'student') {
      delete data.attempt; // authenticate가 읽은 값은 낡을 수 있어 쓰지 않는다(아래에서 DB를 다시 읽는다).
      void syncStudentState(socket, data.attemptId, data.examId).catch(() => socket.disconnect(true));
    }
  });

  setIo(io);
  return io;
}
