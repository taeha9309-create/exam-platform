import { DISCONNECT_GRACE_MS, EV, HEARTBEAT_GAP_MS } from '@exam/shared';
import type { AttemptState, Exam } from '@prisma/client';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { checkConnections, startConnectionMonitor, studentSocketConnected, studentSocketDisconnected } from '../src/jobs/connectionMonitor';
import { loadDashboardSnapshot, loadNetworkIncident } from '../src/services/dashboard';
import { MAX_CLIENT_SIGNALS_PER_ATTEMPT, recordHeartbeat } from '../src/services/signals';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

/**
 * 연결 감시(SPEC 5.5, F-13). 점검은 가짜 시계(t)로 직접 돌리고, 감시기 타이머는 아주 긴 간격으로 둬서 끼어들지 못하게 한다.
 * 소켓 연결·끊김은 장부 함수를 직접 불러 흉내 낸다(실제 소켓 연결은 마지막 describe에서 따로 확인한다).
 */

vi.setConfig({ testTimeout: 30_000 });
let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];
let t = 0;
let monitor: { stop(): Promise<void> };

beforeAll(async () => {
  server = await startTestServer();
  await Promise.all(Array.from({ length: 8 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
}, 60_000);
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDb();
  t = Date.now();
  monitor = startConnectionMonitor({ intervalMs: 3_600_000, now: () => new Date(t) });
});
afterEach(async () => {
  await monitor.stop();
  for (const s of sockets.splice(0)) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const once = <T = unknown>(s: Socket, ev: string, ms = 8000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
const check = () => checkConnections(t);
const advance = (ms: number) => void (t += ms);

async function fixture(extraRoster = 0): Promise<{ exam: Exam; staffId: string }> {
  const staff = await makeStaff();
  const exam = await makeExam({ ownerId: staff.id, status: 'RUNNING', startedAt: new Date(t), endsAt: new Date(t + 3_600_000) });
  if (extraRoster > 0) {
    await prisma.rosterEntry.createMany({ data: Array.from({ length: extraRoster }, (_, i) => ({ examId: exam.id, studentNo: `2026${String(100 + i).padStart(4, '0')}`, name: `추가${i}` })) });
  }
  return { exam, staffId: staff.id };
}
/** 응시를 만든다. 하트비트는 가짜 시계의 지금으로 둔다(하트비트 갭이 끼어들지 않게). */
async function makeAttempts(exam: Exam, n: number, state: AttemptState = 'ACTIVE') {
  const roster = await prisma.rosterEntry.findMany({ where: { examId: exam.id }, orderBy: { studentNo: 'asc' } });
  const out: { id: string; token: string }[] = [];
  for (const r of roster.slice(0, n)) {
    const token = generateToken();
    const a = await prisma.attempt.create({
      data: { examId: exam.id, rosterEntryId: r.id, state, sessionTokenHash: hashToken(token), questionOrder: [], choiceOrders: {}, consentAt: new Date(), envCheckedAt: new Date(), lastHeartbeatAt: new Date(t) },
    });
    out.push({ id: a.id, token });
  }
  return out;
}
const signalsOf = (attemptId: string, type?: string) =>
  prisma.signal.findMany({ where: { attemptId, ...(type ? { type: type as 'DISCONNECT' } : {}) }, orderBy: { receivedAt: 'asc' } });
const stateOf = (id: string) => prisma.attempt.findUniqueOrThrow({ where: { id }, select: { unackedSeverity: true, violationCount: true } });
const beat = (id: string) => prisma.attempt.update({ where: { id }, data: { lastHeartbeatAt: new Date(t) } });

async function staffListener(fx: { exam: Exam; staffId: string }): Promise<{ got: unknown[]; socket: Socket }> {
  const s = connect(server.url, { extraHeaders: { Cookie: staffCookie(fx.staffId) }, transports: ['polling'], reconnection: false, forceNew: true });
  sockets.push(s);
  await once(s, 'connect');
  const snap = once(s, EV.DASHBOARD_SNAPSHOT);
  await s.timeout(4000).emitWithAck(EV.DASHBOARD_JOIN, { examId: fx.exam.id });
  await snap;
  const got: unknown[] = [];
  s.on(EV.NETWORK_INCIDENT, (v: unknown) => got.push(v));
  return { got, socket: s };
}

describe('(a) 끊김 유예와 RECONNECT', () => {
  it('유예(10초) 안에 돌아오면 DISCONNECT 없이 RECONNECT만 남는다', async () => {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    await studentSocketConnected(a!.id);
    studentSocketDisconnected(a!.id);
    advance(DISCONNECT_GRACE_MS - 1000);
    await check();
    expect(await signalsOf(a!.id, 'DISCONNECT')).toHaveLength(0);
    await studentSocketConnected(a!.id);
    const re = await signalsOf(a!.id, 'RECONNECT');
    expect(re).toHaveLength(1);
    expect((re[0]!.meta as { offlineMs: number }).offlineMs).toBe(DISCONNECT_GRACE_MS - 1000);
    advance(60_000);
    await beat(a!.id);
    await check();
    expect(await signalsOf(a!.id, 'DISCONNECT')).toHaveLength(0);
  });

  it('유예를 넘기면 DISCONNECT 1건(점검을 반복해도 중복 없음), 돌아오면 RECONNECT', async () => {
    // 응시가 1~3명뿐이면 1명이 30%를 넘어 장애 묶음이 되므로(SPEC 5.5) 10명 중 1명이 끊기는 상황으로 만든다.
    const fx = await fixture(7);
    const [a, ...others] = await makeAttempts(fx.exam, 10);
    for (const o of others) await studentSocketConnected(o.id);
    await studentSocketConnected(a!.id);
    studentSocketDisconnected(a!.id);
    advance(DISCONNECT_GRACE_MS + 1000);
    for (const o of others) await beat(o.id);
    await check();
    for (let i = 0; i < 2; i++) {
      advance(1000);
      for (const o of others) await beat(o.id);
      await check();
    }
    const dis = await signalsOf(a!.id, 'DISCONNECT');
    expect(dis).toHaveLength(1);
    expect(dis[0]!.severity).toBe('WARN');
    expect((await stateOf(a!.id)).unackedSeverity).toBe('WARN'); // 혼자 끊긴 것은 카드 색에 반영
    expect((await stateOf(a!.id)).violationCount).toBe(0);
    await studentSocketConnected(a!.id);
    expect(await signalsOf(a!.id, 'RECONNECT')).toHaveLength(1);
  });
});

describe('(b) 하트비트 갭', () => {
  it('15초 끊기면 1건, 갭이 이어져도 중복 없음, 하트비트가 돌아오면 다음 갭을 다시 기록, 위반 수는 그대로', async () => {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    await studentSocketConnected(a!.id);
    advance(HEARTBEAT_GAP_MS - 1000);
    await check();
    expect(await signalsOf(a!.id, 'HEARTBEAT_GAP')).toHaveLength(0);
    advance(1000);
    await check();
    advance(3000);
    await check();
    advance(3000);
    await check();
    expect(await signalsOf(a!.id, 'HEARTBEAT_GAP')).toHaveLength(1);
    expect((await stateOf(a!.id)).violationCount).toBe(0);

    await beat(a!.id); // 하트비트가 돌아왔다
    await check();
    expect(await signalsOf(a!.id, 'HEARTBEAT_GAP')).toHaveLength(1);
    advance(HEARTBEAT_GAP_MS + 1000);
    await check();
    expect(await signalsOf(a!.id, 'HEARTBEAT_GAP')).toHaveLength(2);
  });
});

describe('(c) 네트워크 장애 묶음', () => {
  it('3명이 함께 끊기면 network:incident, severity는 올리지 않고 Signal은 저장, 시간이 지나면 null', async () => {
    const fx = await fixture();
    const list = await makeAttempts(fx.exam, 3);
    const staff = await staffListener(fx);
    for (const a of list) {
      await studentSocketConnected(a.id);
      studentSocketDisconnected(a.id);
    }
    advance(DISCONNECT_GRACE_MS + 1000);
    await check();
    await sleep(200);

    for (const a of list) {
      expect(await signalsOf(a.id, 'DISCONNECT')).toHaveLength(1); // 저장은 된다
      expect((await stateOf(a.id)).unackedSeverity).toBe('NONE'); // 카드 색은 그대로
    }
    expect(staff.got).toHaveLength(1);
    const incident = staff.got[0] as { count: number; attemptIds: string[]; since: number };
    expect(incident.count).toBe(3);
    expect([...incident.attemptIds].sort()).toEqual(list.map((a) => a.id).sort());
    expect(await loadNetworkIncident(fx.exam.id, new Date(t))).toMatchObject({ count: 3 });

    // 같은 상태로 다시 점검해도 같은 알림을 반복하지 않는다.
    advance(1000);
    await check();
    await sleep(100);
    expect(staff.got).toHaveLength(1);

    // 10초가 지나 윈도우를 벗어나면 해제(null)
    advance(11_000);
    await check();
    await sleep(200);
    expect(staff.got).toHaveLength(2);
    expect(staff.got[1]).toBeNull();
    expect(await loadNetworkIncident(fx.exam.id, new Date(t))).toBeNull();
  });

  it('장애가 끝난 뒤 혼자 끊긴 응시는 다시 카드 색에 반영된다', async () => {
    const fx = await fixture(7);
    const all = await makeAttempts(fx.exam, 10);
    const list = all.slice(0, 3);
    for (const a of all) await studentSocketConnected(a.id);
    for (const a of list) studentSocketDisconnected(a.id);
    advance(DISCONNECT_GRACE_MS + 1000);
    for (const a of all.slice(3)) await beat(a.id);
    await check();
    await studentSocketConnected(list[0]!.id);
    advance(60_000);
    for (const a of all) await beat(a.id);
    studentSocketDisconnected(list[0]!.id);
    advance(DISCONNECT_GRACE_MS + 1000);
    for (const a of all.slice(1)) await beat(a.id);
    await check();
    expect((await stateOf(list[0]!.id)).unackedSeverity).toBe('WARN');
  });

  it('스냅샷의 networkIncident는 최근 네트워크 신호 기준이라 재접속한 교수자도 배너를 받는다', async () => {
    const fx = await fixture();
    const list = await makeAttempts(fx.exam, 3);
    for (const a of list) await prisma.signal.create({ data: { attemptId: a.id, type: 'DISCONNECT', severity: 'WARN' } });
    const snap = await loadDashboardSnapshot(fx.exam.id);
    expect(snap!.networkIncident).toMatchObject({ count: 3 });
    await prisma.signal.deleteMany({});
    expect((await loadDashboardSnapshot(fx.exam.id))!.networkIncident).toBeNull();
  });
});

describe('(d) 응시 20명 중 2명만 끊기면 장애가 아니다', () => {
  it('network:incident 없음, 카드 색 반영', async () => {
    const fx = await fixture(17);
    const list = await makeAttempts(fx.exam, 20);
    expect(list).toHaveLength(20);
    const staff = await staffListener(fx);
    for (const a of list) await studentSocketConnected(a.id);
    studentSocketDisconnected(list[0]!.id);
    studentSocketDisconnected(list[1]!.id);
    advance(DISCONNECT_GRACE_MS + 1000);
    for (const a of list) await beat(a.id);
    await check();
    await sleep(200);
    expect(staff.got).toHaveLength(0);
    expect((await stateOf(list[0]!.id)).unackedSeverity).toBe('WARN');
    expect((await stateOf(list[1]!.id)).unackedSeverity).toBe('WARN');
    expect(await signalsOf(list[2]!.id, 'DISCONNECT')).toHaveLength(0);
  });
});

describe('(e) 종료·제출된 응시는 감시 대상이 아니다', () => {
  it('SUBMITTED·TERMINATED 응시와 끊긴 뒤 제출된 응시에는 신호가 남지 않는다', async () => {
    const fx = await fixture();
    await makeAttempts(fx.exam, 1, 'SUBMITTED'); // 첫 명단 학생: 이미 제출됨(소켓 없음)
    const roster = await prisma.rosterEntry.findMany({ where: { examId: fx.exam.id }, orderBy: { studentNo: 'asc' } });
    const mk = async (i: number, state: AttemptState) =>
      (await prisma.attempt.create({ data: { examId: fx.exam.id, rosterEntryId: roster[i]!.id, state, sessionTokenHash: hashToken(generateToken()), questionOrder: [], choiceOrders: {}, lastHeartbeatAt: new Date(t) } })).id;
    await mk(1, 'TERMINATED');
    const willSubmit = await mk(2, 'ACTIVE');
    await studentSocketConnected(willSubmit);
    studentSocketDisconnected(willSubmit);
    await prisma.attempt.update({ where: { id: willSubmit }, data: { state: 'SUBMITTED' } });
    advance(DISCONNECT_GRACE_MS + HEARTBEAT_GAP_MS + 1000);
    await check();
    await check();
    expect(await prisma.signal.count()).toBe(0);
  });
});

describe('재시작 직후 유예', () => {
  it('장부에 없는 진행 중 응시는 처음 본 시각부터 유예를 센다(첫 점검에서 DISCONNECT 하지 않는다)', async () => {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    await check(); // 처음 본다
    advance(DISCONNECT_GRACE_MS - 1000);
    await check();
    expect(await signalsOf(a!.id, 'DISCONNECT')).toHaveLength(0);
    advance(1000);
    await check();
    expect(await signalsOf(a!.id, 'DISCONNECT')).toHaveLength(1);
  });

  it('유예 안에 소켓이 붙으면 아무 신호도 없고, 이후 정상 연결로 취급한다', async () => {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    await check();
    advance(3000);
    await studentSocketConnected(a!.id);
    await beat(a!.id);
    advance(DISCONNECT_GRACE_MS * 3);
    await beat(a!.id);
    await check();
    expect(await prisma.signal.count()).toBe(0);
  });
});

describe('(f) stop과 겹침 방지', () => {
  it('stop()은 진행 중 점검이 끝나기를 기다리고, 점검은 겹쳐 실행되지 않으며, 멈춘 뒤에는 더 돌지 않는다', async () => {
    await monitor.stop();
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    let finished = 0;
    monitor = startConnectionMonitor({
      intervalMs: 5,
      now: () => new Date(t),
      check: async () => {
        calls += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(80);
        running -= 1;
        finished += 1;
      },
    });
    await sleep(30); // 첫 점검이 진행 중
    expect(calls).toBe(1);
    const startedBeforeStop = calls;
    await monitor.stop();
    expect(finished).toBe(startedBeforeStop); // 진행 중이던 점검이 끝난 뒤에 stop이 돌아온다
    expect(maxRunning).toBe(1);
    await sleep(60);
    expect(calls).toBe(startedBeforeStop);
  });

  it('점검 오류는 삼키고 다음 틱에 계속한다', async () => {
    await monitor.stop();
    let calls = 0;
    const log = vi.fn();
    monitor = startConnectionMonitor({
      intervalMs: 5,
      log,
      check: async () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    await sleep(60);
    await monitor.stop();
    expect(calls).toBeGreaterThan(1);
    expect(log).toHaveBeenCalled();
  });

  it('stop() 뒤에는 장부 함수가 아무 일도 하지 않는다', async () => {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    await monitor.stop();
    await studentSocketConnected(a!.id);
    studentSocketDisconnected(a!.id);
    expect(await prisma.signal.count()).toBe(0);
    await checkConnections(t + 1_000_000); // 감시가 없으면 점검도 하지 않는다
    expect(await prisma.signal.count()).toBe(0);
  });
});

describe('실제 소켓 연결·끊김이 장부에 반영된다', () => {
  it('소켓을 닫고 유예가 지나면 DISCONNECT, 다시 붙으면 RECONNECT', async () => {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    const open = async () => {
      const s = connect(server.url, { auth: { sessionToken: a!.token }, transports: ['polling'], reconnection: false, forceNew: true });
      sockets.push(s);
      await once(s, EV.ATTEMPT_STATE);
      return s;
    };
    const s1 = await open();
    s1.close();
    await sleep(500);
    advance(DISCONNECT_GRACE_MS + 1000);
    await check();
    expect(await signalsOf(a!.id, 'DISCONNECT')).toHaveLength(1);
    await open();
    await sleep(500);
    const re = await signalsOf(a!.id, 'RECONNECT');
    expect(re).toHaveLength(1);
    expect((re[0]!.meta as { offlineMs: number }).offlineMs).toBeGreaterThanOrEqual(DISCONNECT_GRACE_MS);
  });
});

describe('recordHeartbeat의 SEQ_GAP 행 상한', () => {
  async function seed(n: number) {
    const fx = await fixture();
    const [a] = await makeAttempts(fx.exam, 1);
    await prisma.signal.createMany({ data: Array.from({ length: n }, (_, i) => ({ attemptId: a!.id, type: 'PASTE' as const, severity: 'WARN' as const, seq: i + 1 })) });
    await prisma.attempt.update({ where: { id: a!.id }, data: { lastSeq: n } });
    return a!;
  }

  it('상한 미만이면 SEQ_GAP이 남는다(대조)', async () => {
    const a = await seed(5);
    await recordHeartbeat(a.id, 20, () => new Date(t));
    expect(await signalsOf(a.id, 'SEQ_GAP')).toHaveLength(1);
  });

  it('상한에 닿으면 SEQ_GAP 행을 만들지 않고 lastSeq만 진행한다', async () => {
    const a = await seed(MAX_CLIENT_SIGNALS_PER_ATTEMPT);
    const before = await prisma.signal.count({ where: { attemptId: a.id } });
    await recordHeartbeat(a.id, MAX_CLIENT_SIGNALS_PER_ATTEMPT + 50, () => new Date(t));
    expect(await prisma.signal.count({ where: { attemptId: a.id } })).toBe(before);
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.id } })).lastSeq).toBe(MAX_CLIENT_SIGNALS_PER_ATTEMPT + 50);
  });
});
