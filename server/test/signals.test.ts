import { EV } from '@exam/shared';
import type { AttemptState, Exam } from '@prisma/client';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { resolveApproval } from '../src/services/entry';
import { lockExam, runExamTx } from '../src/services/examLifecycle';
import { MAX_CLIENT_SIGNALS_PER_ATTEMPT, parseClientSignal, recordClientSignal, recordHeartbeat, recordServerSignal } from '../src/services/signals';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

type Ack = { ok: boolean; code?: string };
let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];

vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  server = await startTestServer();
  await Promise.all(Array.from({ length: 8 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
}, 60_000);
afterAll(async () => {
  await server.close();
});
beforeEach(resetDb);
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

function open(opts: { auth?: Record<string, unknown>; cookie?: string } = {}): Socket {
  const extraHeaders: Record<string, string> = {};
  if (opts.cookie) extraHeaders.Cookie = opts.cookie;
  const s = connect(server.url, { auth: opts.auth, extraHeaders, transports: ['polling'], reconnection: false, forceNew: true });
  sockets.push(s);
  return s;
}
const once = <T = unknown>(s: Socket, ev: string, ms = 8000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fx {
  exam: Exam;
  staffId: string;
}
async function fixture(): Promise<Fx> {
  const staff = await makeStaff();
  const exam = await makeExam({ ownerId: staff.id, status: 'RUNNING', startedAt: new Date(), endsAt: new Date(Date.now() + 600_000) });
  return { exam, staffId: staff.id };
}
async function makeAttempt(fx: Fx, over: { state?: AttemptState; index?: number; lastSeq?: number; violationCount?: number } = {}) {
  const token = generateToken();
  const roster = await prisma.rosterEntry.findMany({ where: { examId: fx.exam.id }, orderBy: { studentNo: 'asc' } });
  const attempt = await prisma.attempt.create({
    data: {
      examId: fx.exam.id,
      rosterEntryId: roster[over.index ?? 0]!.id,
      state: over.state ?? 'ACTIVE',
      sessionTokenHash: hashToken(token),
      questionOrder: [],
      choiceOrders: {},
      consentAt: new Date(),
      envCheckedAt: new Date(),
      lastSeq: over.lastSeq ?? 0,
      violationCount: over.violationCount ?? 0,
    },
  });
  return { attempt, token };
}
async function studentSocket(token: string): Promise<Socket> {
  const s = open({ auth: { sessionToken: token } });
  const first = once(s, EV.ATTEMPT_STATE);
  await once(s, 'connect');
  await first;
  return s;
}
async function staffSocket(fx: Fx): Promise<Socket> {
  const s = open({ cookie: staffCookie(fx.staffId) });
  await once(s, 'connect');
  const snap = once(s, EV.DASHBOARD_SNAPSHOT);
  await s.timeout(4000).emitWithAck(EV.DASHBOARD_JOIN, { examId: fx.exam.id });
  await snap;
  return s;
}
const send = (s: Socket, payload: unknown) => s.timeout(5000).emitWithAck(EV.SIGNAL, payload) as Promise<Ack>;
let seqCounter = 0;
const sig = (type: string, extra: Record<string, unknown> = {}, seq?: number) => ({ seq: seq ?? ++seqCounter, type, clientAt: Date.now(), meta: {}, ...extra });
const reload = (id: string) => prisma.attempt.findUniqueOrThrow({ where: { id } });
const signalsOf = (id: string) => prisma.signal.findMany({ where: { attemptId: id }, orderBy: [{ receivedAt: 'asc' }, { seq: 'asc' }] });
const actionsOf = (id: string) => prisma.proctorAction.findMany({ where: { attemptId: id } });
beforeEach(() => {
  seqCounter = 0;
});

describe('위반 카운트와 알림', () => {
  it('(a) ACTIVE의 FULLSCREEN_EXIT: Signal 1건·카운트 1·학생 violation:counted·교수자 signal:new', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const staff = await staffSocket(fx);
    const stu = await studentSocket(token);
    const counted = once<{ count: number; limit: number; type: string }>(stu, EV.VIOLATION_COUNTED);
    const fresh = once<{ attemptId: string; signal: { type: string; severity: string } }>(staff, EV.SIGNAL_NEW);
    const updated = once<{ attemptId: string; violationCount: number }>(staff, EV.ATTEMPT_UPDATED);
    expect(await send(stu, sig('FULLSCREEN_EXIT'))).toEqual({ ok: true });
    expect(await counted).toEqual({ count: 1, limit: 5, type: 'FULLSCREEN_EXIT' });
    const n = await fresh;
    expect(n.attemptId).toBe(attempt.id);
    expect(n.signal).toMatchObject({ type: 'FULLSCREEN_EXIT', severity: 'WARN' });
    expect((await updated).violationCount).toBe(1);
    expect(await signalsOf(attempt.id)).toHaveLength(1);
    const row = await reload(attempt.id);
    expect(row).toMatchObject({ violationCount: 1, lastSeq: 1, unackedSeverity: 'WARN', state: 'ACTIVE' });
  });

  it('(b) 위반 5건이면 PAUSED + AUTO_PAUSE 1건(staffId null) + attempt:state PAUSED(locked true)', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    for (let i = 0; i < 4; i++) expect((await send(stu, sig('FULLSCREEN_EXIT'))).ok).toBe(true);
    expect((await reload(attempt.id)).state).toBe('ACTIVE');
    const state = once<{ state: string; locked?: boolean; violationCount: number }>(stu, EV.ATTEMPT_STATE);
    expect((await send(stu, sig('FULLSCREEN_EXIT'))).ok).toBe(true);
    expect(await state).toMatchObject({ state: 'PAUSED', locked: true, violationCount: 5 });
    const row = await reload(attempt.id);
    expect(row.state).toBe('PAUSED');
    expect(row.pausedAt).not.toBeNull();
    const actions = await actionsOf(attempt.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'AUTO_PAUSE', staffId: null, reason: '시스템 자동 일시정지(위반 5회)' });
  });

  it('(c) 동시에 도착한 위반 6건: 카운트 5(6번째는 이미 PAUSED라 미카운트, SPEC 5.7), AUTO_PAUSE 정확히 1건, 6건 모두 저장', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    const acks = await Promise.all(Array.from({ length: 6 }, () => send(stu, sig('FULLSCREEN_EXIT'))));
    expect(acks.every((a) => a.ok)).toBe(true);
    const row = await reload(attempt.id);
    // 5번째가 커밋되면 응시는 PAUSED다. 6번째는 PAUSED에서 처리되므로 저장만 되고 세지 않는다(카운트 유실 없음: 정확히 5).
    expect(row.violationCount).toBe(5);
    expect(row.state).toBe('PAUSED');
    expect(await actionsOf(attempt.id)).toHaveLength(1);
    const list = await signalsOf(attempt.id);
    expect(list.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // 시각은 잠금 뒤에 정하므로 처리 순서(= seq 순서)와 receivedAt 순서가 같다.
    const times = list.map((x) => x.receivedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('(c2) 여러 소켓·서비스 호출이 같은 응시를 동시에 만져도 카운트·AUTO_PAUSE가 어긋나지 않는다(서버 신호·하트비트 포함)', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx, { violationCount: 3 });
    const a = await studentSocket(token);
    const b = await studentSocket(token);
    // 같은 seq를 두 소켓이 동시에: 한 건만 저장
    const [r1, r2] = await Promise.all([send(a, sig('FULLSCREEN_EXIT', {}, 1)), send(b, sig('FULLSCREEN_EXIT', {}, 1))]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    await Promise.all([
      send(a, sig('PASTE', { meta: { length: 3, blocked: false } }, 2)),
      recordServerSignal(attempt.id, 'DISCONNECT', {}, () => new Date()),
      recordHeartbeat(attempt.id, 1, () => new Date(), hashToken(token)),
    ]);
    const row = await reload(attempt.id);
    expect(row.violationCount).toBe(5); // 3 + FULLSCREEN_EXIT 1건 + PASTE 1건
    expect(row.state).toBe('PAUSED');
    expect(await actionsOf(attempt.id)).toHaveLength(1);
    expect((await signalsOf(attempt.id)).filter((x) => x.seq === 1)).toHaveLength(1);
  });

  it('감독관 조치(시험 행 → 응시 행 잠금)와 자동 잠금이 동시에 같은 응시를 만져도 교착 없이 끝난다', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx, { violationCount: 4 });
    const stu = await studentSocket(token);
    const manual = runExamTx(async (tx) => {
      await lockExam(tx, fx.exam.id); // actions.ts와 같은 순서: 시험 → 응시
      await tx.$queryRaw`SELECT "id" FROM "Attempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
      await sleep(150);
      await tx.attempt.update({ where: { id: attempt.id }, data: { unackedSeverity: 'NONE' } });
    });
    await sleep(30);
    const [res] = await Promise.all([send(stu, sig('DROP', { meta: { length: 1, blocked: true } })), manual]);
    expect(res.ok).toBe(true);
    const row = await reload(attempt.id);
    expect(row).toMatchObject({ violationCount: 5, state: 'PAUSED' });
    expect(await actionsOf(attempt.id)).toHaveLength(1);
  });

  it('(d) PAUSED의 PASTE는 저장되지만 카운트되지 않고, 종착 상태는 NOT_ACTIVE로 거부·미저장', async () => {
    const fx = await fixture();
    const paused = await makeAttempt(fx, { state: 'PAUSED', index: 0 });
    const waiting = await makeAttempt(fx, { state: 'WAITING', index: 1 });
    const done = await makeAttempt(fx, { state: 'SUBMITTED', index: 2 });
    const sp = await studentSocket(paused.token);
    expect(await send(sp, sig('PASTE', { meta: { length: 5, blocked: false } }, 1))).toEqual({ ok: true });
    expect(await signalsOf(paused.attempt.id)).toHaveLength(1);
    expect((await reload(paused.attempt.id)).violationCount).toBe(0);
    const sw = await studentSocket(waiting.token);
    expect(await send(sw, sig('FULLSCREEN_EXIT', {}, 1))).toEqual({ ok: true });
    expect(await signalsOf(waiting.attempt.id)).toHaveLength(1);
    expect((await reload(waiting.attempt.id)).violationCount).toBe(0);
    const sd = await studentSocket(done.token);
    expect(await send(sd, sig('FULLSCREEN_EXIT', {}, 1))).toEqual({ ok: false, code: 'NOT_ACTIVE' });
    expect(await signalsOf(done.attempt.id)).toHaveLength(0);
    for (const state of ['TERMINATED', 'REJECTED'] as const) {
      const f2 = await fixture();
      const x = await makeAttempt(f2, { state });
      expect(await recordClientSignal(x.attempt.id, hashToken(x.token), sig('PASTE', {}, 1), new Date())).toEqual({ ok: false, code: 'NOT_ACTIVE' });
      expect(await signalsOf(x.attempt.id)).toHaveLength(0);
    }
  });

  it('(e) 2초 LEAVE는 INFO·미카운트, 3초 LEAVE는 카운트', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    await send(stu, sig('LEAVE', { durationMs: 2000, meta: { cause: 'blur' } }));
    let row = await reload(attempt.id);
    expect(row.violationCount).toBe(0);
    expect(row.unackedSeverity).toBe('INFO');
    expect((await signalsOf(attempt.id))[0]!.severity).toBe('INFO');
    await send(stu, sig('LEAVE', { durationMs: 3000, meta: { cause: 'blur' } }));
    row = await reload(attempt.id);
    expect(row.violationCount).toBe(1);
    expect(row.unackedSeverity).toBe('WARN');
    await send(stu, sig('LEAVE', { durationMs: 15_001, meta: { cause: 'hidden' } }));
    expect((await reload(attempt.id)).unackedSeverity).toBe('ALERT');
  });
});

describe('seq 처리', () => {
  it('(f) 같은 seq 재전송은 ok 무시, 낮은 seq도 무시, lastSeq+2면 SEQ_GAP', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    expect(await send(stu, sig('FULLSCREEN_EXIT', {}, 1))).toEqual({ ok: true });
    expect(await send(stu, sig('FULLSCREEN_EXIT', {}, 1))).toEqual({ ok: true });
    expect(await signalsOf(attempt.id)).toHaveLength(1);
    expect((await reload(attempt.id)).violationCount).toBe(1);
    expect(await send(stu, sig('LEAVE_START', {}, 2))).toEqual({ ok: true });
    expect(await send(stu, sig('FULLSCREEN_EXIT', {}, 1))).toEqual({ ok: true }); // 낮은 seq
    expect(await signalsOf(attempt.id)).toHaveLength(2);
    expect(await send(stu, sig('LEAVE_START', {}, 4))).toEqual({ ok: true }); // lastSeq 2 → 기대 3
    const list = await signalsOf(attempt.id);
    const gap = list.filter((x) => x.type === 'SEQ_GAP');
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ severity: 'WARN', seq: null, meta: { expected: 3, got: 4 } });
    const row = await reload(attempt.id);
    expect(row).toMatchObject({ lastSeq: 4, violationCount: 1 });
  });

  it('하트비트: lastHeartbeatAt·lastSeq 갱신, 신호와 같은 seq 카운터, 빈틈은 SEQ_GAP, 되돌리지 않는다', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    stu.emit(EV.HEARTBEAT, { seq: 1 });
    stu.emit(EV.HEARTBEAT, { seq: 2 });
    await send(stu, sig('LEAVE_START', {}, 3));
    let row = await reload(attempt.id);
    expect(row.lastSeq).toBe(3);
    expect(row.lastHeartbeatAt).not.toBeNull();
    expect((await signalsOf(attempt.id)).map((x) => x.type)).toEqual(['LEAVE_START']);
    stu.emit(EV.HEARTBEAT, { seq: 6 });
    await sleep(500);
    row = await reload(attempt.id);
    expect(row.lastSeq).toBe(6);
    expect((await signalsOf(attempt.id)).filter((x) => x.type === 'SEQ_GAP')).toHaveLength(1);
    stu.emit(EV.HEARTBEAT, { seq: 2 });
    stu.emit(EV.HEARTBEAT, { seq: 'x' });
    stu.emit(EV.HEARTBEAT, { seq: 7, extra: 1 });
    await sleep(500);
    expect((await reload(attempt.id)).lastSeq).toBe(6);
  });

  it('(g) LEAVE_START 뒤 LEAVE에 meta.serverDurationMs가 저장되고, 클라이언트가 보낸 같은 이름의 값은 버려진다', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    await send(stu, sig('LEAVE_START'));
    await sleep(300);
    await send(stu, sig('LEAVE', { durationMs: 250, meta: { cause: 'blur', serverDurationMs: 1 } }));
    const leave = (await signalsOf(attempt.id)).find((x) => x.type === 'LEAVE')!;
    const m = leave.meta as { serverDurationMs: number; cause: string };
    expect(m.cause).toBe('blur');
    expect(m.serverDurationMs).toBeGreaterThanOrEqual(250);
    expect(m.serverDurationMs).toBeLessThan(5000);
    // 이미 닫힌 이탈 뒤에 LEAVE_START 없이 온 LEAVE에는 서버 값이 없고 위조 값도 없다
    await send(stu, sig('LEAVE', { durationMs: 100, meta: { serverDurationMs: 99999 } }));
    const second = (await signalsOf(attempt.id)).filter((x) => x.type === 'LEAVE')[1]!;
    expect(second.meta).toEqual({});
  });
});

describe('위조 거부와 세션', () => {
  it('(h) 엄격 검증: 알 수 없는 type·서버 전용 type·키·meta 크기·durationMs·다른 시험 questionId는 INVALID이고 저장되지 않는다', async () => {
    const fx = await fixture();
    const other = await makeExam();
    const otherQ = await prisma.question.findFirstOrThrow({ where: { examId: other.id } });
    // 위조 페이로드가 31개라 한 응시에 몰아 보내면 속도 제한(버스트 30)에 걸린다. 응시·소켓마다 버킷이 따로이므로 16개씩 나눠 서로 다른 응시로 보낸다(시계에 의존하지 않는다).
    const first = await makeAttempt(fx, { index: 0 });
    const second = await makeAttempt(fx, { index: 1 });
    const { attempt, token } = first;
    const stu = await studentSocket(token);
    const bad: unknown[] = [
      sig('NOPE'),
      sig('DISCONNECT'),
      sig('SEQ_GAP'),
      sig('MULTI_MONITOR'),
      sig('RECONNECT'),
      sig('HEARTBEAT_GAP'),
      sig('FULLSCREEN_EXIT', { extra: 1 }),
      sig('FULLSCREEN_EXIT', { attemptId: 'other' }),
      sig('FULLSCREEN_EXIT', { severity: 'INFO' }),
      sig('FULLSCREEN_EXIT', { meta: { blob: 'x'.repeat(2100) } }),
      sig('FULLSCREEN_EXIT', { meta: 'str' }),
      sig('FULLSCREEN_EXIT', { meta: [] }),
      sig('FULLSCREEN_EXIT', { meta: { s: '\u0000' } }),
      sig('FULLSCREEN_EXIT', { meta: { s: '\ud800' } }),
      sig('LEAVE', { durationMs: -1 }),
      sig('LEAVE', { durationMs: 3_600_001 }),
      sig('LEAVE', { durationMs: 1.5 }),
      sig('LEAVE', { durationMs: '3000' }),
      sig('LEAVE'),
      sig('FULLSCREEN_EXIT', { questionId: otherQ.id }),
      sig('FULLSCREEN_EXIT', { questionId: 'no such question' }),
      sig('FULLSCREEN_EXIT', { clientAt: 'now' }),
      sig('FULLSCREEN_EXIT', { clientAt: 1e20 }),
      { type: 'FULLSCREEN_EXIT' },
      sig('FULLSCREEN_EXIT', {}, 0),
      sig('FULLSCREEN_EXIT', {}, -3),
      sig('FULLSCREEN_EXIT', {}, 1.5),
      sig('FULLSCREEN_EXIT', {}, 2 ** 31),
      'text',
      null,
      [],
    ];
    const half = Math.ceil(bad.length / 2);
    const secondSocket = await studentSocket(second.token);
    for (const [i, payload] of bad.entries()) {
      const res = await send(i < half ? stu : secondSocket, payload);
      expect(res, JSON.stringify(payload).slice(0, 80)).toEqual({ ok: false, code: 'INVALID' });
    }
    expect(await signalsOf(attempt.id)).toHaveLength(0);
    expect(await signalsOf(second.attempt.id)).toHaveLength(0);
    expect(await reload(attempt.id)).toMatchObject({ lastSeq: 0, violationCount: 0 });
    // 경계값은 통과: meta 2KB 이내, durationMs 3_600_000
    expect((await send(stu, sig('LEAVE', { durationMs: 3_600_000 }, 1))).ok).toBe(true);
    expect((await send(stu, sig('PASTE', { meta: { blob: 'x'.repeat(2000) } }, 2))).ok).toBe(true);
  });

  it('parseClientSignal: 프로토타입이 다른 객체·너무 깊은 meta는 거부한다', () => {
    expect(parseClientSignal(Object.assign(Object.create({ evil: 1 }) as object, sig('PASTE')))).toBeNull();
    expect(parseClientSignal(sig('PASTE', { meta: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }))).toBeNull();
    expect(parseClientSignal(sig('PASTE', { meta: { a: { b: 1 } } }))).not.toBeNull();
  });

  it('교수자 소켓의 signal은 UNAUTHORIZED이고 학생 소켓은 다른 응시를 지정할 수 없다', async () => {
    const fx = await fixture();
    const a = await makeAttempt(fx, { index: 0 });
    const b = await makeAttempt(fx, { index: 1 });
    const staff = await staffSocket(fx);
    expect(await send(staff, sig('FULLSCREEN_EXIT'))).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    const sb = await studentSocket(b.token);
    expect((await send(sb, sig('FULLSCREEN_EXIT', { attemptId: a.attempt.id }, 1))).code).toBe('INVALID');
    expect((await send(sb, sig('FULLSCREEN_EXIT', {}, 1))).ok).toBe(true);
    expect(await signalsOf(a.attempt.id)).toHaveLength(0);
    expect(await signalsOf(b.attempt.id)).toHaveLength(1);
    // 서비스를 직접 불러도 다른 응시의 토큰 해시로는 쓸 수 없다
    expect(await recordClientSignal(a.attempt.id, hashToken(b.token), sig('PASTE'), new Date())).toEqual({ ok: false, code: 'NOT_ACTIVE', revoked: true });
    expect(await signalsOf(a.attempt.id)).toHaveLength(0);
  });

  it('(i) 폐기된 세션 토큰은 NOT_ACTIVE 이고 연결이 끊기며 아무것도 저장되지 않는다(hb도 연결 종료)', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    const hb = await studentSocket(token);
    await prisma.attempt.update({ where: { id: attempt.id }, data: { sessionTokenHash: hashToken(generateToken()) } });
    const closed = once(stu, 'disconnect', 5000);
    expect(await send(stu, sig('FULLSCREEN_EXIT'))).toEqual({ ok: false, code: 'NOT_ACTIVE' });
    await closed;
    const closedHb = once(hb, 'disconnect', 5000);
    hb.emit(EV.HEARTBEAT, { seq: 1 });
    await closedHb;
    expect(await signalsOf(attempt.id)).toHaveLength(0);
    expect((await reload(attempt.id)).lastHeartbeatAt).toBeNull();
  });
});

describe('속도 제한과 연결 상태', () => {
  it('signal 버스트 30 초과는 BUSY, answer:save 한도와 별개', async () => {
    const fx = await fixture();
    const { token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    const acks = await Promise.all(Array.from({ length: 50 }, (_, i) => send(stu, sig('LEAVE_START', {}, i + 1))));
    const ok = acks.filter((a) => a.ok).length;
    const busy = acks.filter((a) => a.code === 'BUSY').length;
    expect(ok + busy).toBe(50);
    // 상한값은 시계(리필)에 따라 달라지므로 시계와 무관한 하한만 단언한다: 버스트 30은 반드시 통과하고, 50건을 한꺼번에 보내면 일부는 BUSY다.
    expect(ok).toBeGreaterThanOrEqual(30);
    expect(busy).toBeGreaterThanOrEqual(1);
    const q = await prisma.question.findFirstOrThrow({ where: { examId: fx.exam.id, type: 'ESSAY' } });
    const saved = (await stu.timeout(5000).emitWithAck(EV.ANSWER_SAVE, { questionId: q.id, text: 'x', rev: 1 })) as Ack;
    expect(saved.ok).toBe(true);
  });

  it('연결 직후 attempt:state에 locked가 실린다: AUTO_PAUSE 뒤 true, 감독관 PAUSE 뒤 false, ACTIVE는 false', async () => {
    const fx = await fixture();
    const auto = await makeAttempt(fx, { state: 'PAUSED', index: 0 });
    await prisma.proctorAction.create({ data: { attemptId: auto.attempt.id, staffId: null, type: 'AUTO_PAUSE', reason: '시스템 자동 일시정지(위반 5회)' } });
    const manual = await makeAttempt(fx, { state: 'PAUSED', index: 1 });
    await prisma.proctorAction.create({ data: { attemptId: manual.attempt.id, staffId: fx.staffId, type: 'PAUSE', reason: '확인' } });
    const active = await makeAttempt(fx, { state: 'ACTIVE', index: 2 });
    for (const [t, expected, state] of [[auto.token, true, 'PAUSED'], [manual.token, false, 'PAUSED'], [active.token, false, 'ACTIVE']] as const) {
      const s = open({ auth: { sessionToken: t } });
      const st = await once<{ state: string; locked: boolean }>(s, EV.ATTEMPT_STATE);
      expect(st).toMatchObject({ state, locked: expected });
    }
  });

  it('recordServerSignal: 종착 응시는 무시, 진행 중이면 seq 없이 저장하고 카드 위험도를 올린다', async () => {
    const fx = await fixture();
    const a = await makeAttempt(fx, { index: 0 });
    const done = await makeAttempt(fx, { state: 'SUBMITTED', index: 1 });
    await recordServerSignal(a.attempt.id, 'RECONNECT', { offlineMs: 4000 }, new Date());
    await recordServerSignal(a.attempt.id, 'DISCONNECT', {}, new Date());
    await recordServerSignal(done.attempt.id, 'DISCONNECT', {}, new Date());
    const list = await signalsOf(a.attempt.id);
    expect(list.map((x) => [x.type, x.severity, x.seq])).toEqual([['RECONNECT', 'INFO', null], ['DISCONNECT', 'WARN', null]]);
    expect((await reload(a.attempt.id)).unackedSeverity).toBe('WARN');
    expect(await signalsOf(done.attempt.id)).toHaveLength(0);
  });
});

describe('PR #94 리뷰 반영', () => {
  it('[high] 기기 교체 승인 뒤 새 기기는 seq 1부터 저장·카운트되고 옛 토큰은 NOT_ACTIVE', async () => {
    const fx = await fixture();
    const { attempt, token: oldToken } = await makeAttempt(fx, { lastSeq: 300 });
    const newToken = generateToken();
    await prisma.attempt.update({ where: { id: attempt.id }, data: { pendingTokenHash: hashToken(newToken) } });
    await resolveApproval({ attemptId: attempt.id, staffId: fx.staffId, type: 'APPROVE_SESSION', reason: '기기 교체' });
    expect((await reload(attempt.id)).lastSeq).toBe(0);
    const fresh = await studentSocket(newToken);
    expect(await send(fresh, sig('FULLSCREEN_EXIT', {}, 1))).toEqual({ ok: true });
    expect(await reload(attempt.id)).toMatchObject({ lastSeq: 1, violationCount: 1 });
    expect(await signalsOf(attempt.id)).toHaveLength(1);
    expect(await recordClientSignal(attempt.id, hashToken(oldToken), sig('FULLSCREEN_EXIT', {}, 2), new Date())).toEqual({ ok: false, code: 'NOT_ACTIVE', revoked: true });
  });

  it('[medium] 응시당 저장 상한: 초과한 일반 신호는 ok지만 저장하지 않고 seq만 처리, 위반은 계속 카운트·저장', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    await prisma.signal.createMany({
      data: Array.from({ length: MAX_CLIENT_SIGNALS_PER_ATTEMPT }, (_, i) => ({ attemptId: attempt.id, type: 'LEAVE_START' as const, severity: 'WARN' as const, seq: i + 1 })),
    });
    await prisma.attempt.update({ where: { id: attempt.id }, data: { lastSeq: MAX_CLIENT_SIGNALS_PER_ATTEMPT } });
    const stu = await studentSocket(token);
    const n = MAX_CLIENT_SIGNALS_PER_ATTEMPT;
    expect(await send(stu, sig('LEAVE_START', {}, n + 1))).toEqual({ ok: true });
    expect(await send(stu, sig('PASTE', {}, n + 5))).toEqual({ ok: true }); // ACTIVE의 PASTE는 위반이라 상한과 무관
    expect(await prisma.signal.count({ where: { attemptId: attempt.id } })).toBe(n + 2); // PASTE 1건 + 위반 처리 중 생긴 SEQ_GAP 1건(일반 신호는 SEQ_GAP도 남기지 않는다)
    expect(await reload(attempt.id)).toMatchObject({ lastSeq: n + 5, violationCount: 1 });
    // 상한 초과 뒤에도 seq는 진행하므로 같은 seq 재전송은 무시된다
    expect(await send(stu, sig('LEAVE_START', {}, n + 2))).toEqual({ ok: true });
    expect(await prisma.signal.count({ where: { attemptId: attempt.id } })).toBe(n + 2);
    for (let i = 0; i < 4; i++) await send(stu, sig('FULLSCREEN_EXIT', {}, n + 6 + i));
    expect(await reload(attempt.id)).toMatchObject({ violationCount: 5, state: 'PAUSED' });
    expect(await actionsOf(attempt.id)).toHaveLength(1);
  });

  it('[medium] 속도 제한은 응시 단위: 소켓 3개를 써도 합쳐서 버스트 30', async () => {
    const fx = await fixture();
    const { token } = await makeAttempt(fx);
    const socks = await Promise.all([studentSocket(token), studentSocket(token), studentSocket(token)]);
    const acks = await Promise.all(socks.flatMap((s, k) => Array.from({ length: 20 }, (_, i) => send(s, sig('LEAVE_START', {}, k * 20 + i + 1)))));
    const ok = acks.filter((a) => a.ok).length;
    expect(ok + acks.filter((a) => a.code === 'BUSY').length).toBe(60);
    // 소켓 하나는 20건뿐이라 소켓 버킷만으로는 BUSY가 나지 않는다. BUSY가 있으면 응시 단위 버킷이 작동한 것이다(시계 의존 상한은 단언하지 않는다).
    expect(ok).toBeGreaterThanOrEqual(30);
    expect(acks.filter((a) => a.code === 'BUSY').length).toBeGreaterThanOrEqual(1);
  });

  it('[low] 자동 잠금은 5의 배수에서만: RESUME 뒤 6번째는 ACTIVE 유지, 10번째에서 다시 잠금(AUTO_PAUSE 2건)', async () => {
    const fx = await fixture();
    const { attempt, token } = await makeAttempt(fx);
    const stu = await studentSocket(token);
    let seq = 0;
    for (let i = 0; i < 5; i++) await send(stu, sig('FULLSCREEN_EXIT', {}, ++seq));
    expect((await reload(attempt.id)).state).toBe('PAUSED');
    await prisma.attempt.update({ where: { id: attempt.id }, data: { state: 'ACTIVE', pausedAt: null } }); // 감독관 RESUME 상당
    await send(stu, sig('FULLSCREEN_EXIT', {}, ++seq));
    expect(await reload(attempt.id)).toMatchObject({ violationCount: 6, state: 'ACTIVE' });
    for (let i = 0; i < 3; i++) await send(stu, sig('FULLSCREEN_EXIT', {}, ++seq));
    expect(await reload(attempt.id)).toMatchObject({ violationCount: 9, state: 'ACTIVE' });
    await send(stu, sig('FULLSCREEN_EXIT', {}, ++seq));
    expect(await reload(attempt.id)).toMatchObject({ violationCount: 10, state: 'PAUSED' });
    expect((await actionsOf(attempt.id)).map((a) => a.reason).sort()).toEqual(['시스템 자동 일시정지(위반 10회)', '시스템 자동 일시정지(위반 5회)']);
  });

  it('[low] 형식 오류는 대기열을 기다리지 않고 즉시 INVALID, 대기 상한을 넘으면 BUSY', async () => {
    const sv = await startTestServer({ maxPendingPerSocket: 1 });
    try {
      const fx = await fixture();
      const { attempt, token } = await makeAttempt(fx);
      const s = connect(sv.url, { auth: { sessionToken: token }, transports: ['polling'], reconnection: false, forceNew: true });
      sockets.push(s);
      await once(s, EV.ATTEMPT_STATE);
      // 응시 행을 잡아 첫 신호를 DB에서 붙잡아 둔다.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Attempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
        await gate;
      });
      await sleep(200);
      const first = send(s, sig('LEAVE_START', {}, 1)); // 처리 중(대기 1)
      await sleep(200);
      expect(await send(s, sig('NOPE', {}, 2))).toEqual({ ok: false, code: 'INVALID' }); // 막힌 대기열과 무관하게 즉시
      expect(await send(s, sig('LEAVE_START', {}, 3))).toEqual({ ok: false, code: 'BUSY' });
      release();
      await holder;
      expect(await first).toEqual({ ok: true });
    } finally {
      await sv.close();
    }
  });
});
