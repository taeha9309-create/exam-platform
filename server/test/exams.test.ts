import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';

const app = createApp();
const NUL = String.fromCharCode(0);
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let staff: Awaited<ReturnType<typeof makeStaff>>;
let cookie: string;

const get = (path: string) => request(app).get(path).set('Cookie', cookie);
const post = (path: string) => request(app).post(path).set('Cookie', cookie);
const put = (path: string) => request(app).put(path).set('Cookie', cookie);
const patch = (path: string) => request(app).patch(path).set('Cookie', cookie);
const del = (path: string) => request(app).delete(path).set('Cookie', cookie);

const mcq = (prompt: string, correct = 'a') => ({
  type: 'MCQ',
  prompt,
  points: 2,
  choices: [
    { id: 'a', text: '가' },
    { id: 'b', text: '나' },
  ],
  correctChoiceId: correct,
});

async function createExam(body: Record<string, unknown> = { title: '중간고사', instructions: '안내', durationMin: 60 }) {
  const res = await post('/api/exams').send(body);
  expect(res.status).toBe(201);
  return res.body.exam as { id: string };
}

beforeEach(async () => {
  await resetDb();
  staff = await makeStaff({ name: '김교수' });
  cookie = staffCookie(staff.id);
});

describe('인증', () => {
  it('인증 없는 요청은 모든 라우트에서 401', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const calls = [
      request(app).get('/api/exams'),
      request(app).post('/api/exams').send({ title: 'x', durationMin: 10 }),
      request(app).get(`/api/exams/${exam.id}`),
      request(app).patch(`/api/exams/${exam.id}`).send({ shuffle: false }),
      request(app).delete(`/api/exams/${exam.id}`),
      request(app).put(`/api/exams/${exam.id}/questions`).send({ questions: [] }),
      request(app).put(`/api/exams/${exam.id}/roster`).send({ csv: '' }),
    ];
    for (const c of calls) expect((await c).status).toBe(401);
    expect(await prisma.exam.count()).toBe(1);
  });

  it('학생 토큰(Authorization Bearer)으로는 접근할 수 없다', async () => {
    const res = await request(app).get('/api/exams').set('Authorization', 'Bearer some-student-session-token');
    expect(res.status).toBe(401);
  });
});

describe('POST/GET /api/exams', () => {
  it('생성하면 DRAFT 상태와 8자 examCode가 생긴다', async () => {
    const res = await post('/api/exams').send({ title: '  중간고사 ', instructions: '안내', durationMin: 60 });
    expect(res.status).toBe(201);
    expect(res.body.exam).toMatchObject({ status: 'DRAFT', title: '중간고사', durationMin: 60, instructions: '안내', pasteMode: 'RECORD', shuffle: true, lockNewEntry: false });
    expect(res.body.exam.examCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body.exam.ownerName).toBe('김교수');
  });

  it('목록 항목은 { id, title, status, ownerName, rosterCount, attemptCount, createdAt }', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await get('/api/exams');
    expect(res.status).toBe(200);
    expect(res.body.exams).toHaveLength(1);
    expect(res.body.exams[0]).toEqual({
      id: exam.id,
      title: '테스트 시험',
      status: 'DRAFT',
      ownerName: '김교수',
      rosterCount: 3,
      attemptCount: 0,
      createdAt: exam.createdAt.toISOString(),
    });
  });

  it('다른 교수자 계정으로도 목록·상세가 보인다(D-016)', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const other = await makeStaff({ name: '이조교' });
    const c = staffCookie(other.id);
    const list = await request(app).get('/api/exams').set('Cookie', c);
    expect(list.body.exams.map((e: { id: string }) => e.id)).toEqual([exam.id]);
    expect((await request(app).get(`/api/exams/${exam.id}`).set('Cookie', c)).status).toBe(200);
    expect((await request(app).patch(`/api/exams/${exam.id}`).set('Cookie', c).send({ title: '수정' })).status).toBe(200);
  });

  it('attemptCount는 응시 수를 센다', async () => {
    const exam = await makeExam({ ownerId: staff.id, status: 'RUNNING' });
    const entry = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: exam.id } });
    await prisma.attempt.create({ data: { examId: exam.id, rosterEntryId: entry.id, sessionTokenHash: 'h1', questionOrder: [], choiceOrders: {} } });
    const res = await get('/api/exams');
    expect(res.body.exams[0].attemptCount).toBe(1);
  });

  it('입력 검증: 400 INVALID_INPUT', async () => {
    const bad: Record<string, unknown>[] = [
      {},
      { title: '', durationMin: 10 },
      { title: '   ', durationMin: 10 },
      { title: 'a'.repeat(101), durationMin: 10 },
      { title: 'x', durationMin: 0 },
      { title: 'x', durationMin: 301 },
      { title: 'x', durationMin: 1.5 },
      { title: 'x', durationMin: '60' },
      { title: 'x', durationMin: 10, instructions: 'a'.repeat(2001) },
      { title: 'x', durationMin: 10, status: 'RUNNING' },
      { title: 'x', durationMin: 10, instructions: 5 },
    ];
    for (const body of bad) {
      const res = await post('/api/exams').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await prisma.exam.count()).toBe(0);
  });

  it('경계값(제목 100자, 안내문 2000자, 1분·300분)은 허용', async () => {
    await createExam({ title: 'a'.repeat(100), instructions: 'b'.repeat(2000), durationMin: 1 });
    await createExam({ title: 'x', durationMin: 300 });
  });

  it('NUL 문자가 든 제목·안내문은 500이 아니라 400', async () => {
    for (const body of [{ title: `a${NUL}b`, durationMin: 10 }, { title: 'x', durationMin: 10, instructions: `a${NUL}b` }, { title: 'a\nb', durationMin: 10 }, { title: 'a\ud800', durationMin: 10 }]) {
      const res = await post('/api/exams').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('안내문에는 줄바꿈이 허용된다', async () => {
    const res = await post('/api/exams').send({ title: 'x', durationMin: 10, instructions: '1줄\n2줄' });
    expect(res.status).toBe(201);
    expect(res.body.exam.instructions).toBe('1줄\n2줄');
  });

  it('본문 없는 요청은 400', async () => {
    expect((await post('/api/exams')).status).toBe(400);
  });
});

describe('GET /api/exams/:id', () => {
  it('상세에 문항(순서 포함)·명단이 들어 있다', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await get(`/api/exams/${exam.id}`);
    expect(res.status).toBe(200);
    expect(res.body.exam).toMatchObject({ id: exam.id, ownerName: '김교수', rosterCount: 3, attemptCount: 0 });
    expect(res.body.exam.questions.map((q: { position: number }) => q.position)).toEqual([0, 1]);
    expect(res.body.exam.questions[0]).toMatchObject({ type: 'MCQ', correctChoiceId: 'c1' });
    expect(res.body.exam.roster.map((r: { studentNo: string }) => r.studentNo)).toEqual(['20260001', '20260002', '20260003']);
  });

  it('없는 시험은 404 NOT_FOUND, 형식이 틀린 id는 400', async () => {
    const res = await get(`/api/exams/${MISSING_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    const bad = await get('/api/exams/not-a-uuid');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_INPUT');
    expect((await put(`/api/exams/${MISSING_ID}/questions`).send({ questions: [] })).status).toBe(404);
    expect((await put(`/api/exams/${MISSING_ID}/roster`).send({ csv: '' })).status).toBe(404);
    expect((await patch(`/api/exams/${MISSING_ID}`).send({ shuffle: false })).status).toBe(404);
    expect((await del(`/api/exams/${MISSING_ID}`)).status).toBe(404);
  });
});

describe('PUT /api/exams/:id/questions', () => {
  it('문항 순서를 바꿔 저장하면 GET이 같은 순서를 돌려준다', async () => {
    const { id } = await createExam();
    const first = await put(`/api/exams/${id}/questions`).send({ questions: [mcq('첫째'), mcq('둘째'), { type: 'ESSAY', prompt: '셋째', points: 5 }] });
    expect(first.status).toBe(200);
    const reordered = await put(`/api/exams/${id}/questions`).send({ questions: [{ type: 'ESSAY', prompt: '셋째', points: 5 }, mcq('둘째', 'b'), mcq('첫째')] });
    expect(reordered.status).toBe(200);
    const res = await get(`/api/exams/${id}`);
    expect(res.body.exam.questions.map((q: { prompt: string; position: number }) => [q.position, q.prompt])).toEqual([
      [0, '셋째'],
      [1, '둘째'],
      [2, '첫째'],
    ]);
    expect(res.body.exam.questions[1].correctChoiceId).toBe('b');
    expect(res.body.exam.questions[0]).toMatchObject({ type: 'ESSAY', choices: null, correctChoiceId: null });
    expect(await prisma.question.count({ where: { examId: id } })).toBe(3); // 전체 교체: 이전 문항이 남지 않는다
  });

  it('MCQ 보기 1개는 400이고 오류에 { index, field: choices }가 있다', async () => {
    const { id } = await createExam();
    const res = await put(`/api/exams/${id}/questions`).send({ questions: [{ ...mcq('x'), choices: [{ id: 'a', text: '가' }] }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.details).toContainEqual(expect.objectContaining({ index: 0, field: 'choices' }));
  });

  it('검증에 실패하면 기존 문항이 그대로 남는다', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await put(`/api/exams/${exam.id}/questions`).send({ questions: [mcq('ok'), { ...mcq('bad'), points: 0 }] });
    expect(res.status).toBe(400);
    expect(await prisma.question.count({ where: { examId: exam.id } })).toBe(2);
    expect((await prisma.question.findFirstOrThrow({ where: { examId: exam.id, position: 0 } })).prompt).toBe('객관식');
  });

  it('NUL이 든 지문·보기는 400', async () => {
    const { id } = await createExam();
    expect((await put(`/api/exams/${id}/questions`).send({ questions: [mcq(`a${NUL}`)] })).status).toBe(400);
    expect((await put(`/api/exams/${id}/questions`).send({ questions: [{ ...mcq('x'), choices: [{ id: 'a', text: `a${NUL}` }, { id: 'b', text: 'b' }] }] })).status).toBe(400);
  });

  it('questions가 없거나 배열이 아니면 400', async () => {
    const { id } = await createExam();
    expect((await put(`/api/exams/${id}/questions`).send({})).status).toBe(400);
    expect((await put(`/api/exams/${id}/questions`).send({ questions: 'x' })).status).toBe(400);
  });

  it('DRAFT가 아니면 409 NOT_DRAFT', async () => {
    for (const status of ['OPEN', 'RUNNING', 'ENDED'] as const) {
      const exam = await makeExam({ ownerId: staff.id, status });
      const res = await put(`/api/exams/${exam.id}/questions`).send({ questions: [mcq('x')] });
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('NOT_DRAFT');
      expect(await prisma.question.count({ where: { examId: exam.id } })).toBe(2);
    }
  });
});

describe('PUT /api/exams/:id/roster', () => {
  const csv20 = Array.from({ length: 20 }, (_, i) => `2026${String(i + 1).padStart(4, '0')},학생${i + 1}`).join('\n');

  it('20줄 CSV를 저장하면 rosterCount가 20이다', async () => {
    const { id } = await createExam();
    const res = await put(`/api/exams/${id}/roster`).send({ csv: `학번,이름\r\n${csv20}\r\n` });
    expect(res.status).toBe(200);
    expect(res.body.rosterCount).toBe(20);
    expect((await get('/api/exams')).body.exams[0].rosterCount).toBe(20);
  });

  it('다시 저장하면 명단 전체가 교체된다', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await put(`/api/exams/${exam.id}/roster`).send({ csv: '1,가\n2,나' });
    expect(res.body.rosterCount).toBe(2);
    expect(await prisma.rosterEntry.count({ where: { examId: exam.id } })).toBe(2);
  });

  it('중복 학번은 400, 줄 번호가 오류에 있고 저장되지 않는다', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await put(`/api/exams/${exam.id}/roster`).send({ csv: '1,가\n2,나\n1,다' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.details).toMatchObject([{ line: 3, code: 'DUPLICATE' }]);
    expect(await prisma.rosterEntry.count({ where: { examId: exam.id } })).toBe(3);
  });

  it('csv 입력 검증: 없음·숫자·NUL·너무 큼은 400', async () => {
    const { id } = await createExam();
    for (const body of [{}, { csv: 5 }, { csv: `1,가${NUL}` }, { csv: '1,가\ud800' }, { csv: 'a'.repeat(300_000) }]) {
      const res = await put(`/api/exams/${id}/roster`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('DRAFT가 아니면 409 NOT_DRAFT, 명단은 그대로', async () => {
    const exam = await makeExam({ ownerId: staff.id, status: 'OPEN' });
    const res = await put(`/api/exams/${exam.id}/roster`).send({ csv: '1,가' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_DRAFT');
    expect(await prisma.rosterEntry.count({ where: { examId: exam.id } })).toBe(3);
  });
});

describe('PATCH /api/exams/:id', () => {
  it('DRAFT·OPEN에서 기본정보와 무결성 설정을 바꿀 수 있다', async () => {
    for (const status of ['DRAFT', 'OPEN'] as const) {
      const exam = await makeExam({ ownerId: staff.id, status });
      const res = await patch(`/api/exams/${exam.id}`).send({ title: '새 제목', instructions: '새 안내', durationMin: 90, pasteMode: 'BLOCK', shuffle: false });
      expect(res.status, status).toBe(200);
      expect(res.body.exam).toMatchObject({ title: '새 제목', instructions: '새 안내', durationMin: 90, pasteMode: 'BLOCK', shuffle: false });
    }
  });

  it('RUNNING에서 lockNewEntry는 200, 그 밖의 설정은 409 ALREADY_STARTED', async () => {
    const exam = await makeExam({ ownerId: staff.id, status: 'RUNNING' });
    const ok = await patch(`/api/exams/${exam.id}`).send({ lockNewEntry: true });
    expect(ok.status).toBe(200);
    expect(ok.body.exam.lockNewEntry).toBe(true);
    const no = await patch(`/api/exams/${exam.id}`).send({ shuffle: false });
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('ALREADY_STARTED');
    const mixed = await patch(`/api/exams/${exam.id}`).send({ lockNewEntry: false, title: 'x' });
    expect(mixed.status).toBe(409);
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } })).lockNewEntry).toBe(true); // 혼합 요청은 일부도 적용되지 않는다
  });

  it('OPEN에서도 lockNewEntry를 바꿀 수 있다', async () => {
    const exam = await makeExam({ ownerId: staff.id, status: 'OPEN' });
    expect((await patch(`/api/exams/${exam.id}`).send({ lockNewEntry: true })).status).toBe(200);
  });

  it('ENDED는 어떤 설정도 바꿀 수 없다', async () => {
    const exam = await makeExam({ ownerId: staff.id, status: 'ENDED' });
    expect((await patch(`/api/exams/${exam.id}`).send({ title: 'x' })).status).toBe(409);
    expect((await patch(`/api/exams/${exam.id}`).send({ lockNewEntry: true })).status).toBe(409);
  });

  it('입력 검증: 빈 본문·알 수 없는 필드·범위 밖·NUL은 400', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const bad: Record<string, unknown>[] = [{}, { status: 'RUNNING' }, { passcode: '123456' }, { durationMin: 0 }, { durationMin: 301 }, { pasteMode: 'NONE' }, { shuffle: 'yes' }, { lockNewEntry: 1 }, { title: '' }, { title: `a${NUL}` }, { instructions: `a${NUL}` }];
    for (const body of bad) {
      const res = await patch(`/api/exams/${exam.id}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('DELETE /api/exams/:id', () => {
  it('DRAFT는 삭제되고 문항·명단이 연쇄 삭제된다', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await del(`/api/exams/${exam.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await prisma.exam.count()).toBe(0);
    expect(await prisma.question.count()).toBe(0);
    expect(await prisma.rosterEntry.count()).toBe(0);
  });

  it('ENDED도 삭제된다(응시·답안 연쇄 삭제)', async () => {
    const exam = await makeExam({ ownerId: staff.id, status: 'ENDED' });
    const entry = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: exam.id } });
    const q = await prisma.question.findFirstOrThrow({ where: { examId: exam.id } });
    const attempt = await prisma.attempt.create({ data: { examId: exam.id, rosterEntryId: entry.id, sessionTokenHash: 'h2', questionOrder: [], choiceOrders: {} } });
    await prisma.answer.create({ data: { attemptId: attempt.id, questionId: q.id, text: '답' } });
    expect((await del(`/api/exams/${exam.id}`)).status).toBe(200);
    expect(await prisma.attempt.count()).toBe(0);
    expect(await prisma.answer.count()).toBe(0);
  });

  it('OPEN·RUNNING은 409이고 삭제되지 않는다', async () => {
    for (const status of ['OPEN', 'RUNNING'] as const) {
      const exam = await makeExam({ ownerId: staff.id, status });
      const res = await del(`/api/exams/${exam.id}`);
      expect(res.status, status).toBe(409);
      expect(await prisma.exam.count({ where: { id: exam.id } })).toBe(1);
    }
  });
});

describe('Origin 검사와의 결합', () => {
  it('다른 출처에서 온 시험 삭제 요청은 403이고 삭제되지 않는다', async () => {
    const exam = await makeExam({ ownerId: staff.id });
    const res = await request(app).delete(`/api/exams/${exam.id}`).set('Cookie', cookie).set('Host', 'exam.example').set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
    expect(await prisma.exam.count()).toBe(1);
  });
});
