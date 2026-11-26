import { EV } from '@exam/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { signStaffToken } from '../src/auth/staffAuth';
import { broadcast } from '../src/realtime/broadcast';
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

describe('Origin 검사(교차 출처 웹소켓 하이재킹 방어)', () => {
  it('다른 출처의 Origin은 유효한 쿠키여도 거부', async () => {
    const staff = await makeStaff();
    const err = await connectError(open({ cookie: staffCookie(staff.id), origin: 'https://evil.example' }));
    expect(err.message).not.toBe('');
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    await connectError(open({ auth: { sessionToken: token }, origin: 'http://127.0.0.1.evil.example' }));
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
    await connectError(open({ cookie: staffCookie(staff.id), origin: 'null' }));
  });
});
