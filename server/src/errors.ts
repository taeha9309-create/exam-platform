/**
 * 라우터가 던지는 "예상된" 오류. onError가 status·code를 그대로 응답으로 바꾼다.
 * message는 사용자에게 보여도 되는 일반 문구만 쓴다(비밀값·내부 정보 금지).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = '요청을 처리할 수 없습니다.') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}
