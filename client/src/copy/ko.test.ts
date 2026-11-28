import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '@exam/shared';
import { errorText, t } from './ko';

const FORBIDDEN = ['부정행위', 'AI 사용', '적발', '커닝'];

// client/src 전체 (이 파일은 copy/ 폴더에 있으므로 한 단계 위)
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const TEST_FILE = /\.(test|spec)\.tsx?$/;
// 화면에 나가지 않는 주석만 제외한다. 주석 줄 전체(//, /*, *로 시작)만 건너뛴다.
// 허용 목록(파일 단위 예외)은 두지 않는다. 금지어가 화면 문구에 나오면 반드시 실패해야 한다.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !TEST_FILE.test(name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** 파일별로 금지어가 나오는 줄(번호와 금지어)을 모은다. */
function findForbiddenInSource(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (COMMENT_LINE.test(line)) return;
      for (const w of FORBIDDEN) {
        if (line.includes(w)) hits.push(`${relative(SRC_DIR, file)}:${i + 1} "${w}"`);
      }
    });
  }
  return hits;
}

describe('화면 문구', () => {
  it('금지어가 없다', () => {
    const all = JSON.stringify(t);
    for (const w of FORBIDDEN) expect(all).not.toContain(w);
  });

  it('client/src의 모든 화면 소스(테스트 제외)에 금지어가 없다', () => {
    const files = collectSourceFiles(SRC_DIR);
    // 검사 범위가 비어 있으면 통과가 무의미하므로 확인한다.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => relative(SRC_DIR, f))).toContain(join('copy', 'ko.ts'));
    expect(findForbiddenInSource(files)).toEqual([]);
  });

  it('모든 오류 코드에 문구가 있다', () => {
    for (const code of ERROR_CODES) {
      expect(errorText(code).trim(), code).not.toBe('');
      expect(errorText(code), code).not.toBe(t.errors.UNKNOWN);
    }
  });

  it('모르는 코드는 일반 오류 문구', () => {
    expect(errorText('NO_SUCH_CODE')).toBe(t.errors.UNKNOWN);
  });
});
