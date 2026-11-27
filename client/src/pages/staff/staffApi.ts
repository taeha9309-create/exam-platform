// 교수자 화면이 쓰는 API 함수 모음(SPEC 7.1). 화면은 fetch를 직접 부르지 않고 여기 함수만 쓴다(테스트에서 이 모듈을 모킹한다).
import type { ExamStatus, PasteMode, QuestionType } from '@exam/shared';
import { api, ApiError } from '../../api';

export interface StaffInfo {
  id: string;
  name: string;
  email: string;
}

export interface ExamListItem {
  id: string;
  title: string;
  status: ExamStatus;
  ownerName: string;
  rosterCount: number;
  attemptCount: number;
  createdAt: string;
}

export interface Choice {
  id: string;
  text: string;
}

export interface QuestionDto {
  id?: string;
  position?: number;
  type: QuestionType;
  prompt: string;
  points: number;
  choices?: Choice[] | null;
  correctChoiceId?: string | null;
}

export interface ExamDetail {
  id: string;
  examCode: string;
  title: string;
  instructions: string;
  durationMin: number;
  status: ExamStatus;
  passcode: string | null;
  lockNewEntry: boolean;
  pasteMode: PasteMode;
  shuffle: boolean;
  startedAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  ownerName: string;
  rosterCount: number;
  attemptCount: number;
  questions: QuestionDto[];
  roster: { id: string; studentNo: string; name: string }[];
}

export interface QuestionError {
  index: number;
  field: string;
  code: string;
}
export interface RosterError {
  line: number;
  code: string;
  message?: string;
}

/** 400 INVALID_INPUT에 딸린 세부 오류(문항·명단). 공통 `api()`는 details를 버리므로 이 두 호출만 따로 읽는다. */
export class DetailedApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    public readonly details: unknown,
  ) {
    super(status, code);
    this.name = 'DetailedApiError';
  }
}

/** api()를 부르되, 오류 본문에 details가 있으면 DetailedApiError로 바꿔 던진다. */
async function withDetails<T>(method: 'PUT', path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const text = await res.text().catch(() => '');
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined; // 프록시 오류 등 JSON이 아닌 본문
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: unknown; details?: unknown } } | undefined)?.error;
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    throw new DetailedApiError(res.status, code, err?.details);
  }
  return data as T;
}

// --- 인증 (F-01)
export const login = (email: string, password: string) => api<{ staff: StaffInfo }>('POST', '/api/staff/login', { email, password });
export const logout = () => api<{ ok: true }>('POST', '/api/staff/logout');
export const me = () => api<{ staff: StaffInfo }>('GET', '/api/staff/me');

// --- 시험 (F-02, F-05)
export const listExams = () => api<{ exams: ExamListItem[] }>('GET', '/api/exams');
export const createExam = (body: { title: string; instructions: string; durationMin: number }) => api<{ exam: { id: string } }>('POST', '/api/exams', body);
export const getExam = (id: string) => api<{ exam: ExamDetail }>('GET', `/api/exams/${id}`);
export const patchExam = (
  id: string,
  body: Partial<{ title: string; instructions: string; durationMin: number; pasteMode: PasteMode; shuffle: boolean; lockNewEntry: boolean }>,
) => api<{ exam: ExamDetail }>('PATCH', `/api/exams/${id}`, body);
export const deleteExam = (id: string) => api<{ ok: true }>('DELETE', `/api/exams/${id}`);

// --- 문항·명단 (F-03, F-04)
export const putQuestions = (id: string, questions: QuestionDto[]) => withDetails<{ questions: QuestionDto[] }>('PUT', `/api/exams/${id}/questions`, { questions });
export const putRoster = (id: string, csv: string) => withDetails<{ rosterCount: number }>('PUT', `/api/exams/${id}/roster`, { csv });

// --- 입장·시작·종료 (F-06)
export const openExam = (id: string) => api<{ exam: ExamDetail }>('POST', `/api/exams/${id}/open`);
export const regeneratePasscode = (id: string) => api<{ passcode: string }>('POST', `/api/exams/${id}/passcode`);
export const startExam = (id: string) => api<{ exam: ExamDetail }>('POST', `/api/exams/${id}/start`);
export const endExam = (id: string) => api<{ exam: ExamDetail }>('POST', `/api/exams/${id}/end`);

// --- 승인 (F-14)
export type ApprovalAction = 'APPROVE_ENTRY' | 'REJECT_ENTRY' | 'APPROVE_SESSION' | 'REJECT_SESSION';
export const resolveApproval = (attemptId: string, type: ApprovalAction, reason: string) =>
  api<{ attempt: { id: string; state: string } }>('POST', `/api/attempts/${attemptId}/actions`, { type, reason });

// --- 결과·설문 (F-17, F-18): 서버 Task 12 계약. 서버 구현 전에는 404가 돌아올 수 있다.
export interface ResultsResponse {
  questions: { id: string; type: QuestionType; points: number; position: number }[];
  rows: {
    attemptId: string;
    studentNo: string;
    name: string;
    state: string;
    mcqScore: number;
    essayScore: number | null;
    total: number | null;
    signalCounts: { INFO: number; WARN: number; ALERT: number };
    actionCount: number;
    answers: { answerId: string; questionId: string; choiceId?: string | null; text?: string | null; awardedPoints: number | null }[];
  }[];
}
export const getResults = (id: string) => api<ResultsResponse>('GET', `/api/exams/${id}/results`);
export const gradeAnswer = (answerId: string, points: number) => api<unknown>('PUT', `/api/answers/${answerId}/grade`, { points });

export interface SurveyResponseDto {
  count: number;
  distribution: number[];
  average: number | null;
  comments: string[];
}
export const getSurvey = (id: string) => api<SurveyResponseDto>('GET', `/api/exams/${id}/survey`);
