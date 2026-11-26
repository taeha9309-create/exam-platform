// 모든 화면 문구는 이 파일에서만 정의한다(ADR-008, 성공 기준 6).
// 금지어: "부정행위", "AI 사용", "적발", "커닝" — 시스템은 판정하지 않고 관찰 사실만 쓴다.
export const t = {
  appName: '시험 무결성 플랫폼',
  server: {
    checking: '서버 상태 확인 중…',
    ok: '서버 연결됨',
    down: '서버에 연결할 수 없습니다',
  },
  pages: {
    staffLogin: '교수자 로그인',
    staffExams: '시험 목록',
    staffEdit: '시험 편집',
    staffRun: '시험 진행',
    staffResults: '결과',
    staffSurvey: '설문 요약',
    studentExam: '시험 입장',
    notFoundTitle: '페이지를 찾을 수 없습니다',
    notFoundBody: '주소를 다시 확인해 주세요.',
  },
  errors: {
    UNKNOWN: '문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    NETWORK: '네트워크에 연결할 수 없습니다. 연결 상태를 확인해 주세요.',
    NOT_FOUND: '요청한 항목을 찾을 수 없습니다.',
    INVALID_JSON: '요청 형식이 올바르지 않습니다.',
    PAYLOAD_TOO_LARGE: '보낸 내용이 너무 큽니다.',
    BAD_REQUEST: '입력한 내용을 다시 확인해 주세요.',
    INVALID_INPUT: '입력한 내용을 다시 확인해 주세요.',
    INTERNAL: '서버에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.',
    UNAUTHORIZED: '로그인이 필요합니다.',
    INVALID_CREDENTIALS: '이메일 또는 비밀번호가 맞지 않습니다.',
    INVALID_TRANSITION: '현재 상태에서는 할 수 없는 동작입니다.',
    NOT_DRAFT: '준비 중인 시험에서만 문항과 명단을 수정할 수 있습니다.',
    ALREADY_STARTED: '이미 시작된 시험입니다.',
    NOT_READY_TO_OPEN: '문항과 명단이 각각 1개 이상 있어야 입장을 열 수 있습니다.',
    ENTRY_FAILED: '학번 또는 시험 비밀번호가 맞지 않습니다.',
    EXAM_NOT_ENTERABLE: '지금은 입장할 수 없는 시험입니다.',
    TOO_MANY_ATTEMPTS: '시도 횟수가 많습니다. 잠시 후 다시 시도해 주세요.',
    ENTRY_CLOSED: '신규 입장이 닫혀 있습니다. 감독관에게 문의해 주세요.',
    UNSUPPORTED_ACTION: '지원하지 않는 조치입니다.',
    CONSENT_REQUIRED: '먼저 안내에 동의해야 다음 단계로 진행할 수 있습니다.',
    NOT_ACTIVE: '지금은 답안을 저장할 수 없는 상태입니다.',
    STALE_REV: '더 최신 답안이 이미 저장되어 있습니다.',
    TOO_LONG: '답안이 허용된 길이를 넘었습니다.',
    INVALID: '입력한 내용이 올바르지 않습니다.',
    ALREADY_SUBMITTED: '이미 제출되었습니다.',
  },
} as const;

/** 서버 오류 코드를 한국어 문구로 바꾼다. 모르는 코드는 일반 오류 문구. */
export function errorText(code: string): string {
  const map: Record<string, string> = t.errors;
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code]! : t.errors.UNKNOWN;
}
