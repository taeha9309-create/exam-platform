/**
 * 운영에서만 TRUST_PROXY_HOPS(프록시 홉 수)를 읽는다. 운영이 아니면 undefined(trust proxy 꺼짐).
 * 운영: 미설정·빈 문자열이면 1, 그 외에는 공백 없는 1~3 정수 문자열만 허용하고 나머지는 시작을 거부한다.
 * true·이름·0은 받지 않는다(X-Forwarded-For 위조로 로그인·입장 시도 제한을 우회하지 못하게).
 */
export function parseTrustProxyHops(env: NodeJS.ProcessEnv): number | undefined {
  if (env.NODE_ENV !== 'production') return undefined;
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return 1;
  if (!/^[1-3]$/.test(raw)) {
    const shown = raw.length > 20 ? `${raw.slice(0, 20)}…` : raw;
    throw new Error(`TRUST_PROXY_HOPS 값이 올바르지 않습니다: "${shown}" (1~3 사이의 정수여야 합니다)`);
  }
  return Number(raw);
}

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
