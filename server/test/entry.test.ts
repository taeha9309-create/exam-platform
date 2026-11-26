import cookieParser from 'cookie-parser';
import express, { type Express, type Response } from 'express';
import type { Exam } from '@prisma/client';
import type { Server } from 'socket.io';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, onError } from '../src/app';
import { findAttemptByToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { setIo } from '../src/realtime/broadcast';
import { createAttemptsRouter } from '../src/routes/attempts';
import { createStudentRouter } from '../src/routes/student';
import { confirmOnce, createEntryGuard } from '../src/services/entry';
import type { RateLimiterOptions } from '../src/security/rateLimit';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';

/** 테스트 앱: 입장 실패 한도를 주입할 수 있다(기본은 넉넉하게 — 테스트끼리 같은 IP 한도를 공유하지 않도록). */
function makeApp(entryLimit: Partial<RateLimiterOptions> = { windowMs: 60_000, max: 100_000, maxKeys: 100 }): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createStudentRouter({ entryLimit: { windowMs: 60_000, max: 100_000, maxKeys: 100, ...entryLimit } }));
  app.use('/api/attempts', createAttemptsRouter());
  app.use(onError);
  return app;
}

let app: Express;
let cookie: string;
let ownerId: string;

interface Emitted {
  room: string;
  event: string;
  payload: unknown;
}
let emitted: Emitted[];
let disconnected: string[];

function installFakeIo(): void {
  emitted = [];
  disconnected = [];
  const make = (rooms: string[]): unknown => ({
    to: (r: string) => make([...rooms, r]),
    emit: (event: string, payload: unknown) => {
      for (const room of rooms) emitted.push({ room, event, payload });
    },
    disconnectSockets: () => {
      for (const r of rooms) disconnected.push(r);
    },
  });
  setIo({ to: (r: string) => make([r]), in: (r: string) => make([r]) } as unknown as Server);
}

beforeEach(async () => {
  await resetDb();
  installFakeIo();
  const staff = await makeStaff({ name: '김교수' });
  ownerId = staff.id;
  cookie = staffCookie(staff.id);
  app = makeApp();
});

const PASS = '123456';
const openExam = (over: Partial<Exam> = {}) => makeExam({ ownerId, status: 'OPEN', passcode: PASS, ...over });
const runningExam = (over: Partial<Exam> = {}) =>
  makeExam({ ownerId, status: 'RUNNING', passcode: PASS, startedAt: new Date(), endsAt: new Date(Date.now() + 600_000), ...over });
const body = (exam: Exam, over: Record<string, unknown> = {}) => ({ examCode: exam.examCode, studentNo: '20260001', passcode: PASS, ...over });
const confirm = (b: Record<string, unknown>, a: Express = app) => request(a).post('/api/student/confirm').send(b);
const entry = (b: Record<string, unknown>, a: Express = app) => request(a).post('/api/student/entry').send(b);
const act = (id: string, b: Record<string, unknown>) => request(app).post(`/api/attempts/${id}/actions`).set('Cookie', cookie).send(b);
const me = (token: string) => request(app).get('/api/student/attempt').set('Authorization', `Bearer ${token}`);
const staffEvents = (event: string) => emitted.filter((e) => e.event === event);

describe('GET /api/public/exams/:examCode', () => {
  it('제목과 상태만 돌려준다', async () => {
    const exam = await openExam();
    const res = await request(app).get(`/api/public/exams/${exam.examCode}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: '테스트 시험', status: 'OPEN' });
  });
  it('없는 코드는 404', async () => {
    expect((await request(app).get('/api/public/exams/ZZZZZZZZ')).status).toBe(404);
  });
});

describe('POST /api/student/entry', () => {
  it('OPEN·RUNNING에서 올바른 학번·비밀번호는 이름을 돌려준다', async () => {
    const exam = await openExam();
    const res = await entry(body(exam));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: '학생1' });
    const running = await runningExam();
    expect((await entry(body(running))).body).toEqual({ name: '학생1' });
  });

  it('없는 시험 코드·명단 밖 학번·틀린 비밀번호는 모두 같은 401 ENTRY_FAILED(본문도 동일)', async () => {
    const exam = await openExam();
    const a = await entry(body(exam, { studentNo: '99999999' }));
    const b = await entry(body(exam, { passcode: '000000' }));
    const c = await entry({ examCode: 'ZZZZZZZZ', studentNo: '20260001', passcode: PASS });
    for (const r of [a, b, c]) expect(r.status).toBe(401);
    expect(a.body.error.code).toBe('ENTRY_FAILED');
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
  });

  it('길이가 다른 비밀번호도 500이 아니라 401(타이밍 안전 비교)', async () => {
    const exam = await openExam();
    for (const passcode of ['1', '1234567', 'x'.repeat(64)]) {
      expect((await entry(body(exam, { passcode }))).status).toBe(401);
    }
  });

  it.each(['DRAFT', 'ENDED'] as const)('%s 시험은 403 EXAM_NOT_ENTERABLE', async (status) => {
    const exam = await makeExam({ ownerId, status });
    const res = await entry(body(exam));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EXAM_NOT_ENTERABLE');
  });

  it('입력 검증: 객체·배열·숫자·긴 값·제어 문자는 400', async () => {
    const exam = await openExam();
    const bad: Record<string, unknown>[] = [
      body(exam, { studentNo: { $ne: '' } }),
      body(exam, { passcode: ['123456'] }),
      body(exam, { examCode: 12345678 }),
      body(exam, { studentNo: 'x'.repeat(65) }),
      body(exam, { passcode: '12\u00003' }),
      { examCode: exam.examCode },
    ];
    for (const b of bad) expect((await entry(b)).status, JSON.stringify(b)).toBe(400);
  });

  it('1분 안에 11번째 실패는 429 TOO_MANY_ATTEMPTS + Retry-After, 그 뒤에는 올바른 입력도 거부된다', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 10, maxKeys: 100 });
    const exam = await openExam();
    for (let i = 0; i < 10; i++) expect((await entry(body(exam, { passcode: '000000' }), limited)).status).toBe(401);
    const res = await entry(body(exam, { passcode: '000000' }), limited);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await entry(body(exam), limited)).status).toBe(429);
  });

  it('성공은 세지 않는다: 교실 NAT에서 정상 입장 50번 뒤에도 실패 한도가 그대로', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 10, maxKeys: 100 });
    const exam = await openExam();
    for (let i = 0; i < 50; i++) expect((await entry(body(exam), limited)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await entry(body(exam, { passcode: '000000' }), limited)).status).toBe(401);
    expect((await entry(body(exam, { passcode: '000000' }), limited)).status).toBe(429);
  });

  it('429 거절은 DB를 조회하지 않는다', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 1, maxKeys: 100 });
    const exam = await openExam();
    expect((await entry(body(exam, { passcode: '000000' }), limited)).status).toBe(401);
    const spyExam = vi.spyOn(prisma.exam, 'findUnique');
    const spyRoster = vi.spyOn(prisma.rosterEntry, 'findUnique');
    try {
      expect((await entry(body(exam), limited)).status).toBe(429);
      expect(spyExam).not.toHaveBeenCalled();
      expect(spyRoster).not.toHaveBeenCalled();
    } finally {
      spyExam.mockRestore();
      spyRoster.mockRestore();
    }
  });

  it('동시에 몰린 실패 요청도 한도(10)를 넘겨 통과하지 못한다', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 10, maxKeys: 100 });
    const exam = await openExam();
    const results = await Promise.all(Array.from({ length: 40 }, () => entry(body(exam, { passcode: '000000' }), limited)));
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(30);
  });

  it('X-Forwarded-For 헤더로 IP를 바꿔도 한도를 우회할 수 없다', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 3, maxKeys: 100 });
    const exam = await openExam();
    for (let i = 0; i < 3; i++) {
      await request(limited).post('/api/student/entry').set('X-Forwarded-For', `10.0.0.${i}`).send(body(exam, { passcode: '000000' }));
    }
    const res = await request(limited).post('/api/student/entry').set('X-Forwarded-For', '10.9.9.9').send(body(exam, { passcode: '000000' }));
    expect(res.status).toBe(429);
  });

  it('createApp에도 등록되어 있다', async () => {
    const exam = await openExam();
    const res = await request(createApp()).post('/api/student/entry').send(body(exam));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/student/confirm', () => {
  it('OPEN에서 응시 생성: WAITING + 세션 토큰, DB에는 해시만 저장', async () => {
    const exam = await openExam();
    const res = await confirm(body(exam));
    expect(res.status).toBe(200);
    const { sessionToken, attempt } = res.body;
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.state).toBe('WAITING');
    const row = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row.sessionTokenHash).toBe(hashToken(sessionToken));
    expect(row.sessionTokenHash).not.toBe(sessionToken);
    expect(row.isLate).toBe(false);
    expect((row.questionOrder as string[]).length).toBe(2);
    expect(Object.keys(row.choiceOrders as object).length).toBe(1);
    expect(staffEvents('approval:pending')).toHaveLength(0);
  });

  it('응답 JSON에 correctChoiceId·passcode·Hash가 없다', async () => {
    const exam = await openExam();
    const res = await confirm(body(exam));
    const text = JSON.stringify(res.body);
    for (const bad of ['correctChoiceId', 'passcode', 'Hash', hashToken(res.body.sessionToken)]) expect(text).not.toContain(bad);
    const dup = await confirm(body(exam));
    expect(dup.body.status).toBe('DUPLICATE_PENDING');
    for (const bad of ['correctChoiceId', 'passcode', 'Hash']) expect(JSON.stringify(dup.body)).not.toContain(bad);
  });

  it('같은 토큰으로 다시 confirm하면 같은 응시(이어하기)', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const again = await confirm(body(exam, { sessionToken: first.body.sessionToken }));
    expect(again.status).toBe(200);
    expect(again.body.attempt.id).toBe(first.body.attempt.id);
    expect(again.body.sessionToken).toBe(first.body.sessionToken);
    expect(await prisma.attempt.count()).toBe(1);
  });

  it('다른 토큰·토큰 없음은 DUPLICATE_PENDING + pendingToken, 감독관에게 DUPLICATE 요청 1회', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const res = await confirm(body(exam, { sessionToken: 'other-token' }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DUPLICATE_PENDING');
    expect(res.body.pendingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await prisma.attempt.findUniqueOrThrow({ where: { id: first.body.attempt.id } });
    expect(row.pendingTokenHash).toBe(hashToken(res.body.pendingToken));
    expect(row.sessionTokenHash).toBe(hashToken(first.body.sessionToken)); // 기존 세션은 승인 전까지 그대로
    const ev = staffEvents('approval:pending');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ room: `exam:${exam.id}:staff`, payload: { attemptId: first.body.attempt.id, kind: 'DUPLICATE' } });
    expect((await me(first.body.sessionToken)).status).toBe(200);
  });

  it('이미 대기 요청이 있으면 새 요청은 409 APPROVAL_ALREADY_PENDING: 덮어쓰기·DB 쓰기·알림 없음', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const p1 = await confirm(body(exam));
    const before = await prisma.attempt.findUniqueOrThrow({ where: { id: first.body.attempt.id } });
    emitted.length = 0;
    for (const extra of [{}, { sessionToken: 'attacker-token' }]) {
      const res = await confirm(body(exam, extra));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('APPROVAL_ALREADY_PENDING');
      expect(JSON.stringify(res.body)).not.toMatch(/Hash|rejected|[0-9a-f]{32}/);
    }
    const after = await prisma.attempt.findUniqueOrThrow({ where: { id: first.body.attempt.id } });
    expect(after.pendingTokenHash).toBe(before.pendingTokenHash);
    expect(after.pendingTokenHash).toBe(hashToken(p1.body.pendingToken));
    expect(emitted).toHaveLength(0);
    // 대기 토큰 소지자는 기존대로 폴링
    const poll = await confirm(body(exam, { sessionToken: p1.body.pendingToken }));
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('DUPLICATE_PENDING');
  });

  it('가로채기 방지: B의 요청은 409이고, 승인하면 P1(진짜 사용자)이 세션이 된다', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const p1 = await confirm(body(exam));
    expect((await confirm(body(exam))).status).toBe(409);
    expect((await act(first.body.attempt.id, { type: 'APPROVE_SESSION', reason: '현장 확인 완료' })).status).toBe(200);
    expect((await me(p1.body.pendingToken)).status).toBe(200);
  });

  it('거절 표시(rejected:) 뒤에는 새 요청이 허용된다(새 pendingToken, 알림 1회)', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const p1 = await confirm(body(exam));
    await act(first.body.attempt.id, { type: 'REJECT_SESSION', reason: '거절' });
    emitted.length = 0;
    const p2 = await confirm(body(exam));
    expect(p2.status).toBe(200);
    expect(p2.body.pendingToken).not.toBe(p1.body.pendingToken);
    expect(staffEvents('approval:pending')).toHaveLength(1);
    expect((await confirm(body(exam, { sessionToken: p1.body.pendingToken }))).status).toBe(409); // 이전 토큰은 이제 일반 요청 취급 -> 대기 중이라 409
  });

  it('토큰 면제는 학번만 바꾼 요청에는 적용되지 않는다(401, 한도에 셈)', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 2, maxKeys: 100 });
    const exam = await openExam();
    const a = await confirm(body(exam), limited);
    for (let i = 0; i < 2; i++) {
      const res = await confirm(body(exam, { studentNo: '20260002', passcode: '000000', sessionToken: a.body.sessionToken }), limited);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('ENTRY_FAILED');
    }
    expect((await confirm(body(exam, { studentNo: '20260002', passcode: '000000', sessionToken: a.body.sessionToken }), limited)).status).toBe(429);
  });

  it('guard.fail()로 기록한 실패도 한도에 센다', async () => {
    const g = createEntryGuard({ windowMs: 60_000, max: 2, maxKeys: 10 });
    const res = { setHeader: () => undefined } as unknown as Response;
    g.fail('1.2.3.4');
    g.fail('1.2.3.4');
    await expect(g.run('1.2.3.4', res, async () => 1)).rejects.toMatchObject({ status: 429 });
  });

  it('pendingToken은 승인 전에는 세션이 아니다(HTTP·소켓 인증 모두 거부)', async () => {
    const exam = await openExam();
    await confirm(body(exam));
    const dup = await confirm(body(exam));
    expect((await me(dup.body.pendingToken)).status).toBe(401);
    expect(await findAttemptByToken(dup.body.pendingToken)).toBeNull();
    const poll = await confirm(body(exam, { sessionToken: dup.body.pendingToken }));
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('DUPLICATE_PENDING');
    expect(poll.body.sessionToken).toBeUndefined();
    expect(await prisma.attempt.count()).toBe(1);
  });

  it('APPROVE_SESSION: 기존 토큰 즉시 무효, pendingToken으로 confirm하면 같은 응시를 이어받는다', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const dup = await confirm(body(exam));
    const id = first.body.attempt.id;
    emitted.length = 0;

    const res = await act(id, { type: 'APPROVE_SESSION', reason: '현장 확인 완료' });
    expect(res.status).toBe(200);
    expect((await me(first.body.sessionToken)).status).toBe(401);
    expect(await findAttemptByToken(first.body.sessionToken)).toBeNull();

    const row = await prisma.attempt.findUniqueOrThrow({ where: { id } });
    expect(row.pendingTokenHash).toBeNull();
    expect(row.sessionTokenHash).toBe(hashToken(dup.body.pendingToken));

    const taken = await confirm(body(exam, { sessionToken: dup.body.pendingToken }));
    expect(taken.status).toBe(200);
    expect(taken.body.attempt.id).toBe(id);
    expect(taken.body.sessionToken).toBe(dup.body.pendingToken);
    expect((await me(dup.body.pendingToken)).status).toBe(200);

    // 이벤트: 기존 소켓에 session:revoked 후 연결 종료, 감독관에게 approval:resolved
    expect(staffEvents('session:revoked').map((e) => e.room)).toEqual([`attempt:${id}`]);
    expect(disconnected).toEqual([`attempt:${id}`]);
    expect(staffEvents('approval:resolved')[0]).toMatchObject({ room: `exam:${exam.id}:staff`, payload: { attemptId: id, kind: 'DUPLICATE', approved: true } });

    const actions = await prisma.proctorAction.findMany({ where: { attemptId: id } });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'APPROVE_SESSION', reason: '현장 확인 완료', staffId: ownerId });
  });

  it('REJECT_SESSION: 기존 세션은 유지, 대기 중이던 접속은 거절(403 ENTRY_REJECTED)', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const dup = await confirm(body(exam));
    emitted.length = 0;
    const res = await act(first.body.attempt.id, { type: 'REJECT_SESSION', reason: '다른 학생으로 판단' });
    expect(res.status).toBe(200);
    expect((await me(first.body.sessionToken)).status).toBe(200);
    expect(staffEvents('session:revoked')).toHaveLength(0);
    expect(disconnected).toHaveLength(0);
    const poll = await confirm(body(exam, { sessionToken: dup.body.pendingToken }));
    expect(poll.status).toBe(403);
    expect(poll.body.error.code).toBe('ENTRY_REJECTED');
    expect((await me(dup.body.pendingToken)).status).toBe(401);
    expect(staffEvents('approval:resolved')[0]).toMatchObject({ payload: { kind: 'DUPLICATE', approved: false } });
    const a = await prisma.proctorAction.findFirstOrThrow({ where: { attemptId: first.body.attempt.id } });
    expect(a.type).toBe('REJECT_SESSION');
  });

  it('RUNNING 중 신규 입장은 PENDING_APPROVAL(isLate), APPROVE_ENTRY 후 WAITING', async () => {
    const exam = await runningExam();
    const res = await confirm(body(exam));
    expect(res.status).toBe(200);
    expect(res.body.attempt.state).toBe('PENDING_APPROVAL');
    const id = res.body.attempt.id;
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id } })).isLate).toBe(true);
    expect(staffEvents('approval:pending')[0]).toMatchObject({ payload: { attemptId: id, kind: 'LATE' } });

    const ok = await act(id, { type: 'APPROVE_ENTRY', reason: '현장 확인 완료' });
    expect(ok.status).toBe(200);
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id } })).state).toBe('WAITING');
    expect(staffEvents('approval:resolved')[0]).toMatchObject({ payload: { attemptId: id, kind: 'LATE', approved: true } });
    expect(staffEvents('attempt:state').some((e) => e.room === `attempt:${id}`)).toBe(true);
    expect((await prisma.proctorAction.findFirstOrThrow({ where: { attemptId: id } })).type).toBe('APPROVE_ENTRY');
  });

  it('REJECT_ENTRY → REJECTED(종착), 이후 토큰 없는 재접속은 새 세션을 받지 못한다', async () => {
    const exam = await runningExam();
    const res = await confirm(body(exam));
    const id = res.body.attempt.id;
    expect((await act(id, { type: 'REJECT_ENTRY', reason: '명단 확인 불가' })).status).toBe(200);
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id } })).state).toBe('REJECTED');
    const again = await confirm(body(exam));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ATTEMPT_FINISHED');
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id } })).pendingTokenHash).toBeNull();
    // 같은 토큰으로는 종료 화면을 볼 수 있다(새 세션 발급이 아님)
    const same = await confirm(body(exam, { sessionToken: res.body.sessionToken }));
    expect(same.status).toBe(200);
    expect(same.body.attempt.state).toBe('REJECTED');
  });

  it('lockNewEntry가 켜지면 RUNNING 신규 입장은 403 ENTRY_CLOSED, 응시는 만들어지지 않는다', async () => {
    const exam = await runningExam({ lockNewEntry: true });
    const res = await confirm(body(exam));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ENTRY_CLOSED');
    expect(await prisma.attempt.count()).toBe(0);
  });

  it('lockNewEntry는 이미 응시가 있는 학생의 이어하기·중복 접속에는 적용되지 않는다', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    await prisma.exam.update({ where: { id: exam.id }, data: { status: 'RUNNING', lockNewEntry: true, startedAt: new Date(), endsAt: new Date(Date.now() + 60_000) } });
    const resume = await confirm(body(exam, { sessionToken: first.body.sessionToken }));
    expect(resume.status).toBe(200);
    expect(resume.body.attempt.id).toBe(first.body.attempt.id);
    expect((await confirm(body(exam))).body.status).toBe('DUPLICATE_PENDING');
  });

  it('종료된 응시(SUBMITTED)는 토큰 없이는 새 세션·중복 요청을 만들지 못한다', async () => {
    const exam = await runningExam();
    const first = await confirm(body(exam));
    await prisma.attempt.update({ where: { id: first.body.attempt.id }, data: { state: 'SUBMITTED' } });
    const res = await confirm(body(exam));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTEMPT_FINISHED');
    expect(staffEvents('approval:pending')).toHaveLength(1); // 최초 LATE 요청만
  });

  it('DRAFT·ENDED 시험은 403 EXAM_NOT_ENTERABLE', async () => {
    const exam = await makeExam({ ownerId, status: 'ENDED' });
    const res = await confirm(body(exam));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EXAM_NOT_ENTERABLE');
  });

  it('틀린 비밀번호·명단 밖 학번·없는 시험은 401 ENTRY_FAILED, 응시가 생기지 않는다', async () => {
    const exam = await openExam();
    for (const b of [body(exam, { passcode: '000000' }), body(exam, { studentNo: '99999999' }), { ...body(exam), examCode: 'ZZZZZZZZ' }]) {
      const res = await confirm(b);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('ENTRY_FAILED');
    }
    expect(await prisma.attempt.count()).toBe(0);
  });

  it('confirm의 실패도 입장 실패 한도에 센다', async () => {
    const limited = makeApp({ windowMs: 60_000, max: 2, maxKeys: 100 });
    const exam = await openExam();
    for (let i = 0; i < 2; i++) expect((await confirm(body(exam, { passcode: '000000' }), limited)).status).toBe(401);
    expect((await confirm(body(exam, { passcode: '000000' }), limited)).status).toBe(429);
  });

  it('유효한 세션(대기) 토큰이 있으면 비밀번호가 재발급되어도 이어하기·승인 대기 확인이 된다', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    await prisma.exam.update({ where: { id: exam.id }, data: { passcode: '654321' } });
    const resume = await confirm(body(exam, { sessionToken: first.body.sessionToken }));
    expect(resume.status).toBe(200);
    expect(resume.body.attempt.id).toBe(first.body.attempt.id);
    // 토큰이 없으면 옛 비밀번호는 거부된다
    expect((await confirm(body(exam))).status).toBe(401);
  });

  it('입력 검증: 객체·배열·긴 sessionToken(129자)은 400', async () => {
    const exam = await openExam();
    const bad: Record<string, unknown>[] = [
      body(exam, { examCode: { a: 1 } }),
      body(exam, { studentNo: ['20260001'] }),
      body(exam, { passcode: { $gt: '' } }),
      body(exam, { sessionToken: { x: 1 } }),
      body(exam, { sessionToken: ['a'] }),
      body(exam, { sessionToken: 'a'.repeat(129) }),
      body(exam, { sessionToken: 'a\u0000b' }),
    ];
    for (const b of bad) expect((await confirm(b)).status, JSON.stringify(b)).toBe(400);
    expect((await confirm(body(exam, { sessionToken: 'a'.repeat(128) }))).status).toBe(200);
  });

  it('같은 학생의 동시 confirm 12건에서도 응시는 1개만 생긴다', async () => {
    const exam = await openExam();
    const results = await Promise.all(Array.from({ length: 12 }, () => confirm(body(exam))));
    expect(await prisma.attempt.count({ where: { examId: exam.id } })).toBe(1);
    expect(results.filter((r) => typeof r.body.sessionToken === 'string')).toHaveLength(1);
    expect(results.filter((r) => r.body.status === 'DUPLICATE_PENDING')).toHaveLength(1);
    const rest = results.filter((r) => r.status === 409);
    expect(rest).toHaveLength(10);
    for (const r of rest) expect(r.body.error.code).toBe('APPROVAL_ALREADY_PENDING');
    expect(staffEvents('approval:pending').filter((e) => (e.payload as { kind: string }).kind === 'DUPLICATE')).toHaveLength(1);
    expect((await prisma.attempt.findFirstOrThrow({ where: { examId: exam.id } })).pendingTokenHash).not.toBeNull();
  }, 30_000);

  it('프로세스 내 줄 세우기 없이 DB 잠금만으로도 동시 생성이 1개로 수렴한다(서버 여러 대 가정)', async () => {
    const exam = await openExam();
    const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: exam.id, studentNo: '20260001' } });
    const verified = { exam, roster, viaPasscode: true };
    const outs = await Promise.allSettled(Array.from({ length: 6 }, () => confirmOnce(verified, undefined)));
    expect(await prisma.attempt.count({ where: { examId: exam.id } })).toBe(1);
    const ok = outs.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));
    const rejected = outs.flatMap((o) => (o.status === 'rejected' ? [o.reason as { code?: string }] : []));
    // 하나는 응시 생성, 하나만 대기 요청 생성(DB 잠금 안에서), 나머지는 409
    expect(ok.filter((o) => o.result.kind === 'session')).toHaveLength(1);
    expect(ok.filter((o) => o.result.kind === 'pending')).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.code).toBe('APPROVAL_ALREADY_PENDING');
    expect(ok.flatMap((o) => o.post)).toHaveLength(2); // 생성 알림(waitingCount) 1 + DUPLICATE 알림 1
  }, 30_000);

  it('RUNNING에서 같은 학생의 동시 confirm도 응시 1개, LATE 요청 1건', async () => {
    const exam = await runningExam();
    const results = await Promise.all(Array.from({ length: 8 }, () => confirm(body(exam))));
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2); // 생성 1 + 대기 요청 1, 나머지는 409
    expect(await prisma.attempt.count({ where: { examId: exam.id } })).toBe(1);
    expect(staffEvents('approval:pending').filter((e) => (e.payload as { kind: string }).kind === 'LATE')).toHaveLength(1);
    expect(staffEvents('approval:pending').filter((e) => (e.payload as { kind: string }).kind === 'DUPLICATE')).toHaveLength(1);
  }, 30_000);
});

describe('GET /api/student/attempt', () => {
  it('Bearer 토큰이 없거나 틀리면 401(쿠키·쿼리로는 인증되지 않는다)', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    expect((await request(app).get('/api/student/attempt')).status).toBe(401);
    expect((await me('wrong')).status).toBe(401);
    expect((await me('a'.repeat(200))).status).toBe(401);
    expect((await request(app).get(`/api/student/attempt?sessionToken=${first.body.sessionToken}`)).status).toBe(401);
    expect((await request(app).get('/api/student/attempt').set('Cookie', `sessionToken=${first.body.sessionToken}`)).status).toBe(401);
    expect((await request(app).get('/api/student/attempt').set('Authorization', first.body.sessionToken)).status).toBe(401);
  });

  it('상태·마감·시각·추가시간·위반 수·needs를 돌려주고 정답·비밀번호·해시는 없다', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const res = await me(first.body.sessionToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'WAITING', deadline: null, extraSeconds: 0, violationCount: 0, needs: { consent: true, env: true } });
    expect(typeof res.body.serverNow).toBe('number');
    const text = JSON.stringify(res.body);
    for (const bad of ['correctChoiceId', 'passcode', 'Hash']) expect(text).not.toContain(bad);
  });

  it('재발급 전에 입장한 학생도 재발급 뒤 200', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    await prisma.exam.update({ where: { id: exam.id }, data: { passcode: '654321' } });
    expect((await me(first.body.sessionToken)).status).toBe(200);
  });
});

describe('POST /api/attempts/:id/actions', () => {
  async function pendingLate() {
    const exam = await runningExam();
    const res = await confirm(body(exam));
    return { exam, id: res.body.attempt.id as string, token: res.body.sessionToken as string };
  }

  it('무인증·학생 토큰은 401', async () => {
    const { id, token } = await pendingLate();
    const payload = { type: 'APPROVE_ENTRY', reason: 'x' };
    expect((await request(app).post(`/api/attempts/${id}/actions`).send(payload)).status).toBe(401);
    expect((await request(app).post(`/api/attempts/${id}/actions`).set('Authorization', `Bearer ${token}`).send(payload)).status).toBe(401);
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id } })).state).toBe('PENDING_APPROVAL');
  });

  it('id가 UUID가 아니면 400, 없는 응시는 404', async () => {
    expect((await act('not-a-uuid', { type: 'APPROVE_ENTRY', reason: 'x' })).status).toBe(400);
    expect((await act('00000000-0000-4000-8000-000000000000', { type: 'APPROVE_ENTRY', reason: 'x' })).status).toBe(404);
  });

  it('지원하지 않는 type은 400 UNSUPPORTED_ACTION', async () => {
    const { id } = await pendingLate();
    for (const type of ['WARN', 'PAUSE', 'TERMINATE', 'nope']) {
      const res = await act(id, { type, reason: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNSUPPORTED_ACTION');
    }
    expect((await act(id, { type: { a: 1 }, reason: 'x' })).status).toBe(400);
    expect(await prisma.proctorAction.count()).toBe(0);
  });

  it('사유가 없거나 비었거나 공백·객체·너무 길면 400이고 상태는 그대로', async () => {
    const { id } = await pendingLate();
    for (const reason of [undefined, '', '   ', { a: 1 }, ['x'], 'a'.repeat(501), 'a\u0000b']) {
      const res = await act(id, { type: 'APPROVE_ENTRY', reason });
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id } })).state).toBe('PENDING_APPROVAL');
    expect(await prisma.proctorAction.count()).toBe(0);
    expect(staffEvents('approval:resolved')).toHaveLength(0);
  });

  it('상태가 맞지 않으면 409이고 기록·이벤트가 없다', async () => {
    const exam = await openExam();
    const first = await confirm(body(exam));
    const id = first.body.attempt.id;
    emitted.length = 0;
    for (const type of ['APPROVE_ENTRY', 'REJECT_ENTRY', 'APPROVE_SESSION', 'REJECT_SESSION']) {
      expect((await act(id, { type, reason: 'x' })).status, type).toBe(409);
    }
    expect(await prisma.proctorAction.count()).toBe(0);
    expect(emitted).toHaveLength(0);
    expect((await me(first.body.sessionToken)).status).toBe(200);
  });

  it('같은 승인을 두 번 동시에 보내면 하나만 성공하고 ProctorAction은 1건', async () => {
    const { id } = await pendingLate();
    const rs = await Promise.all([1, 2, 3, 4].map(() => act(id, { type: 'APPROVE_ENTRY', reason: '현장 확인 완료' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma.proctorAction.count({ where: { attemptId: id } })).toBe(1);
  });

  it('ENDED 시험의 승인 대기 응시(이미 REJECTED)는 409', async () => {
    const { id, exam } = await pendingLate();
    await prisma.exam.update({ where: { id: exam.id }, data: { status: 'ENDED' } });
    await prisma.attempt.update({ where: { id }, data: { state: 'REJECTED' } });
    expect((await act(id, { type: 'APPROVE_ENTRY', reason: 'x' })).status).toBe(409);
  });
});
