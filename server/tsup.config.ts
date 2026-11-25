import { defineConfig } from 'tsup';

// 운영 빌드: 서버 코드를 dist/index.js 하나로 묶는다.
// @exam/shared는 TS 소스를 그대로 가리키는 작업 공간 패키지라 일반 node가 읽을 수 없으므로 번들에 포함한다(ADR-002).
// express 같은 외부 패키지는 번들하지 않고 node_modules에서 읽는다.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  noExternal: ['@exam/shared'],
});
