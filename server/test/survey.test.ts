import { Prisma, type Attempt, type Exam } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { buildSurveySummary } from '../src/routes/results';
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
const reverse = <T>(xs: T[]): T[] => [...xs].reverse();

async function student(state: Attempt['state'] = 'SUBMITTED', examIn?: Exam, studentNo = '20260001') {
  const exam = examIn ?? (await makeExam({ status: 'ENDED' }));
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: exam.id, studentNo } });
  const token = generateToken();
  const attempt = await prisma.attempt.create({ data: { examId: exam.id, rosterEntryId: roster.id, state, sessionTokenHash: hashToken(token), questionOrder: [], choiceOrders: {} } });
  return { exam, attempt, token };
}
const post = (token: string, body: unknown) => request(app).post('/api/student/survey').set('Authorization', `Bearer ${token}`).send(body as object);
const done = async (id: string) => (await prisma.attempt.findUniqueOrThrow({ where: { id } })).surveyDone;

describe('buildSurveySummary', () => {
  it('shuffle 함수가 comments 순서를 결정한다(역순 주입)', () => {
    const rows = [{ difficulty: 1, comment: 'a' }, { difficulty: 2, comment: 'b' }, { difficulty: null, comment: 'c' }];
    expect(buildSurveySummary(rows, reverse).comments).toEqual(['c', 'b', 'a']);
  });
  it('분포·평균(소수 둘째 자리), 빈 의견은 제외', () => {
    const s = buildSurveySummary([{ difficulty: 2, comment: null }, { difficulty: 4, comment: '' }, { difficulty: 4, comment: 'x' }], (x) => x);
    expect(s).toEqual({ count: 3, distribution: [0, 1, 0, 2, 0], average: 3.33, comments: ['x'] });
  });
  it('응답이 없으면 average null', () => {
    expect(buildSurveySummary([], (x) => x)).toEqual({ count: 0, distribution: [0, 0, 0, 0, 0], average: null, comments: [] });
  });
});

describe('SurveyResponse 스키마(G4)', () => {
  it('컬럼은 id, examId, difficulty, comment뿐이다(응시·학생·시각 없음)', () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'SurveyResponse')!;
    expect(model.fields.map((f) => f.name).sort()).toEqual(['comment', 'difficulty', 'exam', 'examId', 'id']);
    expect(model.fields.some((f) => f.type === 'DateTime' || /attempt|student|roster|time|at$/i.test(f.name))).toBe(false);
  });
});

describe('POST /api/student/survey', () => {
  it('인증 없음·잘못된 토큰 401', async () => {
    expect((await request(app).post('/api/student/survey').send({ difficulty: 3 })).status).toBe(401);
    expect((await post('nope', { difficulty: 3 })).status).toBe(401);
  });

  it('제출 전(WAITING·ACTIVE·PAUSED) 상태는 409', async () => {
    for (const state of ['WAITING', 'ACTIVE', 'PAUSED'] as const) {
      await resetDb();
      const { token, attempt } = await student(state);
      const res = await post(token, { difficulty: 3 });
      expect(res.status, state).toBe(409);
      expect(res.body.error.code).toBe('NOT_SUBMITTED');
      expect(await done(attempt.id)).toBe(false);
      expect(await prisma.surveyResponse.count()).toBe(0);
    }
  });

  it('SUBMITTED·TERMINATED는 저장되고 두 번째는 409 ALREADY_SUBMITTED', async () => {
    for (const state of ['SUBMITTED', 'TERMINATED'] as const) {
      await resetDb();
      const { token, attempt, exam } = await student(state);
      const res = await post(token, { difficulty: 4, comment: '줄바꿈\n허용' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const rows = await prisma.surveyResponse.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ examId: exam.id, difficulty: 4, comment: '줄바꿈\n허용' });
      expect(await done(attempt.id)).toBe(true);
      const again = await post(token, { difficulty: 1 });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('ALREADY_SUBMITTED');
      expect(await prisma.surveyResponse.count()).toBe(1);
    }
  });

  it('둘 다 비어 있으면 행을 만들지 않고 surveyDone만 true(건너뛰기)', async () => {
    for (const body of [{}, { comment: '' }, { comment: '   ' }]) {
      await resetDb();
      const { token, attempt } = await student();
      expect((await post(token, body)).status).toBe(200);
      expect(await prisma.surveyResponse.count()).toBe(0);
      expect(await done(attempt.id)).toBe(true);
    }
  });

  it('잘못된 입력은 400이고 surveyDone이 바뀌지 않는다', async () => {
    const { token, attempt } = await student();
    const bad = [{ difficulty: 0 }, { difficulty: 6 }, { difficulty: 2.5 }, { difficulty: '3' }, { difficulty: null }, { comment: 'x'.repeat(1001) }, { comment: 'a\u0000b' }, { comment: '\ud800' }, { comment: 5 }, { difficulty: 3, attemptId: 'x' }, []];
    for (const b of bad) expect((await post(token, b)).status, JSON.stringify(b)).toBe(400);
    expect(await done(attempt.id)).toBe(false);
    expect((await post(token, { comment: 'x'.repeat(1000) })).status).toBe(200);
  });

  it('동시 이중 제출에도 응답 행은 1개', async () => {
    const { token } = await student();
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(token, { difficulty: 5, comment: '동시' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_SUBMITTED')).toBe(true);
    expect(await prisma.surveyResponse.count()).toBe(1);
  });

  it('응답·저장 행에 학생·응시 정보가 없다', async () => {
    const { token, attempt } = await student();
    const res = await post(token, { difficulty: 2, comment: 'c' });
    expect(JSON.stringify(res.body)).not.toContain(attempt.id);
    expect(JSON.stringify(await prisma.surveyResponse.findFirstOrThrow())).not.toContain(attempt.id);
  });
});

describe('GET /api/exams/:id/survey', () => {
  it('교수자 전용, 잘못된 id 400, 없는 시험 404', async () => {
    const staff = await makeStaff();
    const exam = await makeExam({ ownerId: staff.id, status: 'ENDED' });
    expect((await request(app).get(`/api/exams/${exam.id}/survey`)).status).toBe(401);
    const { token } = await student('SUBMITTED', exam);
    expect((await request(app).get(`/api/exams/${exam.id}/survey`).set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/api/exams/x/survey').set('Cookie', staffCookie(staff.id))).status).toBe(400);
    expect((await request(app).get(`/api/exams/${UNKNOWN}/survey`).set('Cookie', staffCookie(staff.id))).status).toBe(404);
  });

  it('요약을 돌려주고 의견은 요청마다 섞인다(작성 순서·시각 정보 없음)', async () => {
    const staff = await makeStaff();
    const exam = await makeExam({ ownerId: staff.id, status: 'ENDED' });
    const comments = Array.from({ length: 12 }, (_, i) => `의견${i}`);
    for (const [i, c] of comments.entries()) await prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: (i % 5) + 1, comment: c } });
    const get = () => request(app).get(`/api/exams/${exam.id}/survey`).set('Cookie', staffCookie(staff.id));
    const res = await get();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['average', 'comments', 'count', 'distribution']);
    expect(res.body.count).toBe(12);
    expect(res.body.distribution).toEqual([3, 3, 2, 2, 2]);
    expect(res.body.average).toBe(2.75);
    expect([...res.body.comments].sort()).toEqual([...comments].sort());
    const orders = new Set<string>();
    for (let i = 0; i < 8; i++) orders.add(JSON.stringify((await get()).body.comments));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('설문과 제출·시험 잠금의 교착 방지', () => {
  it('설문 제출과 같은 응시의 submitAttempt를 동시에 반복해도 500·BUSY가 나지 않고 응답 행은 최대 1개', async () => {
    const { submitAttempt } = await import('../src/services/submission');
    const exam = await makeExam({ status: 'ENDED' });
    for (let i = 0; i < 25; i++) {
      await prisma.surveyResponse.deleteMany();
      await prisma.attempt.deleteMany();
      const { token, attempt } = await student('SUBMITTED', exam);
      const [survey, ...subs] = await Promise.allSettled([
        post(token, { difficulty: 3, comment: `c${i}` }),
        submitAttempt(attempt.id, 'STUDENT'),
        submitAttempt(attempt.id, 'STUDENT'),
        submitAttempt(attempt.id, 'EXAM_ENDED'),
      ]);
      expect(survey.status).toBe('fulfilled');
      if (survey.status === 'fulfilled') expect(survey.value.status, `round ${i}`).toBe(200);
      for (const s of subs) expect(s.status, `round ${i}: ${s.status === 'rejected' ? String(s.reason) : ''}`).toBe('fulfilled');
      expect(await prisma.surveyResponse.count()).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
