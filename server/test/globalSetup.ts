import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactConnectionStrings, testDatabaseUrl } from './testDatabase';

/** 테스트 시작 전 1회: 테스트 DB에 마이그레이션을 적용한다(이미 적용돼 있으면 아무 일도 하지 않는다). */
export default function setup(): void {
  const url = testDatabaseUrl();
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) throw new Error(`테스트 DB 이름은 _test로 끝나야 합니다: "${name}"`);

  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (err) {
    const out = `${(err as { stdout?: Buffer }).stdout ?? ''}${(err as { stderr?: Buffer }).stderr ?? ''}`;
    // Prisma 오류 출력에 접속 문자열(비밀번호 포함)이 섞일 수 있어 가린 뒤 보여 준다
    throw new Error(`테스트 DB 마이그레이션 실패(docker compose로 DB를 켰는지 확인: npm run db:up)\n${redactConnectionStrings(out)}`);
  }
}
