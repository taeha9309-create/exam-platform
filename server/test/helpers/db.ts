import type { Exam, Staff } from '@prisma/client';
import { prisma } from '../../src/db';
import { generateExamCode } from '../../src/domain/codes';

/** 테스트용 데이터베이스인지 확인한다(이름이 _test로 끝나야 한다). 개발·운영 DB를 비우는 사고를 막는 안전장치. */
export function assertTestDatabase(url: string | undefined): void {
  const name = url ? new URL(url).pathname.replace(/^\//, '') : '';
  if (!name.endsWith('_test')) {
    throw new Error(`테스트 DB가 아닙니다(데이터베이스 이름은 _test로 끝나야 함): "${name}"`);
  }
}

const TABLES = ['SurveyResponse', 'ProctorAction', 'Signal', 'Answer', 'Attempt', 'RosterEntry', 'Question', 'Exam', 'Staff'];

/** 모든 테이블을 비운다(테스트 DB 전용). */
export async function resetDb(): Promise<void> {
  assertTestDatabase(process.env.DATABASE_URL);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

let seq = 0;

export async function makeStaff(overrides: Partial<Omit<Staff, 'id' | 'createdAt'>> = {}): Promise<Staff> {
  seq += 1;
  return prisma.staff.create({
    data: { email: `staff${seq}-${Date.now()}@test.local`, passwordHash: 'test-hash', name: `교수${seq}`, ...overrides },
  });
}

/**
 * DRAFT 시험 1개: 객관식 1(보기 3개, 정답 c1) + 서술형 1, 명단 3명(20260001~20260003).
 * ownerId를 주지 않으면 교수자를 새로 만든다.
 */
export async function makeExam(overrides: Partial<Omit<Exam, 'id' | 'createdAt'>> = {}): Promise<Exam> {
  const ownerId = overrides.ownerId ?? (await makeStaff()).id;
  return prisma.exam.create({
    data: {
      examCode: generateExamCode(),
      title: '테스트 시험',
      instructions: '',
      durationMin: 30,
      ...overrides,
      ownerId,
      questions: {
        create: [
          { position: 0, type: 'MCQ', prompt: '객관식', points: 2, choices: [{ id: 'c1', text: '가' }, { id: 'c2', text: '나' }, { id: 'c3', text: '다' }], correctChoiceId: 'c1' },
          { position: 1, type: 'ESSAY', prompt: '서술형', points: 5 },
        ],
      },
      roster: {
        create: [
          { studentNo: '20260001', name: '학생1' },
          { studentNo: '20260002', name: '학생2' },
          { studentNo: '20260003', name: '학생3' },
        ],
      },
    },
  });
}
