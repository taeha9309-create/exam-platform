import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './test/testDatabase';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 통합 테스트가 같은 테스트 DB를 쓰므로 파일을 순차 실행한다(ADR-003).
    fileParallelism: false,
    globalSetup: ['./test/globalSetup.ts'],
    env: { DATABASE_URL: testDatabaseUrl() },
  },
});
