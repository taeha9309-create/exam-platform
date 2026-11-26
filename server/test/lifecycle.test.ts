import type { AttemptState, Exam } from '@prisma/client';
import type { Server } from 'socket.io';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { setIo } from '../src/realtime/broadcast';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';

const app = createApp();
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let cookie: string;
let ownerId: string;

const post = (path: string) => request(app).post(path).set('Cookie', cookie);

beforeEach(async () => {
  await resetDb();
  const staff = await makeStaff({ name: '김교수' });
  ownerId = staff.id;
  cookie = staffCookie(staff.id);
});

let attemptSeq = 0;
/** 명단의 학번(studentNo) 학생의 응시를 만든다. ready=false면 동의·환경 점검 전 */
async function makeAttempt(examId: string, studentNo: string, state: AttemptState, opts: { ready?: boolean } = {}) {
  attemptSeq += 1;
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId, studentNo } });
  const ready = opts.ready ?? true;
  return prisma.attempt.create({
    data: {
      examId,
      rosterEntryId: roster.id,
      state,
      sessionTokenHash: `hash-${attemptSeq}-${Date.now()}`,
      questionOrder: [],
      choiceOrders: {},
      consentAt: ready ? new Date() : null,
      envCheckedAt: ready ? new Date() : null,
    },
  });
}

const examOf = (id: string): Promise<Exam> => prisma.exam.findUniqueOrThrow({ where: { id } });
const attemptOf = (id: string) => prisma.attempt.findUniqueOrThrow({ where: { id } });

describe('인증', () => {
  it('인증 없는 요청·학생 토큰은 모든 운영 라우트에서 401', async () => {
    const exam = await makeExam({ ownerId });
    for (const action of ['open', 'passcode', 'start', 'end']) {
      expect((await request(app).post(`/api/exams/${exam.id}/${action}`)).status).toBe(401);
      expect((await request(app).post(`/api/exams/${exam.id}/${action}`).set('Authorization', 'Bearer student-token')).status).toBe(401);
    }
    expect((await examOf(exam.id)).status).toBe('DRAFT');
  });
});

describe('POST /api/exams/:id/open', () => {
  it('문항이 없는 시험은 409 NOT_READY_TO_OPEN', async () => {
    const exam = await makeExam({ ownerId });
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    const res = await post(`/api/exams/${exam.id}/open`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_READY_TO_OPEN');
    expect((await examOf(exam.id)).status).toBe('DRAFT');
  });

  it('명단이 없는 시험은 409 NOT_READY_TO_OPEN', async () => {
    const exam = await makeExam({ ownerId });
    await prisma.rosterEntry.deleteMany({ where: { examId: exam.id } });
    const res = await post(`/api/exams/${exam.id}/open`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_READY_TO_OPEN');
  });

  it('열면 OPEN 상태와 6자리 숫자 passcode가 생긴다', async () => {
    const exam = await makeExam({ ownerId });
    const res = await post(`/api/exams/${exam.id}/open`);
    expect(res.status).toBe(200);
    expect(res.body.exam.status).toBe('OPEN');
    expect(res.body.exam.passcode).toMatch(/^\d{6}$/);
    expect((await examOf(exam.id)).passcode).toBe(res.body.exam.passcode);
  });

  it('이미 열린 시험을 다시 열면 409 INVALID_TRANSITION이고 passcode는 그대로', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456' });
    const res = await post(`/api/exams/${exam.id}/open`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect((await examOf(exam.id)).passcode).toBe('123456');
  });

  it('없는 시험은 404, 형식이 틀린 id는 400', async () => {
    expect((await post(`/api/exams/${MISSING_ID}/open`)).status).toBe(404);
    expect((await post('/api/exams/not-a-uuid/open')).status).toBe(400);
  });
});

describe('POST /api/exams/:id/passcode', () => {
  it('OPEN 상태에서 재발급하면 값이 바뀐다', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '000000' });
    let previous = '000000';
    for (let i = 0; i < 3; i++) {
      const res = await post(`/api/exams/${exam.id}/passcode`);
      expect(res.status).toBe(200);
      expect(res.body.passcode).toMatch(/^\d{6}$/);
      expect(res.body.passcode).not.toBe(previous); // 직전 값과 다르게 보장
      expect((await examOf(exam.id)).passcode).toBe(res.body.passcode);
      previous = res.body.passcode;
    }
  });

  it('RUNNING에서도 재발급되고 입장한 학생의 응시는 그대로다', async () => {
    const exam = await makeExam({ ownerId, status: 'RUNNING', passcode: '111111', startedAt: new Date(), endsAt: new Date(Date.now() + 60_000) });
    const attempt = await makeAttempt(exam.id, '20260001', 'ACTIVE');
    const res = await post(`/api/exams/${exam.id}/passcode`);
    expect(res.status).toBe(200);
    expect(res.body.passcode).not.toBe('111111');
    expect((await attemptOf(attempt.id)).state).toBe('ACTIVE');
  });

  it.each(['DRAFT', 'ENDED'] as const)('%s 상태에서는 409 INVALID_TRANSITION', async (status) => {
    const exam = await makeExam({ ownerId, status });
    const res = await post(`/api/exams/${exam.id}/passcode`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('없는 시험은 404', async () => {
    expect((await post(`/api/exams/${MISSING_ID}/passcode`)).status).toBe(404);
  });

  it('재발급 후 이전 비밀번호로 /api/student/entry → 401, 새 비밀번호는 200', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '111111' });
    const entry = (passcode: string) => request(app).post('/api/student/entry').send({ examCode: exam.examCode, studentNo: '20260001', passcode });
    expect((await entry('111111')).status).toBe(200);
    const res = await post(`/api/exams/${exam.id}/passcode`);
    expect((await entry('111111')).status).toBe(401);
    expect((await entry(res.body.passcode)).status).toBe(200);
  });

  it('재발급 전에 입장한 학생의 /api/student/attempt는 200', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '111111' });
    const confirmed = await request(app).post('/api/student/confirm').send({ examCode: exam.examCode, studentNo: '20260001', passcode: '111111' });
    expect(confirmed.status).toBe(200);
    await post(`/api/exams/${exam.id}/passcode`);
    const res = await request(app).get('/api/student/attempt').set('Authorization', `Bearer ${confirmed.body.sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('WAITING');
  });
});

describe('POST /api/exams/:id/start', () => {
  it('RUNNING이 되고 startedAt·endsAt(= startedAt + durationMin)이 설정된다', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456', durationMin: 30 });
    const res = await post(`/api/exams/${exam.id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.exam.status).toBe('RUNNING');
    const saved = await examOf(exam.id);
    expect(saved.startedAt).not.toBeNull();
    expect(saved.endsAt!.getTime() - saved.startedAt!.getTime()).toBe(30 * 60_000);
  });

  it('준비 완료된 WAITING은 ACTIVE, 미준비 WAITING·PENDING_APPROVAL은 그대로', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456' });
    const ready = await makeAttempt(exam.id, '20260001', 'WAITING', { ready: true });
    const notReady = await makeAttempt(exam.id, '20260002', 'WAITING', { ready: false });
    const pending = await makeAttempt(exam.id, '20260003', 'PENDING_APPROVAL', { ready: true });
    expect((await post(`/api/exams/${exam.id}/start`)).status).toBe(200);
    expect((await attemptOf(ready.id)).state).toBe('ACTIVE');
    expect((await attemptOf(notReady.id)).state).toBe('WAITING');
    expect((await attemptOf(pending.id)).state).toBe('PENDING_APPROVAL');
  });

  it('동시에 두 번 시작하면 하나는 200, 하나는 409 ALREADY_STARTED이고 endsAt은 한 번만 설정된다', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456' });
    const attempt = await makeAttempt(exam.id, '20260001', 'WAITING');
    const [a, b] = await Promise.all([post(`/api/exams/${exam.id}/start`), post(`/api/exams/${exam.id}/start`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body.error.code).toBe('ALREADY_STARTED');
    const saved = await examOf(exam.id);
    expect(saved.endsAt!.toISOString()).toBe(winner.body.exam.endsAt);
    expect(saved.startedAt!.toISOString()).toBe(winner.body.exam.startedAt);
    expect((await attemptOf(attempt.id)).state).toBe('ACTIVE');
  });

  it('이미 시작된 시험은 409 ALREADY_STARTED이고 endsAt이 바뀌지 않는다', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const exam = await makeExam({ ownerId, status: 'RUNNING', startedAt: new Date(), endsAt });
    const res = await post(`/api/exams/${exam.id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_STARTED');
    expect((await examOf(exam.id)).endsAt!.getTime()).toBe(endsAt.getTime());
  });

  it('DRAFT·ENDED는 409 INVALID_TRANSITION, 없는 시험은 404', async () => {
    const draft = await makeExam({ ownerId });
    const ended = await makeExam({ ownerId, status: 'ENDED' });
    for (const e of [draft, ended]) {
      const res = await post(`/api/exams/${e.id}/start`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    }
    expect((await post(`/api/exams/${MISSING_ID}/start`)).status).toBe(404);
  });
});

describe('POST /api/exams/:id/end', () => {
  const running = () => ({ status: 'RUNNING' as const, startedAt: new Date(), endsAt: new Date(Date.now() + 60_000) });

  it('ENDED가 되고 ACTIVE·WAITING은 SUBMITTED/EXAM_ENDED, PENDING_APPROVAL은 REJECTED', async () => {
    const exam = await makeExam({ ownerId, ...running() });
    const active = await makeAttempt(exam.id, '20260001', 'ACTIVE');
    const waiting = await makeAttempt(exam.id, '20260002', 'WAITING');
    const pending = await makeAttempt(exam.id, '20260003', 'PENDING_APPROVAL');
    const res = await post(`/api/exams/${exam.id}/end`);
    expect(res.status).toBe(200);
    expect(res.body.exam.status).toBe('ENDED');
    expect((await examOf(exam.id)).endedAt).not.toBeNull();
    for (const id of [active.id, waiting.id]) {
      const a = await attemptOf(id);
      expect(a.state).toBe('SUBMITTED');
      expect(a.submitReason).toBe('EXAM_ENDED');
      expect(a.submittedAt).not.toBeNull();
    }
    const p = await attemptOf(pending.id);
    expect(p.state).toBe('REJECTED');
    expect(p.submitReason).toBeNull();
  });

  it('이미 종착 상태인 응시는 건드리지 않는다', async () => {
    const exam = await makeExam({ ownerId, ...running() });
    const submittedAt = new Date(Date.now() - 5000);
    const a = await makeAttempt(exam.id, '20260001', 'ACTIVE');
    await prisma.attempt.update({ where: { id: a.id }, data: { state: 'SUBMITTED', submitReason: 'STUDENT', submittedAt } });
    expect((await post(`/api/exams/${exam.id}/end`)).status).toBe(200);
    const saved = await attemptOf(a.id);
    expect(saved.submitReason).toBe('STUDENT');
    expect(saved.submittedAt!.getTime()).toBe(submittedAt.getTime());
  });

  it.each(['DRAFT', 'OPEN', 'ENDED'] as const)('%s 상태에서는 409 INVALID_TRANSITION', async (status) => {
    const exam = await makeExam({ ownerId, status });
    const res = await post(`/api/exams/${exam.id}/end`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('동시에 두 번 종료하면 하나는 200, 하나는 409이고 endedAt은 한 번만 설정된다', async () => {
    const exam = await makeExam({ ownerId, ...running() });
    const [a, b] = await Promise.all([post(`/api/exams/${exam.id}/end`), post(`/api/exams/${exam.id}/end`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    expect((await examOf(exam.id)).endedAt!.toISOString()).toBe(winner.body.exam.endedAt);
  });

  it('없는 시험은 404', async () => {
    expect((await post(`/api/exams/${MISSING_ID}/end`)).status).toBe(404);
  });
});

describe('상태 전이 경쟁 (시험 행 잠금)', () => {
  it('start와 end를 동시에 보내도 결과가 직렬화된 순서와 일치한다', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456' });
    const attempt = await makeAttempt(exam.id, '20260001', 'WAITING');
    const [s, e] = await Promise.all([post(`/api/exams/${exam.id}/start`), post(`/api/exams/${exam.id}/end`)]);
    const saved = await examOf(exam.id);
    const a = await attemptOf(attempt.id);
    if (e.status === 200) {
      // start가 먼저 → end가 이어서 성공
      expect(s.status).toBe(200);
      expect(saved.status).toBe('ENDED');
      expect(a.state).toBe('SUBMITTED');
    } else {
      // end가 먼저 → OPEN 상태라 거부, start만 성공
      expect(e.status).toBe(409);
      expect(e.body.error.code).toBe('INVALID_TRANSITION');
      expect(s.status).toBe(200);
      expect(saved.status).toBe('RUNNING');
      expect(a.state).toBe('ACTIVE');
    }
  });

  it('open과 문항 교체가 동시에 와도 한쪽이 먼저 끝난 결과와 같고, 거부된 쪽은 409다', async () => {
    const exam = await makeExam({ ownerId });
    const questions = [{ type: 'ESSAY', prompt: '새 문항', points: 3 }];
    const [o, q] = await Promise.all([
      post(`/api/exams/${exam.id}/open`),
      request(app).put(`/api/exams/${exam.id}/questions`).set('Cookie', cookie).send({ questions }),
    ]);
    expect(o.status).toBe(200);
    const count = await prisma.question.count({ where: { examId: exam.id } });
    if (q.status === 200) {
      expect(count).toBe(1); // 문항 교체가 먼저 → 새 문항으로 열림
    } else {
      expect(q.status).toBe(409); // open이 먼저 → 문항 수정 거부, 기존 문항 유지
      expect(q.body.error.code).toBe('NOT_DRAFT');
      expect(count).toBe(2);
    }
    expect((await examOf(exam.id)).status).toBe('OPEN');
  });
});

describe('실시간 알림', () => {
  it('Socket.IO가 없어도 시작·종료는 성공한다(알림은 건너뜀)', async () => {
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456' });
    await makeAttempt(exam.id, '20260001', 'WAITING');
    expect((await post(`/api/exams/${exam.id}/start`)).status).toBe(200);
    expect((await post(`/api/exams/${exam.id}/end`)).status).toBe(200);
  });

  // 주의: setIo는 모듈 전역을 바꾸므로 이 파일의 마지막 테스트로 둔다.
  it('시작하면 exam:started와 각 응시의 attempt:state를, 종료하면 attempt:state를 보낸다', async () => {
    const emitted: { room: string; event: string; payload: { state?: string } }[] = [];
    const fake = {
      to: (room: string) => ({ emit: (event: string, payload: { state?: string }) => void emitted.push({ room, event, payload }) }),
    } as unknown as Server;
    setIo(fake);
    const exam = await makeExam({ ownerId, status: 'OPEN', passcode: '123456' });
    const attempt = await makeAttempt(exam.id, '20260001', 'WAITING');
    await post(`/api/exams/${exam.id}/start`);
    expect(emitted.some((m) => m.event === 'exam:started' && m.room === `exam:${exam.id}:students`)).toBe(true);
    const started = emitted.find((m) => m.event === 'attempt:state' && m.room === `attempt:${attempt.id}`);
    expect(started?.payload.state).toBe('ACTIVE');
    emitted.length = 0;
    await post(`/api/exams/${exam.id}/end`);
    const ended = emitted.find((m) => m.event === 'attempt:state' && m.room === `attempt:${attempt.id}`);
    expect(ended?.payload.state).toBe('SUBMITTED');
  });
});
