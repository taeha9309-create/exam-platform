import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { expectCheckViolation, expectForeignKeyViolation, expectUniqueViolation, expectValueTooLong } from './helpers/dbErrors';
import { makeExam, resetDb } from './helpers/db';

// 오류 단언 헬퍼가 "틀린 경우"를 정말 거부하는지 확인한다(테스트를 검증하는 테스트).
beforeEach(async () => {
  await resetDb();
});

const duplicateRoster = async () => {
  const exam = await makeExam();
  return prisma.rosterEntry.create({ data: { examId: exam.id, studentNo: '20260001', name: '중복' } }); // UNIQUE 위반
};
const zeroPoints = async () => {
  const exam = await makeExam();
  return prisma.question.create({ data: { examId: exam.id, position: 9, type: 'ESSAY', prompt: 'x', points: 0 } }); // CHECK 위반
};

describe('오류 단언 헬퍼는 틀린 경우를 거부한다', () => {
  it('작업이 성공해 버리면 거부한다', async () => {
    const ok = Promise.resolve('성공');
    await expect(expectUniqueViolation(ok, ['x'])).rejects.toThrow('성공했습니다');
    await expect(expectForeignKeyViolation(Promise.resolve(1), 'x')).rejects.toThrow('성공했습니다');
    await expect(expectValueTooLong(Promise.resolve(1))).rejects.toThrow('성공했습니다');
    await expect(expectCheckViolation(Promise.resolve(1), 'x')).rejects.toThrow('성공했습니다');
  });

  it('종류가 다른 오류면 거부한다(UNIQUE 자리에 CHECK 오류, CHECK 자리에 UNIQUE 오류)', async () => {
    await expect(expectUniqueViolation(zeroPoints(), ['examId', 'studentNo'])).rejects.toThrow();
    await expect(expectCheckViolation(duplicateRoster(), 'Question_points_min')).rejects.toThrow();
    await expect(expectForeignKeyViolation(duplicateRoster(), 'Exam_ownerId_fkey')).rejects.toThrow();
    await expect(expectValueTooLong(duplicateRoster())).rejects.toThrow();
  });

  it('같은 종류여도 대상이 다르면 거부한다(다른 필드의 UNIQUE, 다른 이름의 CHECK)', async () => {
    await expect(expectUniqueViolation(duplicateRoster(), ['email'])).rejects.toThrow();
    await expect(expectCheckViolation(zeroPoints(), 'Exam_durationMin_range')).rejects.toThrow();
  });

  it('맞는 경우는 통과시킨다', async () => {
    await expectUniqueViolation(duplicateRoster(), ['examId', 'studentNo']);
    await expectCheckViolation(zeroPoints(), 'Question_points_min');
  });
});
