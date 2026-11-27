import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * 핵심 흐름 E2E 설정. 프로덕션과 같은 형태(빌드된 서버 하나가 client/dist를 제공)로 실행한다.
 *
 * 로컬 실행(전용 DB exam_e2e, 명령줄로 환경변수 주입 — 운영 비밀과 무관한 임의 값):
 *   npm run build
 *   DATABASE_URL=postgresql://exam:exam@localhost:5432/exam_e2e npm run db:deploy -w @exam/server
 *   DATABASE_URL=... JWT_SECRET=<임의> DEMO_STAFF_PASSWORD=<임의> DEMO_PASSCODE=246810 npm run e2e
 * 배포 URL 대상: PLAYWRIGHT_BASE_URL=https://... DEMO_STAFF_PASSWORD=... DEMO_PASSCODE=... npm run e2e
 *   (이때는 서버를 띄우지 않고 데모 데이터도 다시 만들지 않는다. 미리 `demo:reset`을 해 둔다.)
 */
const external = process.env.PLAYWRIGHT_BASE_URL;
const PORT = 3100;
const root = resolve(__dirname, '..'); // 루트 package.json에 "type"이 없어 Playwright가 이 파일을 CommonJS로 읽는다(__dirname 사용 가능)

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../test-results',
  // 시험 진행·마감 대기(1분)가 있어 시간을 넉넉히 둔다. 단계는 하나의 시나리오라 순서대로, 1개씩 실행한다.
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: {
    baseURL: external ?? `http://localhost:${PORT}`,
    locale: 'ko-KR',
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  webServer: external
    ? undefined
    : {
        // 서버를 띄우기 전에 데모 데이터를 새로 만든다(DATABASE_URL의 데모 데이터만 지움. DEMO_STAFF_PASSWORD·DEMO_PASSCODE 필요).
        command: 'npx tsx scripts/demo-reset.ts && node server/dist/index.js',
        cwd: root,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 30_000,
        env: { ...(process.env as Record<string, string>), PORT: String(PORT), NODE_ENV: 'production' },
      },
});
