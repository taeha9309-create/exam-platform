// 교수자 화면 테스트 공통 도우미(테스트에서만 쓴다).
import type { ExamDetail } from './staffApi';

export function makeExam(over: Partial<ExamDetail> = {}): ExamDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    examCode: 'ABCD2345',
    title: '중간 점검 시험',
    instructions: '',
    durationMin: 30,
    status: 'DRAFT',
    passcode: null,
    lockNewEntry: false,
    pasteMode: 'RECORD',
    shuffle: true,
    startedAt: null,
    endsAt: null,
    endedAt: null,
    ownerName: '김교수',
    rosterCount: 0,
    attemptCount: 0,
    questions: [],
    roster: [],
    ...over,
  };
}
