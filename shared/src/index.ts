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
  'INTERNAL',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'INVALID_TRANSITION',
  'NOT_DRAFT',
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
