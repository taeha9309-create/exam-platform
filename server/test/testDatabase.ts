/**
 * 통합 테스트가 쓸 데이터베이스 주소.
 * - 셸 환경변수 TEST_DATABASE_URL이 있으면 그것(예: 동시에 다른 테스트가 도는 중이라 전용 DB가 필요할 때),
 *   없으면 DATABASE_URL이 _test로 끝날 때 그것(CI), 둘 다 아니면 docker-compose의 exam_test 기본값.
 * 주의: vitest는 .env 파일을 process.env로 읽어 오지 않는다. 그래서 .env의 DATABASE_URL(개발 DB)은 무시되고,
 * 어떤 경우에도 개발 DB(…/exam)를 테스트가 건드리지 않는다(ADR-003).
 */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://exam:exam@localhost:5432/exam_test';

export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (env.DATABASE_URL && new URL(env.DATABASE_URL).pathname.endsWith('_test')) return env.DATABASE_URL;
  return DEFAULT_TEST_DATABASE_URL;
}

/** 오류 출력에 섞여 들어갈 수 있는 접속 문자열(비밀번호 포함)을 가린다 */
export function redactConnectionStrings(text: string): string {
  return text.replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/gi, '$1://***');
}
