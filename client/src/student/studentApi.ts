// 학생 API 호출(SPEC 7.1). 학생 인증은 Authorization: Bearer 세션 토큰(ADR-005). 토큰을 URL·로그에 넣지 않는다.
import type { AttemptState } from '@exam/shared';
import { api } from '../api';

/** GET /api/student/attempt, attempt:state, consent·env 응답이 공통으로 가진 응시 상태. needs는 REST 응답에만 있다. */
export interface AttemptView {
  state: AttemptState;
  deadline: number | null;
  serverNow: number;
  extraSeconds: number;
  violationCount: number;
  needs?: { consent: boolean; env: boolean };
  /** 서버가 아직 주지 않는다(계획 1 서버 계약에 없음). 오면 설문 재표시를 막는 데 쓴다. */
  surveyDone?: boolean;
}

export interface EntryInput {
  examCode: string;
  studentNo: string;
  passcode: string;
}

export type ConfirmResponse = { sessionToken: string; attempt: AttemptView & { id: string } } | { status: 'DUPLICATE_PENDING'; pendingToken?: string };

export interface StudentQuestion {
  id: string;
  type: 'MCQ' | 'ESSAY';
  prompt: string;
  points: number;
  choices?: { id: string; text: string }[];
}
export interface StudentAnswer {
  questionId: string;
  choiceId?: string;
  text?: string;
  rev: number;
  savedAt: string;
}
export interface StudentExam {
  questions: StudentQuestion[];
  answers: StudentAnswer[];
}

export const getPublicExam = (examCode: string) => api<{ title: string; status: string }>('GET', `/api/public/exams/${encodeURIComponent(examCode)}`);
export const postEntry = (input: EntryInput) => api<{ name: string }>('POST', '/api/student/entry', input);
export const postConfirm = (input: EntryInput & { sessionToken?: string }) => api<ConfirmResponse>('POST', '/api/student/confirm', input);
export const getAttempt = (token: string) => api<AttemptView>('GET', '/api/student/attempt', undefined, { token });
export const postConsent = (token: string, agree: boolean) => api<AttemptView>('POST', '/api/student/consent', { agree }, { token });
export const postEnv = (token: string, env: { browser: 'chrome' | 'edge'; isExtended: boolean }) =>
  api<AttemptView>('POST', '/api/student/env', { ...env, fullscreen: true }, { token });
export const getStudentExam = (token: string) => api<StudentExam>('GET', '/api/student/exam', undefined, { token });
export const postSubmit = (token: string) => api<{ state: AttemptState; submittedAt: string | null }>('POST', '/api/student/submit', {}, { token });
/** 서버 미구현(Task 12 병렬 작업 중). SPEC 7.1·계획서 계약: { difficulty?: 1..5, comment?: string(≤1000) }. 빈 객체 = 건너뛰기 */
export const postSurvey = (token: string, body: { difficulty?: number; comment?: string }) => api<unknown>('POST', '/api/student/survey', body, { token });
