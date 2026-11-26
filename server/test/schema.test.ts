import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { expectCheckViolation, expectForeignKeyViolation, expectUniqueViolation, expectValueTooLong } from './helpers/dbErrors';
import { assertTestDatabase, makeExam, makeStaff, resetDb } from './helpers/db';

beforeEach(async () => {
  await resetDb();
});

/** 시험 + 응시 1건(+답안·신호·조치·설문)을 만든다 */
async function makeAttemptTree() {
  const exam = await makeExam();
  const staff = await makeStaff();
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: exam.id } });
  const question = await prisma.question.findFirstOrThrow({ where: { examId: exam.id, type: 'ESSAY' } });
  const attempt = await prisma.attempt.create({
    data: { examId: exam.id, rosterEntryId: roster.id, sessionTokenHash: `hash-${exam.id}`, questionOrder: [], choiceOrders: {} },
  });
  await prisma.answer.create({ data: { attemptId: attempt.id, questionId: question.id, text: '답' } });
  await prisma.signal.create({ data: { attemptId: attempt.id, type: 'LEAVE', severity: 'WARN', durationMs: 5000 } });
  await prisma.proctorAction.create({ data: { attemptId: attempt.id, staffId: staff.id, type: 'WARN', reason: '경고' } });
  await prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: 3, comment: '보통' } });
  return { exam, staff, attempt };
}

describe('삭제 연쇄 (SPEC 4장: 시험을 삭제하면 함께 삭제)', () => {
  it('시험을 지우면 문항과 명단이 함께 지워진다', async () => {
    const exam = await makeExam();
    expect(await prisma.question.count({ where: { examId: exam.id } })).toBe(2);
    expect(await prisma.rosterEntry.count({ where: { examId: exam.id } })).toBe(3);
    await prisma.exam.delete({ where: { id: exam.id } });
    expect(await prisma.question.count({ where: { examId: exam.id } })).toBe(0);
    expect(await prisma.rosterEntry.count({ where: { examId: exam.id } })).toBe(0);
  });

  it('시험을 지우면 응시·답안·신호·조치·설문까지 모두 지워지고 교수자 계정은 남는다', async () => {
    const { exam, staff } = await makeAttemptTree();
    await prisma.exam.delete({ where: { id: exam.id } });
    expect(await prisma.attempt.count()).toBe(0);
    expect(await prisma.answer.count()).toBe(0);
    expect(await prisma.signal.count()).toBe(0);
    expect(await prisma.proctorAction.count()).toBe(0);
    expect(await prisma.surveyResponse.count()).toBe(0);
    expect(await prisma.staff.findUnique({ where: { id: staff.id } })).not.toBeNull();
  });

  it('조치만 한 교수자를 지워도 조치 기록은 남고 작성자가 비워진다(시스템 조치는 처음부터 작성자가 없다)', async () => {
    const { attempt, staff } = await makeAttemptTree();
    await prisma.proctorAction.create({ data: { attemptId: attempt.id, staffId: null, type: 'AUTO_PAUSE', reason: '시스템 자동 일시정지(위반 5회)' } });
    expect(await prisma.proctorAction.count({ where: { attemptId: attempt.id, staffId: staff.id } })).toBe(1);

    // 이 교수자는 시험을 소유하지 않으므로 지울 수 있다(소유한 교수자는 아래 Restrict 테스트)
    await prisma.staff.delete({ where: { id: staff.id } });

    expect(await prisma.proctorAction.count({ where: { attemptId: attempt.id } })).toBe(2);
    expect(await prisma.proctorAction.count({ where: { attemptId: attempt.id, staffId: staff.id } })).toBe(0);
    expect(await prisma.proctorAction.count({ where: { attemptId: attempt.id, staffId: null } })).toBe(2);
  });

  it('시험이 있는 교수자는 지울 수 없다(Restrict, FK Exam_ownerId_fkey)', async () => {
    const exam = await makeExam();
    await expectForeignKeyViolation(prisma.staff.delete({ where: { id: exam.ownerId } }), 'Exam_ownerId_fkey');
    expect(await prisma.staff.findUnique({ where: { id: exam.ownerId } })).not.toBeNull();
  });
});

describe('유일성 제약', () => {
  it('같은 시험에 같은 학번을 두 번 등록할 수 없다', async () => {
    const exam = await makeExam();
    await expectUniqueViolation(prisma.rosterEntry.create({ data: { examId: exam.id, studentNo: '20260001', name: '중복' } }), ['examId', 'studentNo']);
  });

  it('다른 시험에는 같은 학번을 등록할 수 있다', async () => {
    const a = await makeExam();
    const b = await makeExam();
    expect(await prisma.rosterEntry.count({ where: { studentNo: '20260001', examId: { in: [a.id, b.id] } } })).toBe(2);
  });

  it('examCode와 교수자 이메일은 유일하다', async () => {
    const exam = await makeExam();
    await expectUniqueViolation(makeExam({ examCode: exam.examCode }), ['examCode']);
    const staff = await makeStaff({ email: 'dup@test.local' });
    await expectUniqueViolation(makeStaff({ email: staff.email }), ['email']);
  });

  it('명단 한 명에 응시는 하나뿐이다', async () => {
    const { exam, attempt } = await makeAttemptTree();
    await expectUniqueViolation(
      prisma.attempt.create({ data: { examId: exam.id, rosterEntryId: attempt.rosterEntryId, sessionTokenHash: 'other', questionOrder: [], choiceOrders: {} } }),
      ['rosterEntryId'],
    );
  });

  it('세션 토큰 해시는 응시마다 유일하다', async () => {
    const { exam, attempt } = await makeAttemptTree();
    const other = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: exam.id, id: { not: attempt.rosterEntryId } } });
    await expectUniqueViolation(
      prisma.attempt.create({ data: { examId: exam.id, rosterEntryId: other.id, sessionTokenHash: attempt.sessionTokenHash, questionOrder: [], choiceOrders: {} } }),
      ['sessionTokenHash'],
    );
  });

  it('한 응시에서 같은 문항의 답안은 하나뿐이다', async () => {
    const { attempt } = await makeAttemptTree();
    const answer = await prisma.answer.findFirstOrThrow({ where: { attemptId: attempt.id } });
    await expectUniqueViolation(prisma.answer.create({ data: { attemptId: attempt.id, questionId: answer.questionId, text: '또' } }), ['attemptId', 'questionId']);
  });

  it('같은 시험에서 문항 위치는 겹칠 수 없다', async () => {
    const exam = await makeExam();
    await expectUniqueViolation(prisma.question.create({ data: { examId: exam.id, position: 0, type: 'ESSAY', prompt: '겹침', points: 1 } }), ['examId', 'position']);
  });
});

describe('값 제약(CHECK, 마이그레이션 SQL로 건 것)', () => {
  it('배점은 1 이상이어야 한다', async () => {
    const exam = await makeExam();
    await expectCheckViolation(prisma.question.create({ data: { examId: exam.id, position: 9, type: 'ESSAY', prompt: 'x', points: 0 } }), 'Question_points_min');
    await expect(prisma.question.create({ data: { examId: exam.id, position: 9, type: 'ESSAY', prompt: 'x', points: 1 } })).resolves.toBeTruthy();
  });

  it('제한 시간은 1~300분이다', async () => {
    await expectCheckViolation(makeExam({ durationMin: 0 }), 'Exam_durationMin_range');
    await expectCheckViolation(makeExam({ durationMin: 301 }), 'Exam_durationMin_range');
    await expect(makeExam({ durationMin: 1 })).resolves.toBeTruthy();
    await expect(makeExam({ durationMin: 300 })).resolves.toBeTruthy();
  });

  it('체감 난이도는 1~5이거나 비어 있어야 한다', async () => {
    const exam = await makeExam();
    await expectCheckViolation(prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: 6 } }), 'SurveyResponse_difficulty_range');
    await expectCheckViolation(prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: 0 } }), 'SurveyResponse_difficulty_range');
    await expect(prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: 1 } })).resolves.toBeTruthy();
    await expect(prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: 5 } })).resolves.toBeTruthy();
    await expect(prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: null, comment: '의견만' } })).resolves.toBeTruthy();
  });
});

describe('길이 제한(VarChar)', () => {
  it('서술형 답안은 5000자까지', async () => {
    const { attempt } = await makeAttemptTree();
    const ok = await prisma.question.create({ data: { examId: attempt.examId, position: 7, type: 'ESSAY', prompt: 'y', points: 1 } });
    const over = await prisma.question.create({ data: { examId: attempt.examId, position: 8, type: 'ESSAY', prompt: 'z', points: 1 } });
    await expect(prisma.answer.create({ data: { attemptId: attempt.id, questionId: ok.id, text: 'a'.repeat(5000) } })).resolves.toBeTruthy();
    await expectValueTooLong(prisma.answer.create({ data: { attemptId: attempt.id, questionId: over.id, text: 'a'.repeat(5001) } }));
  });

  it('설문 의견은 1000자까지', async () => {
    const exam = await makeExam();
    await expect(prisma.surveyResponse.create({ data: { examId: exam.id, comment: 'b'.repeat(1000) } })).resolves.toBeTruthy();
    await expectValueTooLong(prisma.surveyResponse.create({ data: { examId: exam.id, comment: 'b'.repeat(1001) } }));
  });
});

describe('기본값 (SPEC 4장)', () => {
  it('시험·응시의 기본값', async () => {
    const { exam, attempt } = await makeAttemptTree();
    expect(exam).toMatchObject({ status: 'DRAFT', lockNewEntry: false, pasteMode: 'RECORD', shuffle: true, passcode: null, startedAt: null, endsAt: null, endedAt: null });
    expect(attempt).toMatchObject({
      state: 'WAITING', isLate: false, consentDeclined: false, extraSeconds: 0, lastSeq: 0, violationCount: 0,
      connected: false, surveyDone: false, unackedSeverity: 'NONE', pendingTokenHash: null, pausedAt: null, submittedAt: null, submitReason: null,
    });
  });
});

describe('익명 설문 (D-015): 응답을 학생·응시·시각과 연결할 수 없다', () => {
  it('SurveyResponse의 컬럼은 id, examId, difficulty, comment뿐이다', () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'SurveyResponse');
    expect(model?.fields.map((f) => f.name).sort()).toEqual(['comment', 'difficulty', 'exam', 'examId', 'id']);
  });

  it('ID는 생성 시각이 들어 있지 않은 UUID v4다(cuid·UUID v7이면 ID로 제출 시각이 새어 나간다)', async () => {
    const exam = await makeExam();
    const rows = await Promise.all([1, 2, 3, 4, 5].map((n) => prisma.surveyResponse.create({ data: { examId: exam.id, difficulty: n } })));
    for (const r of rows) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('테스트 DB 안전장치', () => {
  it('이름이 _test로 끝나지 않는 DB는 거부한다', () => {
    expect(() => assertTestDatabase('postgresql://exam:exam@localhost:5432/exam')).toThrow(/테스트 DB가 아닙니다/);
    expect(() => assertTestDatabase(undefined)).toThrow();
    expect(() => assertTestDatabase('postgresql://exam:exam@localhost:5432/exam_test')).not.toThrow();
  });

  it('현재 테스트는 _test DB에 연결돼 있다', () => {
    expect(() => assertTestDatabase(process.env.DATABASE_URL)).not.toThrow();
  });
});
