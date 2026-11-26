/** PORT 환경변수를 정수로 읽는다. 값이 없으면 기본값, 잘못된 값이면 값을 보여 주는 오류(스택 트레이스 대신 안내를 내기 위해). */
export function parsePort(raw: string | undefined, fallback = 3000): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 값이 올바르지 않습니다: "${raw}" (1~65535 사이의 정수여야 합니다)`);
  }
  return port;
}
