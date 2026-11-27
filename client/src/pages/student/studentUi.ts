import { ApiError } from '../../api';
import { errorText, t } from '../../copy/ko';

/** 오류를 학생에게 보일 한국어 문구로 바꾼다. 입장 실패 사유는 구분하지 않는다(ENTRY_FAILED는 한 가지 문구). */
export function studentErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    // Retry-After 헤더는 api()가 노출하지 않아 SPEC 2.4의 차단 시간(1분)을 문구에 쓴다.
    if (err.code === 'TOO_MANY_ATTEMPTS') return t.student.entry.tooMany;
    return errorText(err.code);
  }
  return t.errors.UNKNOWN;
}

export const errorCodeOf = (err: unknown): string | null => (err instanceof ApiError ? err.code : null);
