// 클라이언트·서버 공용 타입과 상수 (ADR-002). 값은 docs/SPEC.md 2·5·7장을 그대로 옮긴 것이다.
// 이 파일을 바꿀 때는 SPEC과 어긋나지 않는지 확인한다. 병렬 작업 중에는 Coordinator가 병합 때만 수정한다.

/** 시험 상태 (SPEC 2.1) */
export type ExamStatus = 'DRAFT' | 'OPEN' | 'RUNNING' | 'ENDED';

/** 응시 상태 (SPEC 2.2) */
export type AttemptState =
  | 'WAITING'
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUBMITTED'
  | 'TERMINATED'
  | 'REJECTED';

/** 제출 사유 (SPEC 2.2) */
export type SubmitReason = 'STUDENT' | 'TIMEOUT' | 'EXAM_ENDED';

/** 카드 색과 신호 위험도 (SPEC 5.4). NONE은 확인 처리된 상태 */
export type Severity = 'NONE' | 'INFO' | 'WARN' | 'ALERT';

/** 붙여넣기 모드 (SPEC 5.3) */
export type PasteMode = 'RECORD' | 'BLOCK';

/** 문항 유형 (SPEC 4장) */
export type QuestionType = 'MCQ' | 'ESSAY';

/** 감독관 조치 종류 (SPEC F-14, F-16, 5.7). AUTO_PAUSE는 시스템이 기록한다 */
export type ProctorActionType =
  | 'APPROVE_ENTRY'
  | 'REJECT_ENTRY'
  | 'APPROVE_SESSION'
  | 'REJECT_SESSION'
  | 'WARN'
  | 'PAUSE'
  | 'RESUME'
  | 'TERMINATE'
  | 'ADD_TIME'
  | 'ACK'
  | 'AUTO_PAUSE';

/** 행동 신호 종류 (SPEC 5.1) */
export type SignalType =
  | 'LEAVE'
  | 'LEAVE_START'
  | 'FULLSCREEN_EXIT'
  | 'PASTE'
  | 'DROP'
  | 'MULTI_MONITOR'
  | 'DISCONNECT'
  | 'RECONNECT'
  | 'HEARTBEAT_GAP'
  | 'SEQ_GAP';

/** 위반 5회마다 자동 잠금 (SPEC 5.7) */
export const VIOLATION_LIMIT = 5;
/** 하트비트 간격 (SPEC 5.2) */
export const HEARTBEAT_MS = 5000;
/** 답안 자동 저장 최대 간격 (SPEC F-11) */
export const AUTOSAVE_MAX_INTERVAL_MS = 5000;

/** Socket.IO 이벤트 이름 (SPEC 7.2) */
export const EV = {
  // 학생 → 서버
  HEARTBEAT: 'hb',
  SIGNAL: 'signal',
  ANSWER_SAVE: 'answer:save',
  // 서버 → 학생
  ATTEMPT_STATE: 'attempt:state',
  EXAM_STARTED: 'exam:started',
  WAITING_COUNT: 'waiting:count',
  PROCTOR_WARNING: 'proctor:warning',
  VIOLATION_COUNTED: 'violation:counted',
  SESSION_REVOKED: 'session:revoked',
  // 교수자 → 서버
  DASHBOARD_JOIN: 'dashboard:join',
  // 서버 → 교수자
  DASHBOARD_SNAPSHOT: 'dashboard:snapshot',
  ATTEMPT_UPDATED: 'attempt:updated',
  SIGNAL_NEW: 'signal:new',
  APPROVAL_PENDING: 'approval:pending',
  APPROVAL_RESOLVED: 'approval:resolved',
  NETWORK_INCIDENT: 'network:incident',
} as const;

export type EventName = (typeof EV)[keyof typeof EV];

/** API·소켓 ack가 돌려주는 오류 코드. 클라이언트 `errorText`가 모든 코드에 한국어 문구를 갖는지 테스트한다. */
export const ERROR_CODES = [
  'NOT_FOUND',
  'INVALID_JSON',
  'PAYLOAD_TOO_LARGE',
  'BAD_REQUEST',
  'INVALID_INPUT',
  'INTERNAL',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN_ORIGIN',
  'INVALID_TRANSITION',
  'NOT_DRAFT',
  'BUSY',
  'ALREADY_STARTED',
  'NOT_READY_TO_OPEN',
  'ENTRY_FAILED',
  'EXAM_NOT_ENTERABLE',
  'TOO_MANY_ATTEMPTS',
  'ENTRY_CLOSED',
  'UNSUPPORTED_ACTION',
  'CONSENT_REQUIRED',
  'NOT_ACTIVE',
  'STALE_REV',
  'TOO_LONG',
  'INVALID',
  'ALREADY_SUBMITTED',
  'ENTRY_REJECTED',
  'APPROVAL_ALREADY_PENDING',
  'ATTEMPT_FINISHED',
  'INVALID_STATE',
  'EXTRA_TIME_LIMIT',
  'NOT_ESSAY',
  'NOT_SUBMITTED',
  'NOT_ENDED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 신호 자체의 위험도 (SPEC 5.4). NONE 없음 */
export type SignalSeverity = 'INFO' | 'WARN' | 'ALERT';

/** 학생 클라이언트가 보내는 신호 종류 (SPEC 5.1) */
export type ClientSignalType = 'LEAVE' | 'LEAVE_START' | 'FULLSCREEN_EXIT' | 'PASTE' | 'DROP';

/** 이탈 3초 이상이면 위반 (SPEC 5.4) */
export const LEAVE_VIOLATION_MS = 3000;
/** 하트비트 공백 15초면 HEARTBEAT_GAP (SPEC 5.2) */
export const HEARTBEAT_GAP_MS = 15000;
/** 소켓 끊김 후 재연결 유예 (SPEC 5.1) */
export const DISCONNECT_GRACE_MS = 10000;
/** 네트워크 장애 의심 판정 윈도 (SPEC 5.5) */
export const NETWORK_INCIDENT_WINDOW_MS = 10000;
/** 네트워크 장애 의심 최소 인원 (SPEC 5.5) */
export const NETWORK_INCIDENT_MIN_COUNT = 3;
/** 네트워크 장애 의심 응시 인원 비율 (SPEC 5.5) */
export const NETWORK_INCIDENT_RATIO = 0.3;
/** 비율 조건이 성립하려면 필요한 최소 인원 (SPEC 5.5, D-030). 1명만으로는 장애가 아니다 */
export const NETWORK_INCIDENT_MIN_RATIO_COUNT = 2;

/** 신호 DTO (SPEC 7.2). 시각은 epoch ms */
export type SignalDto = {
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  clientAt: number | null;
  receivedAt: number;
  durationMs: number | null;
  questionId: string | null;
  meta: Record<string, unknown>;
};

/** 감독 대시보드 응시 요약 (SPEC 7.2) */
export type AttemptSummary = {
  attemptId: string | null;
  studentNo: string;
  name: string;
  /** null = 미입장 */
  state: AttemptState | null;
  ready: boolean;
  consentDeclined: boolean;
  violationCount: number;
  unackedSeverity: Severity;
  /** PAUSED이고 마지막 중지가 AUTO_PAUSE */
  locked: boolean;
  connected: boolean;
  /** LEAVE_START 후 LEAVE 전 */
  away: boolean;
  extraSeconds: number;
  deadline: number | null;
  pausedAt: number | null;
  lastSignal: { type: SignalType; severity: SignalSeverity; receivedAt: number } | null;
};
