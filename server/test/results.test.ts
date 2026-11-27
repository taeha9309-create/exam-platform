import type { Attempt, Exam, Question } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';

const app = createApp();
beforeAll(async () => {
  await Promise.all(Array.from({ length: 6 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(resetDb);

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

interface Fx {
  exam: Exam;
  staffId: string;
  mcq: Question; // c1 정답, 2점
  essay: Question; // 5점
  noKey: Question; // 정답 없는 객관식, 4점
}

async function fixture(): Promise<Fx> {
  const staff = await makeStaff();
  const exam = await makeExam({ ownerId: staff.id, status: 'ENDED', passcode: 'ZQXJ42' });
  await prisma.question.create({ data: { examId: exam.id, position: 2, type: 'MCQ', prompt: '정답 없음', points: 4, choices: [{ id: 'e1', text: 'a' }, { id: 'e2', text: 'b' }] } });
  const qs = await prisma.question.findMany({ where: { examId: exam.id }, orderBy: { position: 'asc' } });
  return { exam, staffId: staff.id, mcq: qs[0]!, essay: qs[1]!, noKey: qs[2]! };
}

async function mkAttempt(f: Fx, studentNo: string, state: Attempt['state']) {
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: f.exam.id, studentNo } });
  const token = generateToken();
  const attempt = await prisma.attempt.create({
    data: { examId: f.exam.id, rosterEntryId: roster.id, state, sessionTokenHash: hashToken(token), pendingTokenHash: hashToken(generateToken()), questionOrder: [], choiceOrders: {} },
  });
  return { attempt, token };
}

const results = (f: Fx) => request(app).get(`/api/exams/${f.exam.id}/results`).set('Cookie', staffCookie(f.staffId));
const grade = (f: Fx, id: string, body: unknown) => request(app).put(`/api/answers/${id}/grade`).set('Cookie', staffCookie(f.staffId)).send(body as object);

describe('GET /api/exams/:id/results', () => {
  it('무인증 401, 잘못된 id 400, 없는 시험 404', async () => {
    const f = await fixture();
    expect((await request(app).get(`/api/exams/${f.exam.id}/results`)).status).toBe(401);
    expect((await request(app).get('/api/exams/not-a-uuid/results').set('Cookie', staffCookie(f.staffId))).status).toBe(400);
    const none = await request(app).get(`/api/exams/${UNKNOWN}/results`).set('Cookie', staffCookie(f.staffId));
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('NOT_FOUND');
  });

  it('학생 토큰으로는 401', async () => {
    const f = await fixture();
    const { token } = await mkAttempt(f, '20260001', 'SUBMITTED');
    const res = await request(app).get(`/api/exams/${f.exam.id}/results`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('서술형 미채점이면 essayScore·total null, 채점 후 합. 정답 없는 객관식은 0점', async () => {
    const f = await fixture();
    const { attempt: a } = await mkAttempt(f, '20260001', 'SUBMITTED');
    await prisma.answer.create({ data: { attemptId: a.id, questionId: f.mcq.id, choiceId: 'c1', awardedPoints: 2 } });
    const essay = await prisma.answer.create({ data: { attemptId: a.id, questionId: f.essay.id, text: '답' } });
    await prisma.answer.create({ data: { attemptId: a.id, questionId: f.noKey.id, choiceId: 'e1' } }); // awardedPoints null
    const r1 = await results(f);
    expect(r1.status).toBe(200);
    expect(r1.body.rows).toHaveLength(1);
    expect(r1.body.rows[0]).toMatchObject({ attemptId: a.id, studentNo: '20260001', name: '학생1', state: 'SUBMITTED', mcqScore: 2, essayScore: null, total: null, actionCount: 0 });
    expect(r1.body.rows[0].signalCounts).toEqual({ INFO: 0, WARN: 0, ALERT: 0 });

    expect((await grade(f, essay.id, { points: 3 })).status).toBe(200);
    expect((await results(f)).body.rows[0]).toMatchObject({ mcqScore: 2, essayScore: 3, total: 5 });
  });

  it('서술형 문항에 답안 행이 없는 미답은 0점으로 본다', async () => {
    const f = await fixture();
    await mkAttempt(f, '20260001', 'SUBMITTED');
    expect((await results(f)).body.rows[0]).toMatchObject({ mcqScore: 0, essayScore: 0, total: 0 });
  });

  it('제출 전 응시는 총점·서술형 점수가 null이고 객관식은 0', async () => {
    const f = await fixture();
    const { attempt: a } = await mkAttempt(f, '20260001', 'ACTIVE');
    await prisma.answer.create({ data: { attemptId: a.id, questionId: f.mcq.id, choiceId: 'c1' } });
    expect((await results(f)).body.rows[0]).toMatchObject({ state: 'ACTIVE', mcqScore: 0, essayScore: null, total: null });
  });

  it('신호 severity별 개수·조치 수. 정답·토큰 해시·passcode는 응답에 없다', async () => {
    const f = await fixture();
    const { attempt: a } = await mkAttempt(f, '20260001', 'SUBMITTED');
    await prisma.answer.create({ data: { attemptId: a.id, questionId: f.mcq.id, choiceId: 'c1', awardedPoints: 2 } });
    await prisma.signal.createMany({
      data: [
        { attemptId: a.id, type: 'FULLSCREEN_EXIT', severity: 'WARN' },
        { attemptId: a.id, type: 'FULLSCREEN_EXIT', severity: 'WARN' },
        { attemptId: a.id, type: 'FULLSCREEN_EXIT', severity: 'ALERT' },
      ],
    });
    await prisma.proctorAction.create({ data: { attemptId: a.id, type: 'WARN', reason: '경고' } });
    const res = await results(f);
    expect(res.body.rows[0].signalCounts).toEqual({ INFO: 0, WARN: 2, ALERT: 1 });
    expect(res.body.rows[0].actionCount).toBe(1);
    expect(res.body.rows[0].answers).toEqual([{ answerId: expect.any(String), questionId: f.mcq.id, choiceId: 'c1', awardedPoints: 2 }]);
    expect(res.body.questions[0]).toEqual({ id: f.mcq.id, type: 'MCQ', points: 2, position: 0 });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(a.sessionTokenHash);
    expect(json).not.toContain(a.pendingTokenHash!);
    expect(json).not.toMatch(/TokenHash|passcode|ZQXJ42|correctChoiceId/);
  });

  it('응시자가 많아도 DB 호출 수가 일정하다(N+1 없음)', async () => {
    const f = await fixture();
    const roster = Array.from({ length: 25 }, (_, i) => ({ examId: f.exam.id, studentNo: `3${String(i).padStart(7, '0')}`, name: `n${i}` }));
    await prisma.rosterEntry.createMany({ data: roster });
    for (const r of roster) {
      const { attempt } = await mkAttempt(f, r.studentNo, 'SUBMITTED');
      await prisma.answer.create({ data: { attemptId: attempt.id, questionId: f.essay.id, text: 'x', awardedPoints: 1 } });
    }
    const spies = [
      vi.spyOn(prisma.exam, 'findUnique'),
      vi.spyOn(prisma.question, 'findMany'),
      vi.spyOn(prisma.attempt, 'findMany'),
      vi.spyOn(prisma.answer, 'findMany'),
      vi.spyOn(prisma.signal, 'groupBy'),
      vi.spyOn(prisma.proctorAction, 'groupBy'),
    ];
    try {
      const res = await results(f);
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(25);
      expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBeLessThanOrEqual(6);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('PUT /api/answers/:id/grade', () => {
  async function essayAnswer(state: Attempt['state'] = 'SUBMITTED') {
    const f = await fixture();
    const { attempt: a, token } = await mkAttempt(f, '20260001', state);
    const ans = await prisma.answer.create({ data: { attemptId: a.id, questionId: f.essay.id, text: '서술' } });
    const mcq = await prisma.answer.create({ data: { attemptId: a.id, questionId: f.mcq.id, choiceId: 'c1', awardedPoints: 2 } });
    return { f, a, token, ans, mcq };
  }
  const stored = async (id: string) => (await prisma.answer.findUniqueOrThrow({ where: { id } })).awardedPoints;

  it('무인증·학생 토큰은 401', async () => {
    const { ans, token } = await essayAnswer();
    expect((await request(app).put(`/api/answers/${ans.id}/grade`).send({ points: 1 })).status).toBe(401);
    expect((await request(app).put(`/api/answers/${ans.id}/grade`).set('Authorization', `Bearer ${token}`).send({ points: 1 })).status).toBe(401);
    expect(await stored(ans.id)).toBeNull();
  });

  it('id 형식 400, 없는 답안 404', async () => {
    const { f } = await essayAnswer();
    expect((await grade(f, 'abc', { points: 1 })).status).toBe(400);
    const res = await grade(f, UNKNOWN, { points: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('정상 채점과 재채점(덮어쓰기), 경계값 0과 배점', async () => {
    const { f, ans } = await essayAnswer();
    expect((await grade(f, ans.id, { points: 5 })).body).toEqual({ answerId: ans.id, awardedPoints: 5 });
    expect(await stored(ans.id)).toBe(5);
    expect((await grade(f, ans.id, { points: 0 })).status).toBe(200);
    expect(await stored(ans.id)).toBe(0);
  });

  it('배점 초과·음수·소수·문자열·거대 수·null·추가 필드·빈 본문은 400', async () => {
    const { f, ans } = await essayAnswer();
    for (const body of [{ points: 6 }, { points: -1 }, { points: 1.5 }, { points: '3' }, { points: 1e30 }, { points: null }, {}, { points: 1, extra: 1 }, [], { points: [1] }]) {
      const res = await grade(f, ans.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await stored(ans.id)).toBeNull();
  });

  it('객관식 답안은 400', async () => {
    const { f, mcq } = await essayAnswer();
    const res = await grade(f, mcq.id, { points: 1 });
    expect(res.status).toBe(400);
    expect(await stored(mcq.id)).toBe(2);
  });

  it('제출 전(ACTIVE·PAUSED) 응시의 답안은 409', async () => {
    for (const state of ['ACTIVE', 'PAUSED'] as const) {
      await resetDb();
      const { f, ans } = await essayAnswer(state);
      const res = await grade(f, ans.id, { points: 1 });
      expect(res.status, state).toBe(409);
      expect(res.body.error.code).toBe('NOT_SUBMITTED');
      expect(await stored(ans.id)).toBeNull();
    }
  });

  it('TERMINATED 응시는 채점할 수 있다', async () => {
    const { f, ans } = await essayAnswer('TERMINATED');
    expect((await grade(f, ans.id, { points: 2 })).status).toBe(200);
  });

  it('동시 채점은 모두 성공하고 값 하나가 일관되게 남는다', async () => {
    const { f, ans } = await essayAnswer();
    const rs = await Promise.all([1, 2, 3, 4, 5].map((p) => grade(f, ans.id, { points: p })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect([1, 2, 3, 4, 5]).toContain(await stored(ans.id));
  });
});
