/**
 * 통합 테스트가 쓸 데이터베이스 주소.
 * - TEST_DATABASE_URL이 있으면 그것(로컬: .env), 없으면 DATABASE_URL이 _test로 끝날 때 그것(CI),
 *   둘 다 아니면 docker-compose의 exam_test 기본값.
 * 개발 DB(DATABASE_URL=…/exam)를 테스트가 건드리지 않도록 항상 _test 이름을 쓴다(ADR-003).
 */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://exam:exam@localhost:5432/exam_test';

export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (env.DATABASE_URL && new URL(env.DATABASE_URL).pathname.endsWith('_test')) return env.DATABASE_URL;
  return DEFAULT_TEST_DATABASE_URL;
}
