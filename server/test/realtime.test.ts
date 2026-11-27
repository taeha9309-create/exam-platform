import { request } from 'node:http';
import { EV } from '@exam/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { signStaffToken } from '../src/auth/staffAuth';
import { broadcast } from '../src/realtime/broadcast';
import { startExam } from '../src/services/examLifecycle';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  // 이 환경에서는 새 DB 연결을 여는 데 약 2초가 걸린다(Windows+Docker). 개별 테스트의
  // 대기 시간을 줄이려고 연결을 미리 열고, 대기 한도(once)도 넉넉히 6초로 둔다(서버 코드 문제가 아니라 환경 보정).
  await Promise.all(Array.from({ length: 6 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })),
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(resetDb);
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

type Opts = { auth?: Record<string, unknown>; cookie?: string; origin?: string };

function open(opts: Opts = {}): Socket {
  const extraHeaders: Record<string, string> = {};
  if (opts.cookie) extraHeaders.Cookie = opts.cookie;
  if (opts.origin) extraHeaders.Origin = opts.origin;
  // 테스트(Node)에서 헤더를 실을 수 있도록 polling만 쓴다(웹소켓도 같은 allowRequest를 지난다).
  const s = connect(server.url, { auth: opts.auth, extraHeaders, transports: ['polling'], reconnection: false, forceNew: true });
  sockets.push(s);
  return s;
}

const once = <T = unknown>(s: Socket, ev: string, ms = 6000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

const connectError = (s: Socket) => once<Error>(s, 'connect_error');
const connected = (s: Socket) => once(s, 'connect');
const quiet = (s: Socket, ev: string, ms = 400) =>
  new Promise<boolean>((resolve) => {
    let got = false;
    s.on(ev, () => (got = true));
    setTimeout(() => resolve(!got), ms);
  });

async function makeAttempt(examId: string, token = generateToken()) {
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId, attempt: null } });
  const attempt = await prisma.attempt.create({
    data: { examId, rosterEntryId: roster.id, sessionTokenHash: hashToken(token), questionOrder: [], choiceOrders: {} },
  });
  return { attempt, token };
}

const join = (s: Socket, examId: unknown) => s.timeout(2000).emitWithAck(EV.DASHBOARD_JOIN, { examId }) as Promise<{ ok: boolean; code?: string }>;

describe('학생 소켓 인증', () => {
  it('토큰이 없으면 connect_error', async () => {
    const err = await connectError(open());
    expect(err.message).toBe('UNAUTHORIZED');
  });

  it('모르는 토큰·문자열이 아닌 토큰·너무 긴 토큰은 같은 고정 메시지로 거부', async () => {
    for (const sessionToken of ['nope', 123, { $ne: '' }, 'x'.repeat(5000)]) {
      const err = await connectError(open({ auth: { sessionToken } }));
      expect(err.message).toBe('UNAUTHORIZED');
    }
  });

  it('유효한 토큰이면 연결 즉시 attempt:state(WAITING)를 받는다', async () => {
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const s = open({ auth: { sessionToken: token } });
    const state = once<Record<string, unknown>>(s, EV.ATTEMPT_STATE);
    const got = await state;
    expect(got).toMatchObject({ state: 'WAITING', deadline: null, extraSeconds: 0, violationCount: 0 });
    expect(typeof got.serverNow).toBe('number');
  });

  it('토큰 원문은 DB에 없고 해시만 있다', async () => {
    const exam = await makeExam();
    const { token, attempt } = await makeAttempt(exam.id);
    expect(attempt.sessionTokenHash).toBe(hashToken(token));
    expect(attempt.sessionTokenHash).not.toContain(token);
  });

  it('학생은 자기 시험 방의 broadcast만 받고 다른 시험의 방 이벤트는 받지 않는다', async () => {
    const examA = await makeExam();
    const examB = await makeExam();
    const a = await makeAttempt(examA.id);
    const b = await makeAttempt(examB.id);
    const sa = open({ auth: { sessionToken: a.token } });
    const sb = open({ auth: { sessionToken: b.token } });
    await Promise.all([once(sa, EV.ATTEMPT_STATE), once(sb, EV.ATTEMPT_STATE)]);

    const gotA = once(sa, EV.EXAM_STARTED);
    const quietB = quiet(sb, EV.EXAM_STARTED);
    broadcast.examStarted({ ...examA, endsAt: new Date(Date.now() + 60_000) });
    await gotA;
    expect(await quietB).toBe(true);
  });

  it('학생은 dashboard:join으로 교수자 방에 들어갈 수 없다', async () => {
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const s = open({ auth: { sessionToken: token } });
    await once(s, EV.ATTEMPT_STATE);
    const ack = await join(s, exam.id);
    expect(ack.ok).toBe(false);
    const quietStaff = quiet(s, 'probe');
    broadcast.toStaff(exam.id, 'probe', { x: 1 });
    expect(await quietStaff).toBe(true);
  });

  it('학생 역할의 dashboard:join은 INTERNAL이 아니라 UNAUTHORIZED', async () => {
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const s = open({ auth: { sessionToken: token } });
    await once(s, EV.ATTEMPT_STATE);
    expect(await join(s, exam.id)).toEqual({ ok: false, code: 'UNAUTHORIZED' });
  });

  it('잘못된 학생 토큰은 유효한 교수자 쿠키가 있어도 거부(교수자로 폴백하지 않는다)', async () => {
    const staff = await makeStaff();
    const err = await connectError(open({ auth: { sessionToken: 'nope' }, cookie: staffCookie(staff.id) }));
    expect(err.message).toBe('UNAUTHORIZED');
  });

  it('revokeSession은 session:revoked를 보낸 뒤 그 응시의 소켓 연결을 끊는다', async () => {
    const exam = await makeExam();
    const a = await makeAttempt(exam.id);
    const b = await makeAttempt(exam.id);
    const sa = open({ auth: { sessionToken: a.token } });
    const sb = open({ auth: { sessionToken: b.token } });
    await Promise.all([once(sa, EV.ATTEMPT_STATE), once(sb, EV.ATTEMPT_STATE)]);
    const revoked = once(sa, EV.SESSION_REVOKED);
    const closed = once(sa, 'disconnect');
    broadcast.revokeSession(a.attempt.id);
    await revoked;
    await closed;
    expect(sa.connected).toBe(false);
    expect(sb.connected).toBe(true);
  });

  it('학생이 방 이름을 보내도 방이 바뀌지 않는다(방은 서버가 정한다)', async () => {
    const examA = await makeExam();
    const examB = await makeExam();
    const a = await makeAttempt(examA.id);
    const s = open({ auth: { sessionToken: a.token } });
    await once(s, EV.ATTEMPT_STATE);
    s.emit('join', `exam:${examB.id}:students`);
    s.emit('join', `exam:${examB.id}:staff`);
    const q = quiet(s, EV.EXAM_STARTED);
    broadcast.examStarted({ ...examB, endsAt: new Date() });
    broadcast.toStaff(examB.id, EV.EXAM_STARTED, {});
    expect(await q).toBe(true);
  });

  it('session:revoked를 해당 응시 방에만 보낸다', async () => {
    const exam = await makeExam();
    const a = await makeAttempt(exam.id);
    const b = await makeAttempt(exam.id);
    const sa = open({ auth: { sessionToken: a.token } });
    const sb = open({ auth: { sessionToken: b.token } });
    await Promise.all([once(sa, EV.ATTEMPT_STATE), once(sb, EV.ATTEMPT_STATE)]);
    const got = once(sa, EV.SESSION_REVOKED);
    const q = quiet(sb, EV.SESSION_REVOKED);
    broadcast.sessionRevoked(a.attempt.id);
    await got;
    expect(await q).toBe(true);
  });

  it('waiting:count를 학생 방과 교수자 방에 { ready, total }로 보낸다', async () => {
    const staff = await makeStaff();
    const exam = await makeExam({ ownerId: staff.id });
    const a = await makeAttempt(exam.id);
    // ready는 준비 완료(동의+환경 점검) 인원이다(SPEC F-10)
    await prisma.attempt.update({ where: { id: a.attempt.id }, data: { consentAt: new Date(), envCheckedAt: new Date() } });
    const sa = open({ auth: { sessionToken: a.token } });
    await once(sa, EV.ATTEMPT_STATE);
    const st = open({ cookie: staffCookie(staff.id) });
    await connected(st);
    expect((await join(st, exam.id)).ok).toBe(true);
    const gotStudent = once(sa, EV.WAITING_COUNT);
    const gotStaff = once(st, EV.WAITING_COUNT);
    await broadcast.waitingCount(exam.id);
    expect(await gotStudent).toEqual({ ready: 1, total: 3 });
    expect(await gotStaff).toEqual({ ready: 1, total: 3 });
  });
});

describe('교수자 소켓 인증', () => {
  it('유효한 쿠키로 dashboard:join 후 broadcast.toStaff를 받는다', async () => {
    const staff = await makeStaff();
    const exam = await makeExam({ ownerId: staff.id });
    const s = open({ cookie: staffCookie(staff.id) });
    await connected(s);
    expect(await join(s, exam.id)).toEqual({ ok: true });
    const got = once(s, 'probe');
    broadcast.toStaff(exam.id, 'probe', { hello: 1 });
    expect(await got).toEqual({ hello: 1 });
  });

  it('join하지 않은 시험의 toStaff는 받지 않는다', async () => {
    const staff = await makeStaff();
    const examA = await makeExam({ ownerId: staff.id });
    const examB = await makeExam({ ownerId: staff.id });
    const s = open({ cookie: staffCookie(staff.id) });
    await connected(s);
    await join(s, examA.id);
    const q = quiet(s, 'probe');
    broadcast.toStaff(examB.id, 'probe', {});
    expect(await q).toBe(true);
  });

  it('없는 시험·잘못된 examId는 ack 거부', async () => {
    const staff = await makeStaff();
    const s = open({ cookie: staffCookie(staff.id) });
    await connected(s);
    for (const bad of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', 123, null, { a: 1 }]) {
      expect((await join(s, bad)).ok).toBe(false);
    }
  });

  it('삭제된 교수자의 유효한 쿠키는 연결 거부', async () => {
    const staff = await makeStaff();
    const cookie = staffCookie(staff.id);
    await prisma.staff.delete({ where: { id: staff.id } });
    const err = await connectError(open({ cookie }));
    expect(err.message).toBe('UNAUTHORIZED');
  });

  it('위조(다른 키 서명)·쓰레기 쿠키는 연결 거부', async () => {
    const staff = await makeStaff();
    const good = signStaffToken(staff.id);
    const forged = `${good.slice(0, -4)}AAAA`;
    for (const cookie of [`staff_token=${forged}`, 'staff_token=garbage', 'staff_token=', 'staff_token=%E0%A4%A', 'other=1']) {
      const err = await connectError(open({ cookie }));
      expect(err.message).toBe('UNAUTHORIZED');
    }
  });

  it('중복 staff_token 쿠키는 첫 번째 값만 쓴다(HTTP cookie-parser와 동일)', async () => {
    const staff = await makeStaff();
    const err = await connectError(open({ cookie: `staff_token=garbage; staff_token=${signStaffToken(staff.id)}` }));
    expect(err.message).toBe('UNAUTHORIZED');
  });
});

/** 핸드셰이크 GET을 직접 보낸다(브라우저의 <script src>·fetch 메타데이터 헤더를 흉내 내려고). */
function rawGet(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${server.url}${path}`, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('JSONP·Fetch Metadata·옵션', () => {
  const HS = '/socket.io/?EIO=4&transport=polling';

  it('유효한 교수자 쿠키가 있어도 JSONP(&j=0) 핸드셰이크는 403', async () => {
    const staff = await makeStaff();
    const res = await rawGet(`${HS}&j=0`, { Cookie: staffCookie(staff.id) });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('sid');
  });

  it('Origin 없는 일반 폴링 핸드셰이크는 여전히 허용(비브라우저 클라이언트)', async () => {
    const res = await rawGet(HS);
    expect(res.status).toBe(200);
  });

  it('Origin 없이 Sec-Fetch-Site가 cross-site·same-site면 거부, same-origin·none은 허용', async () => {
    expect((await rawGet(HS, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await rawGet(HS, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await rawGet(HS, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await rawGet(HS, { 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });

  it('클라이언트 스크립트를 서빙하지 않는다(serveClient: false)', async () => {
    const res = await rawGet('/socket.io/socket.io.js');
    expect(res.status).not.toBe(200);
  });

  it('dashboard:join을 페이로드 없이 ack만으로 보내도 ack를 받는다(INVALID_INPUT)', async () => {
    const staff = await makeStaff();
    const s = open({ cookie: staffCookie(staff.id) });
    await connected(s);
    const ack = (await s.timeout(2000).emitWithAck(EV.DASHBOARD_JOIN)) as { ok: boolean; code?: string };
    expect(ack).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('Origin 검사(교차 출처 웹소켓 하이재킹 방어)', () => {
  it('다른 출처의 Origin은 유효한 쿠키여도 거부', async () => {
    const staff = await makeStaff();
    const s1 = open({ cookie: staffCookie(staff.id), origin: 'https://evil.example' });
    const err = await connectError(s1);
    expect(err.message).not.toBe('');
    expect(s1.connected).toBe(false);
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const s2 = open({ auth: { sessionToken: token }, origin: 'http://127.0.0.1.evil.example' });
    expect((await connectError(s2)).message).not.toBe('');
    expect(s2.connected).toBe(false);
  });

  it('자기 출처(Host 기준)는 허용', async () => {
    const staff = await makeStaff();
    const s = open({ cookie: staffCookie(staff.id), origin: server.url });
    await connected(s);
  });

  it('ALLOWED_ORIGINS에 적은 출처는 허용', async () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    try {
      const staff = await makeStaff();
      const s = open({ cookie: staffCookie(staff.id), origin: 'http://localhost:5173' });
      await connected(s);
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it('Origin이 "null"인 요청은 거부', async () => {
    const staff = await makeStaff();
    const s = open({ cookie: staffCookie(staff.id), origin: 'null' });
    expect((await connectError(s)).message).not.toBe('');
    expect(s.connected).toBe(false);
  });
});

describe('재연결 시 현재 상태 동기화', () => {
  const ready = { consentAt: new Date(), envCheckedAt: new Date() };

  it('연결 → 끊기 → startExam → 재연결: 첫 attempt:state가 ACTIVE이고 deadline이 endsAt 기반', async () => {
    const exam = await makeExam({ status: 'OPEN', passcode: 'A1B2C3' });
    const { attempt, token } = await makeAttempt(exam.id);
    await prisma.attempt.update({ where: { id: attempt.id }, data: ready });

    const first = open({ auth: { sessionToken: token } });
    expect((await once<{ state: string }>(first, EV.ATTEMPT_STATE)).state).toBe('WAITING');
    first.close();

    const started = await startExam(exam.id);
    const second = open({ auth: { sessionToken: token } });
    const got = await once<{ state: string; deadline: number | null }>(second, EV.ATTEMPT_STATE);
    expect(got.state).toBe('ACTIVE');
    expect(got.deadline).toBe(started.endsAt!.getTime());
  });

  it('extraSeconds가 deadline에 더해진다', async () => {
    const exam = await makeExam({ status: 'OPEN', passcode: 'A1B2C3' });
    const { attempt, token } = await makeAttempt(exam.id);
    await prisma.attempt.update({ where: { id: attempt.id }, data: { ...ready, extraSeconds: 90 } });
    const started = await startExam(exam.id);
    const got = await once<{ deadline: number; extraSeconds: number }>(open({ auth: { sessionToken: token } }), EV.ATTEMPT_STATE);
    expect(got.extraSeconds).toBe(90);
    expect(got.deadline).toBe(started.endsAt!.getTime() + 90_000);
  });

  it('재연결 전에 DB 상태를 바꾸면 바뀐 값이 온다(낡은 값 없음)', async () => {
    const exam = await makeExam({ status: 'OPEN', passcode: 'A1B2C3' });
    const { attempt, token } = await makeAttempt(exam.id);
    const first = open({ auth: { sessionToken: token } });
    expect((await once<{ state: string }>(first, EV.ATTEMPT_STATE)).state).toBe('WAITING');
    first.close();
    await prisma.attempt.update({ where: { id: attempt.id }, data: { state: 'PAUSED', violationCount: 2 } });
    const got = await once<{ state: string; violationCount: number }>(open({ auth: { sessionToken: token } }), EV.ATTEMPT_STATE);
    expect(got).toMatchObject({ state: 'PAUSED', violationCount: 2 });
  });

  it('WAITING이면 연결한 소켓에만 waiting:count(준비 완료 / 명단)를 보낸다', async () => {
    const exam = await makeExam({ status: 'OPEN', passcode: 'A1B2C3' });
    const a = await makeAttempt(exam.id);
    const b = await makeAttempt(exam.id);
    await prisma.attempt.update({ where: { id: a.attempt.id }, data: ready });
    const sa = open({ auth: { sessionToken: a.token } });
    expect(await once<{ ready: number; total: number }>(sa, EV.WAITING_COUNT)).toEqual({ ready: 1, total: 3 });
    // 두 번째 학생이 연결해도 이미 연결된 첫 소켓에는 waiting:count가 오지 않는다.
    const quietA = quiet(sa, EV.WAITING_COUNT);
    const sb = open({ auth: { sessionToken: b.token } });
    expect(await once<{ ready: number; total: number }>(sb, EV.WAITING_COUNT)).toEqual({ ready: 1, total: 3 });
    expect(await quietA).toBe(true);
  });

  it('WAITING이 아니면 waiting:count를 보내지 않고, 종착 응시는 그 상태를 그대로 받는다', async () => {
    const exam = await makeExam({ status: 'ENDED' });
    const { attempt, token } = await makeAttempt(exam.id);
    await prisma.attempt.update({ where: { id: attempt.id }, data: { state: 'SUBMITTED' } });
    const s = open({ auth: { sessionToken: token } });
    const gotCount = quiet(s, EV.WAITING_COUNT);
    const got = await once<Record<string, unknown>>(s, EV.ATTEMPT_STATE);
    expect(got.state).toBe('SUBMITTED');
    expect(JSON.stringify(got)).not.toMatch(/passcode|correct|Hash/i);
    expect(await gotCount).toBe(true);
  });

  it('인증 실패 연결은 상태를 받지 못한다', async () => {
    const s = open({ auth: { sessionToken: 'nope' } });
    const got = quiet(s, EV.ATTEMPT_STATE, 800);
    expect((await connectError(s)).message).toBe('UNAUTHORIZED');
    expect(await got).toBe(true);
  });
});
