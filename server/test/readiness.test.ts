import { EV } from '@exam/shared';
import type { AttemptState, Exam } from '@prisma/client';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { broadcast } from '../src/realtime/broadcast';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];
let ownerId: string;
let ownerCookie: string;

beforeAll(async () => {
  server = await startTestServer();
  await Promise.all(Array.from({ length: 6 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDb();
  const staff = await makeStaff();
  ownerId = staff.id;
  ownerCookie = staffCookie(staff.id);
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

const once = <T = unknown>(s: Socket, ev: string, ms = 6000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });
const quiet = (s: Socket, ev: string, ms = 400) =>
  new Promise<boolean>((resolve) => {
    let got = false;
    s.on(ev, () => (got = true));
    setTimeout(() => resolve(!got), ms);
  });

async function staffSocket(examId: string): Promise<Socket> {
  const s = connect(server.url, { extraHeaders: { Cookie: ownerCookie }, transports: ['polling'], reconnection: false, forceNew: true });
  sockets.push(s);
  await once(s, 'connect');
  const ack = (await s.timeout(2000).emitWithAck(EV.DASHBOARD_JOIN, { examId })) as { ok: boolean };
  expect(ack.ok).toBe(true);
  return s;
}

const open = (over: Partial<Exam> = {}) => makeExam({ ownerId, status: 'OPEN', passcode: '123456', ...over });
const running = (over: Partial<Exam> = {}) =>
  makeExam({ ownerId, status: 'RUNNING', passcode: '123456', startedAt: new Date(), endsAt: new Date(Date.now() + 600_000), ...over });

async function makeAttempt(examId: string, state: AttemptState = 'WAITING', data: Record<string, unknown> = {}) {
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId, attempt: null }, orderBy: { studentNo: 'asc' } });
  const token = generateToken();
  const attempt = await prisma.attempt.create({
    data: { examId, rosterEntryId: roster.id, state, sessionTokenHash: hashToken(token), questionOrder: [], choiceOrders: {}, ...data },
  });
  return { attempt, token };
}

const post = (path: string, token: string | null, body: unknown) => {
  const r = request(server.url).post(path);
  return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body as object);
};
const consent = (token: string | null, agree: unknown = true) => post('/api/student/consent', token, { agree });
const ENV = { browser: 'chrome', isExtended: false, fullscreen: true };
const env = (token: string | null, over: Record<string, unknown> = {}) => post('/api/student/env', token, { ...ENV, ...over });
const reload = (id: string) => prisma.attempt.findUniqueOrThrow({ where: { id } });
const signals = (id: string) => prisma.signal.findMany({ where: { attemptId: id, type: 'MULTI_MONITOR' } });

describe('인증과 입력 검증', () => {
  it('토큰이 없거나 교수자 쿠키만 있으면 401', async () => {
    const exam = await open();
    await makeAttempt(exam.id);
    expect((await consent(null)).status).toBe(401);
    expect((await env(null)).status).toBe(401);
    expect((await request(server.url).post('/api/student/consent').set('Cookie', ownerCookie).send({ agree: true })).status).toBe(401);
    expect((await request(server.url).post('/api/student/env').set('Cookie', ownerCookie).send(ENV)).status).toBe(401);
    expect((await consent('not-a-token')).status).toBe(401);
  });

  it('승인 대기 중 pendingToken으로는 통과하지 못한다', async () => {
    const exam = await running();
    const { attempt } = await makeAttempt(exam.id);
    const pending = generateToken();
    await prisma.attempt.update({ where: { id: attempt.id }, data: { pendingTokenHash: hashToken(pending) } });
    expect((await consent(pending)).status).toBe(401);
  });

  it('consent 본문: agree는 boolean만, 추가 필드는 400', async () => {
    const exam = await open();
    const { token } = await makeAttempt(exam.id);
    for (const bad of [{}, { agree: 'true' }, { agree: 1 }, { agree: null }, { agree: [true] }, { agree: { a: 1 } }, { agree: true, extra: 1 }]) {
      const res = await post('/api/student/consent', token, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/api/student/consent', token, [{ agree: true }])).status).toBe(400);
  });

  it('env 본문: browser 열거, boolean, fullscreen true, 추가 필드 거부', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id, 'WAITING', { consentAt: new Date() });
    const bads: Record<string, unknown>[] = [
      { browser: 'firefox' },
      { browser: ['chrome'] },
      { browser: { a: 1 } },
      { browser: 'Chrome' },
      { isExtended: 'false' },
      { isExtended: null },
      { fullscreen: false },
      { fullscreen: 'true' },
      { extra: 1 },
    ];
    for (const b of bads) expect((await env(token, b)).status, JSON.stringify(b)).toBe(400);
    expect((await post('/api/student/env', token, { browser: 'chrome', isExtended: false })).status).toBe(400); // fullscreen 누락
    expect((await post('/api/student/env', token, [ENV])).status).toBe(400);
    expect((await reload(attempt.id)).envCheckedAt).toBeNull();
  });
});

describe('동의(F-08)', () => {
  it('동의하면 consentAt이 기록되고 응답에 needs가 갱신된다', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    const res = await consent(token);
    expect(res.status).toBe(200);
    expect(res.body.needs).toEqual({ consent: false, env: true });
    expect(JSON.stringify(res.body)).not.toMatch(/passcode|Hash|correct/i);
    const row = await reload(attempt.id);
    expect(row.consentAt).not.toBeNull();
    expect(row.consentDeclined).toBe(false);
  });

  it('동의 거부는 consentDeclined=true, consentAt 없음. 다시 동의하면 해제', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    expect((await consent(token, false)).status).toBe(200);
    let row = await reload(attempt.id);
    expect(row.consentDeclined).toBe(true);
    expect(row.consentAt).toBeNull();
    expect((await env(token)).status).toBe(409); // 동의 거부 상태에서는 환경 점검 불가
    await consent(token, true);
    row = await reload(attempt.id);
    expect(row.consentDeclined).toBe(false);
    expect(row.consentAt).not.toBeNull();
  });

  it('동의 후 거부하면 동의가 철회되어 준비 미완료가 된다', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    await consent(token);
    await env(token);
    expect((await reload(attempt.id)).envCheckedAt).not.toBeNull();
    await consent(token, false);
    const row = await reload(attempt.id);
    expect(row.consentAt).toBeNull();
    expect(row.consentDeclined).toBe(true);
  });

  it('같은 동의를 반복해도 consentAt이 바뀌지 않고 알림도 없다', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    const staff = await staffSocket(exam.id);
    const first = once(staff, EV.ATTEMPT_UPDATED);
    await consent(token);
    expect(await first).toEqual({ attemptId: attempt.id });
    const at = (await reload(attempt.id)).consentAt!.getTime();
    const q = quiet(staff, EV.ATTEMPT_UPDATED);
    await consent(token);
    await consent(token);
    expect(await q).toBe(true);
    expect((await reload(attempt.id)).consentAt!.getTime()).toBe(at);
  });
});

describe('환경 점검(F-09)', () => {
  it('동의 없이 env는 409 CONSENT_REQUIRED이고 저장되지 않는다', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    const res = await env(token);
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('CONSENT_REQUIRED');
    expect((await reload(attempt.id)).envCheckedAt).toBeNull();
  });

  it('env를 저장한다(envBrowser, envIsExtended, envCheckedAt)', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    await consent(token);
    const res = await env(token, { browser: 'edge' });
    expect(res.status).toBe(200);
    expect(res.body.needs).toEqual({ consent: false, env: false });
    const row = await reload(attempt.id);
    expect(row).toMatchObject({ envBrowser: 'edge', envIsExtended: false });
    expect(row.envCheckedAt).not.toBeNull();
    expect(await signals(attempt.id)).toHaveLength(0);
  });

  it('isExtended=true면 MULTI_MONITOR(WARN) 신호 1건. 반복 제출·토글해도 늘지 않는다', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    await consent(token);
    await env(token, { isExtended: true });
    let sig = await signals(attempt.id);
    expect(sig).toHaveLength(1);
    expect(sig[0]!.severity).toBe('WARN');
    await env(token, { isExtended: true });
    await env(token, { isExtended: false });
    await env(token, { isExtended: true });
    sig = await signals(attempt.id);
    expect(sig).toHaveLength(1);
    expect((await reload(attempt.id)).envIsExtended).toBe(true);
  });

  it('동시에 같은 env를 여러 번 보내도 신호는 1건', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    await consent(token);
    const results = await Promise.all(Array.from({ length: 5 }, () => env(token, { isExtended: true })));
    for (const r of results) expect(r.status).toBe(200);
    expect(await signals(attempt.id)).toHaveLength(1);
  });
});

describe('준비 완료(F-10)', () => {
  it('OPEN에서 준비 완료가 되면 waiting:count를 학생·교수자가 받고 상태는 WAITING 유지', async () => {
    const exam = await open();
    const a = await makeAttempt(exam.id);
    const staff = await staffSocket(exam.id);
    await consent(a.token);
    const got = once<{ ready: number; total: number }>(staff, EV.WAITING_COUNT);
    const res = await env(a.token);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('WAITING');
    expect(await got).toEqual({ ready: 1, total: 3 });
    expect((await reload(a.attempt.id)).state).toBe('WAITING');
  });

  it('waiting:count의 ready는 준비 완료 인원: 3명 confirm만 하면 0, 한 명 완료로 0→1, 동의 철회로 다시 0', async () => {
    const exam = await open();
    const list = [await makeAttempt(exam.id), await makeAttempt(exam.id), await makeAttempt(exam.id)];
    const staff = await staffSocket(exam.id);
    const a = list[0]!;
    await consent(a.token);
    let got = once<{ ready: number; total: number }>(staff, EV.WAITING_COUNT);
    await env(a.token);
    expect(await got).toEqual({ ready: 1, total: 3 });
    got = once<{ ready: number; total: number }>(staff, EV.WAITING_COUNT);
    await consent(a.token, false);
    expect(await got).toEqual({ ready: 0, total: 3 });
  });

  it('confirm만 한 대기 인원은 ready에 세지 않는다(broadcast.waitingCount)', async () => {
    const exam = await open();
    await makeAttempt(exam.id);
    await makeAttempt(exam.id);
    await makeAttempt(exam.id);
    const staff = await staffSocket(exam.id);
    const got = once<{ ready: number; total: number }>(staff, EV.WAITING_COUNT);
    await broadcast.waitingCount(exam.id);
    expect(await got).toEqual({ ready: 0, total: 3 });
  });

  it('RUNNING 중 승인된 지각생(WAITING)이 준비 완료되면 ACTIVE + attempt:state', async () => {
    const exam = await running();
    const a = await makeAttempt(exam.id, 'WAITING', { isLate: true });
    const sock = connect(server.url, { auth: { sessionToken: a.token }, transports: ['polling'], reconnection: false, forceNew: true });
    sockets.push(sock);
    await once(sock, EV.ATTEMPT_STATE); // 연결 직후 현재 상태
    const staff = await staffSocket(exam.id);
    await consent(a.token);
    expect((await reload(a.attempt.id)).state).toBe('WAITING'); // 동의만으로는 아직
    const gotState = once<{ state: string }>(sock, EV.ATTEMPT_STATE);
    const gotUpdated = once(staff, EV.ATTEMPT_UPDATED);
    const res = await env(a.token);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ACTIVE');
    expect(res.body.deadline).toBe(exam.endsAt!.getTime());
    expect((await gotState).state).toBe('ACTIVE');
    expect(await gotUpdated).toEqual({ attemptId: a.attempt.id });
    expect((await reload(a.attempt.id)).state).toBe('ACTIVE');
  });

  it('알림 페이로드와 응답에 비밀번호·토큰 해시가 없다', async () => {
    const exam = await running();
    const a = await makeAttempt(exam.id);
    await consent(a.token);
    const res = await env(a.token);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('123456');
    expect(text).not.toContain(a.attempt.sessionTokenHash);
    expect(Object.keys(res.body).sort()).toEqual(['deadline', 'extraSeconds', 'needs', 'serverNow', 'state', 'violationCount']);
  });
});

describe('상태 거절과 경쟁', () => {
  it.each(['SUBMITTED', 'TERMINATED', 'REJECTED', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] as const)('%s 응시의 동의·환경 변경은 409이고 변경되지 않는다', async (state) => {
    const exam = await running();
    const { token, attempt } = await makeAttempt(exam.id, state);
    expect((await consent(token)).status).toBe(409);
    expect((await consent(token, false)).status).toBe(409);
    expect((await env(token)).status).toBe(409);
    const row = await reload(attempt.id);
    expect(row.consentAt).toBeNull();
    expect(row.consentDeclined).toBe(false);
    expect(row.envCheckedAt).toBeNull();
    expect(row.state).toBe(state);
  });

  it('PENDING_APPROVAL 응시는 세션 토큰이 있어도 승인 전에는 409', async () => {
    const exam = await running();
    const { token } = await makeAttempt(exam.id, 'PENDING_APPROVAL', { isLate: true });
    expect((await consent(token)).status).toBe(409);
  });

  it('시험이 ENDED이면 변경 불가(409)', async () => {
    const exam = await open();
    const { token, attempt } = await makeAttempt(exam.id);
    await consent(token);
    await prisma.exam.update({ where: { id: exam.id }, data: { status: 'ENDED', endedAt: new Date() } });
    expect((await consent(token, false)).status).toBe(409);
    expect((await env(token)).status).toBe(409);
    expect((await reload(attempt.id)).consentAt).not.toBeNull();
  });

  it('여러 학생이 동시에 준비 완료해도 각자 정상 처리된다', async () => {
    const exam = await open();
    const list = [await makeAttempt(exam.id), await makeAttempt(exam.id), await makeAttempt(exam.id)];
    const res = await Promise.all(list.map(async (a) => [await consent(a.token), await env(a.token)]));
    for (const [c, e] of res) {
      expect(c!.status).toBe(200);
      expect(e!.status).toBe(200);
    }
    expect(await prisma.attempt.count({ where: { examId: exam.id, consentAt: { not: null }, envCheckedAt: { not: null } } })).toBe(3);
  });

  it('시험 시작과 준비 완료가 겹쳐도 모순이 없다(ready면 ACTIVE, 아니면 WAITING)', async () => {
    for (let i = 0; i < 3; i += 1) {
      await resetDb();
      const staff = await makeStaff();
      ownerId = staff.id;
      ownerCookie = staffCookie(staff.id);
      const exam = await open();
      const a = await makeAttempt(exam.id);
      await consent(a.token);
      const start = request(server.url).post(`/api/exams/${exam.id}/start`).set('Cookie', ownerCookie).send({});
      const [s, e] = await Promise.all([start, env(a.token)]);
      expect(e.status).toBe(200);
      expect([200, 409]).toContain(s.status);
      const row = await reload(a.attempt.id);
      const examRow = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
      if (examRow.status === 'RUNNING') expect(row.state).toBe('ACTIVE');
      expect(row.envCheckedAt).not.toBeNull();
    }
  });

  it('시험 종료와 준비 완료가 겹쳐도 종료 뒤에 ACTIVE가 되지 않는다', async () => {
    const exam = await running();
    const a = await makeAttempt(exam.id);
    await consent(a.token);
    const end = request(server.url).post(`/api/exams/${exam.id}/end`).set('Cookie', ownerCookie).send({});
    const [s, e] = await Promise.all([end, env(a.token)]);
    expect([200, 409]).toContain(s.status);
    expect([200, 409]).toContain(e.status);
    const row = await reload(a.attempt.id);
    const examRow = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    if (examRow.status === 'ENDED') expect(['SUBMITTED', 'ACTIVE']).toContain(row.state);
    expect(row.state === 'ACTIVE' && examRow.status === 'ENDED' && e.status === 409).toBe(false);
  });
});
