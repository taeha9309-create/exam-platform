import { EV } from '@exam/shared';
import type { AttemptSummary } from '@exam/shared';
import { PrismaClient } from '@prisma/client';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { broadcast } from '../src/realtime/broadcast';
import { buildAttemptSummary, loadDashboardSnapshot, type DashboardSnapshot, type SummaryAttemptRow } from '../src/services/dashboard';
import { recordConsent } from '../src/services/entry';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  // 새 DB 연결이 느린 환경 보정(realtime.test.ts와 같은 이유)
  await Promise.all(Array.from({ length: 6 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
});
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

const once = <T = unknown>(s: Socket, ev: string, ms = 6000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

const quiet = (s: Socket, ev: string, ms = 500) =>
  new Promise<boolean>((resolve) => {
    let got = false;
    s.on(ev, () => (got = true));
    setTimeout(() => resolve(!got), ms);
  });

/** 교수자 소켓을 열고 join한다. 스냅샷은 join 중에 오므로 먼저 받을 준비를 한다. */
async function staffJoin(examId: string, staffId: string): Promise<{ socket: Socket; snapshot: DashboardSnapshot; ack: { ok: boolean; code?: string } }> {
  const socket = open({ cookie: staffCookie(staffId) });
  await once(socket, 'connect');
  const snap = once<DashboardSnapshot>(socket, EV.DASHBOARD_SNAPSHOT);
  const ack = (await socket.timeout(4000).emitWithAck(EV.DASHBOARD_JOIN, { examId })) as { ok: boolean; code?: string };
  return { socket, snapshot: await snap, ack };
}

async function openExam(over: Parameters<typeof makeExam>[0] = {}) {
  const staff = await makeStaff();
  const exam = await makeExam({ ownerId: staff.id, status: 'OPEN', ...over });
  return { staff, exam };
}

async function addRoster(examId: string, count: number) {
  await prisma.rosterEntry.createMany({
    data: Array.from({ length: count }, (_, i) => ({ examId, studentNo: `2026${String(100 + i).padStart(4, '0')}`, name: `추가${i}` })),
  });
}

async function makeAttempt(examId: string, studentNo: string, data: Record<string, unknown> = {}) {
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId, studentNo } });
  const token = generateToken();
  const attempt = await prisma.attempt.create({
    data: { examId, rosterEntryId: roster.id, sessionTokenHash: hashToken(token), questionOrder: [], choiceOrders: {}, ...data },
  });
  return { attempt, token };
}

describe('스냅샷 내용(F-13)', () => {
  it('(a) 명단 전원이 학번순으로 들어 있고 미입장은 state null', async () => {
    const { exam } = await openExam();
    await addRoster(exam.id, 17); // 3 + 17 = 20명
    await makeAttempt(exam.id, '20260003');
    await makeAttempt(exam.id, '20260001', { consentAt: new Date(), envCheckedAt: new Date() });

    const snap = (await loadDashboardSnapshot(exam.id))!;
    expect(snap.attempts).toHaveLength(20);
    expect(snap.exam.total).toBe(20);
    const nos = snap.attempts.map((a) => a.studentNo);
    expect(nos).toEqual([...nos].sort());
    const byNo = new Map(snap.attempts.map((a) => [a.studentNo, a]));
    expect(byNo.get('20260002')).toMatchObject({ state: null, attemptId: null, unackedSeverity: 'NONE', violationCount: 0, connected: false, away: false });
    expect(byNo.get('20260001')).toMatchObject({ state: 'WAITING', ready: true });
    expect(byNo.get('20260003')).toMatchObject({ state: 'WAITING', ready: false });
    expect(snap.attempts.filter((a) => a.state === null)).toHaveLength(18);
    // 준비 완료 인원은 waitingCount와 같은 정의
    expect(snap.exam.ready).toBe(1);
    expect(snap.exam).toMatchObject({ id: exam.id, title: '테스트 시험', status: 'OPEN', endsAt: null, lockNewEntry: false });
    expect(typeof snap.exam.serverNow).toBe('number');
  });

  it('시험이 없으면 null', async () => {
    expect(await loadDashboardSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('(b) AUTO_PAUSE로 잠긴 응시는 locked true, 감독관 PAUSE는 false', async () => {
    const { staff, exam } = await openExam({ status: 'RUNNING', startedAt: new Date(), endsAt: new Date(Date.now() + 600_000) });
    const auto = await makeAttempt(exam.id, '20260001', { state: 'PAUSED', pausedAt: new Date(), violationCount: 5 });
    const manual = await makeAttempt(exam.id, '20260002', { state: 'PAUSED', pausedAt: new Date() });
    const active = await makeAttempt(exam.id, '20260003', { state: 'ACTIVE' });
    await prisma.proctorAction.create({ data: { attemptId: auto.attempt.id, type: 'AUTO_PAUSE', reason: '시스템 자동 일시정지(위반 5회)' } });
    await prisma.proctorAction.create({ data: { attemptId: manual.attempt.id, staffId: staff.id, type: 'PAUSE', reason: '확인' } });

    const byNo = new Map((await loadDashboardSnapshot(exam.id))!.attempts.map((a) => [a.studentNo, a]));
    expect(byNo.get('20260001')).toMatchObject({ locked: true, state: 'PAUSED', violationCount: 5 });
    expect(byNo.get('20260002')).toMatchObject({ locked: false, state: 'PAUSED' });
    expect(byNo.get('20260003')?.locked).toBe(false);
    expect(typeof byNo.get('20260001')?.pausedAt).toBe('number');
    expect(byNo.get('20260003')?.deadline).toBe(exam.endsAt!.getTime());
    void active;
  });

  it('잠금 뒤 감독관 RESUME으로 ACTIVE가 되면 locked false', async () => {
    const { exam } = await openExam({ status: 'RUNNING', endsAt: new Date(Date.now() + 600_000) });
    const a = await makeAttempt(exam.id, '20260001', { state: 'ACTIVE' });
    await prisma.proctorAction.create({ data: { attemptId: a.attempt.id, type: 'AUTO_PAUSE', reason: 'x' } });
    const row = (await loadDashboardSnapshot(exam.id))!.attempts.find((x) => x.studentNo === '20260001');
    expect(row?.locked).toBe(false);
  });

  it('(c) pendingApprovals: 지각·중복 접속 각각 학번·이름과 함께, 거절된 중복 요청은 제외', async () => {
    const { exam } = await openExam({ status: 'RUNNING', endsAt: new Date(Date.now() + 600_000) });
    const late = await makeAttempt(exam.id, '20260001', { state: 'PENDING_APPROVAL', isLate: true });
    const dup = await makeAttempt(exam.id, '20260002', { state: 'ACTIVE', pendingTokenHash: hashToken('another') });
    await makeAttempt(exam.id, '20260003', { state: 'ACTIVE', pendingTokenHash: `rejected:${hashToken('old')}` });

    const snap = (await loadDashboardSnapshot(exam.id))!;
    expect(snap.pendingApprovals).toEqual([
      { attemptId: late.attempt.id, kind: 'LATE', studentNo: '20260001', name: '학생1' },
      { attemptId: dup.attempt.id, kind: 'DUPLICATE', studentNo: '20260002', name: '학생2' },
    ]);
  });

  it('away: 마지막 이탈 신호가 LEAVE_START이면 true, 뒤에 LEAVE가 오면 false. lastSignal은 가장 최근 신호', async () => {
    const { exam } = await openExam({ status: 'RUNNING', endsAt: new Date(Date.now() + 600_000) });
    const a = await makeAttempt(exam.id, '20260001', { state: 'ACTIVE' });
    const b = await makeAttempt(exam.id, '20260002', { state: 'ACTIVE' });
    const t = (s: number) => new Date(Date.now() - 100_000 + s * 1000);
    await prisma.signal.createMany({
      data: [
        { attemptId: a.attempt.id, type: 'LEAVE_START', severity: 'WARN', receivedAt: t(1) },
        { attemptId: b.attempt.id, type: 'LEAVE_START', severity: 'WARN', receivedAt: t(1) },
        { attemptId: b.attempt.id, type: 'LEAVE', severity: 'ALERT', receivedAt: t(2), durationMs: 20000 },
        { attemptId: b.attempt.id, type: 'PASTE', severity: 'WARN', receivedAt: t(3) },
      ],
    });
    const byNo = new Map((await loadDashboardSnapshot(exam.id))!.attempts.map((x) => [x.studentNo, x]));
    expect(byNo.get('20260001')).toMatchObject({ away: true, lastSignal: { type: 'LEAVE_START', severity: 'WARN' } });
    expect(byNo.get('20260002')).toMatchObject({ away: false, lastSignal: { type: 'PASTE', severity: 'WARN' } });
  });

  it('connected: 최근 하트비트가 10초 안일 때만 true', async () => {
    const { exam } = await openExam({ status: 'RUNNING', endsAt: new Date(Date.now() + 600_000) });
    await makeAttempt(exam.id, '20260001', { state: 'ACTIVE', lastHeartbeatAt: new Date() });
    await makeAttempt(exam.id, '20260002', { state: 'ACTIVE', lastHeartbeatAt: new Date(Date.now() - 60_000) });
    const byNo = new Map((await loadDashboardSnapshot(exam.id))!.attempts.map((x) => [x.studentNo, x]));
    expect(byNo.get('20260001')?.connected).toBe(true);
    expect(byNo.get('20260002')?.connected).toBe(false);
    expect(byNo.get('20260003')?.connected).toBe(false);
  });
});

describe('쿼리 수는 응시 수에 비례하지 않는다', () => {
  it('25명 스냅샷과 3명 스냅샷의 쿼리 수가 같고 상수 이하', async () => {
    const counter = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    let queries = 0;
    (counter as unknown as { $on(ev: 'query', cb: () => void): void }).$on('query', () => (queries += 1));
    try {
      const { exam } = await openExam();
      await makeAttempt(exam.id, '20260001', { state: 'ACTIVE' });
      await loadDashboardSnapshot(exam.id, counter); // 연결 준비 쿼리 영향 제거
      queries = 0;
      await loadDashboardSnapshot(exam.id, counter);
      const small = queries;

      await addRoster(exam.id, 22); // 25명
      const roster = await prisma.rosterEntry.findMany({ where: { examId: exam.id, attempt: null } });
      for (const r of roster) {
        const at = await prisma.attempt.create({
          data: { examId: exam.id, rosterEntryId: r.id, sessionTokenHash: hashToken(generateToken()), questionOrder: [], choiceOrders: {}, state: 'ACTIVE', violationCount: 1 },
        });
        await prisma.signal.create({ data: { attemptId: at.id, type: 'PASTE', severity: 'WARN' } });
        await prisma.proctorAction.create({ data: { attemptId: at.id, type: 'PAUSE', reason: 'x' } });
      }
      queries = 0;
      const snap = (await loadDashboardSnapshot(exam.id, counter))!;
      expect(snap.attempts).toHaveLength(25);
      expect(queries).toBe(small);
      expect(queries).toBeLessThanOrEqual(8);
    } finally {
      await counter.$disconnect();
    }
  });
});

describe('buildAttemptSummary(순수)', () => {
  const base: SummaryAttemptRow = {
    id: 'a1',
    state: 'ACTIVE',
    consentAt: new Date(),
    consentDeclined: false,
    envCheckedAt: new Date(),
    violationCount: 2,
    unackedSeverity: 'WARN',
    extraSeconds: 60,
    lastHeartbeatAt: null,
    pausedAt: null,
  };
  const roster = { studentNo: '1', name: 'n' };
  const ctx = { endsAt: new Date(1_000_000), lastLeaveType: null, now: new Date(2_000_000) } as const;

  it('deadline은 endsAt + extraSeconds, 시작 전이면 null', () => {
    expect(buildAttemptSummary(base, roster, null, null, ctx).deadline).toBe(1_060_000);
    expect(buildAttemptSummary(base, roster, null, null, { ...ctx, endsAt: null }).deadline).toBeNull();
  });

  it('종착 상태는 connected·away가 false', () => {
    const s = buildAttemptSummary({ ...base, state: 'SUBMITTED', lastHeartbeatAt: ctx.now }, roster, null, null, { ...ctx, lastLeaveType: 'LEAVE_START' });
    expect(s).toMatchObject({ connected: false, away: false });
  });

  it('PAUSED + AUTO_PAUSE만 locked', () => {
    const p = { ...base, state: 'PAUSED' as const };
    expect(buildAttemptSummary(p, roster, null, 'AUTO_PAUSE', ctx).locked).toBe(true);
    expect(buildAttemptSummary(p, roster, null, 'PAUSE', ctx).locked).toBe(false);
    expect(buildAttemptSummary(base, roster, null, 'AUTO_PAUSE', ctx).locked).toBe(false);
  });
});

describe('dashboard:join 스냅샷과 변경분', () => {
  it('(d) 두 교수자가 같은 시험을 열면 둘 다 같은 스냅샷을 받고, 동의 완료 뒤 둘 다 2초 안에 attempt:updated를 받는다', async () => {
    const { staff, exam } = await openExam();
    const { attempt, token } = await makeAttempt(exam.id, '20260002');
    const staff2 = await makeStaff();

    const [a, b] = await Promise.all([staffJoin(exam.id, staff.id), staffJoin(exam.id, staff2.id)]);
    expect(a.ack).toEqual({ ok: true }); // ack는 기존 {ok, code} 형태 유지
    expect(b.ack).toEqual({ ok: true });
    const strip = (s: DashboardSnapshot) => ({ ...s, exam: { ...s.exam, serverNow: 0 } });
    expect(strip(a.snapshot)).toEqual(strip(b.snapshot));
    expect(a.snapshot.attempts).toHaveLength(3);

    const gotA = once<AttemptSummary>(a.socket, EV.ATTEMPT_UPDATED, 2000);
    const gotB = once<AttemptSummary>(b.socket, EV.ATTEMPT_UPDATED, 2000);
    await recordConsent({ id: attempt.id, sessionTokenHash: hashToken(token) }, true);
    for (const got of await Promise.all([gotA, gotB])) {
      expect(got).toMatchObject({ attemptId: attempt.id, studentNo: '20260002', name: '학생2', state: 'WAITING', ready: false, consentDeclined: false });
    }
  });

  it('(e) 새로고침(재조인)하면 직전과 같은 state·unackedSeverity가 복원된다', async () => {
    const { staff, exam } = await openExam({ status: 'RUNNING', endsAt: new Date(Date.now() + 600_000) });
    const { attempt } = await makeAttempt(exam.id, '20260001', { state: 'ACTIVE', unackedSeverity: 'ALERT', violationCount: 3 });
    const first = await staffJoin(exam.id, staff.id);
    first.socket.close();
    const second = await staffJoin(exam.id, staff.id);
    const pick = (s: DashboardSnapshot) => s.attempts.find((x) => x.attemptId === attempt.id);
    expect(pick(first.snapshot)).toMatchObject({ state: 'ACTIVE', unackedSeverity: 'ALERT', violationCount: 3 });
    expect(pick(second.snapshot)).toEqual(pick(first.snapshot));
  });

  it('(f) 학생 소켓은 스냅샷·변경분을 받지 못하고 join도 거부된다', async () => {
    const { staff, exam } = await openExam();
    const { attempt, token } = await makeAttempt(exam.id, '20260001');
    const student = open({ auth: { sessionToken: token } });
    await once(student, 'connect');
    const noSnap = quiet(student, EV.DASHBOARD_SNAPSHOT, 800);
    const noUpdate = quiet(student, EV.ATTEMPT_UPDATED, 800);
    const ack = (await student.timeout(4000).emitWithAck(EV.DASHBOARD_JOIN, { examId: exam.id })) as { ok: boolean; code?: string };
    expect(ack).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    await staffJoin(exam.id, staff.id);
    await broadcast.attemptUpdated(attempt.id);
    expect(await noSnap).toBe(true);
    expect(await noUpdate).toBe(true);
  });

  it('존재하지 않는 시험 join은 NOT_FOUND이고 스냅샷을 받지 못한다', async () => {
    const staff = await makeStaff();
    const socket = open({ cookie: staffCookie(staff.id) });
    await once(socket, 'connect');
    const noSnap = quiet(socket, EV.DASHBOARD_SNAPSHOT, 800);
    const ack = (await socket.timeout(4000).emitWithAck(EV.DASHBOARD_JOIN, { examId: '00000000-0000-4000-8000-000000000000' })) as { ok: boolean; code?: string };
    expect(ack).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await noSnap).toBe(true);
  });

  it('다른 시험의 교수자 방에는 변경분이 가지 않는다', async () => {
    const { staff, exam } = await openExam();
    const other = await openExam();
    const { attempt } = await makeAttempt(exam.id, '20260001');
    const mine = await staffJoin(exam.id, staff.id);
    const theirs = await staffJoin(other.exam.id, other.staff.id);
    const got = once(mine.socket, EV.ATTEMPT_UPDATED, 2000);
    const none = quiet(theirs.socket, EV.ATTEMPT_UPDATED, 800);
    await broadcast.attemptUpdated(attempt.id);
    await got;
    expect(await none).toBe(true);
  });

  it('attemptUpdated: 없는 응시는 조용히 무시한다(예외 없음)', async () => {
    await expect(broadcast.attemptUpdated('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });

  it('(g) 스냅샷·변경분 어디에도 passcode·토큰 해시·정답이 없다', async () => {
    const { staff, exam } = await openExam({ passcode: 'PS7X9K' });
    const a = await makeAttempt(exam.id, '20260001', { pendingTokenHash: hashToken('pending-secret') });
    const joined = await staffJoin(exam.id, staff.id);
    const updated = once<AttemptSummary>(joined.socket, EV.ATTEMPT_UPDATED, 3000);
    await broadcast.attemptUpdated(a.attempt.id);
    const text = JSON.stringify([joined.snapshot, await updated]);
    expect(text).not.toContain('PS7X9K');
    expect(text).not.toContain(hashToken(a.token));
    expect(text).not.toContain(hashToken('pending-secret'));
    expect(text).not.toMatch(/passcode|TokenHash|correctChoiceId|sessionToken|pendingToken/i);
    expect(text).not.toContain('"c1"'); // 정답 보기 ID
  });
});
