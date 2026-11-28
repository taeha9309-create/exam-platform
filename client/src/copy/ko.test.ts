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

/**
 * 주석만 공백으로 바꾸고 줄 수(개행)는 그대로 둔다.
 * - 블록 주석 /* ... *\/ : 내용을 지우고 개행은 보존한다(같은 줄의 코드는 남긴다).
 * - 줄 주석 // ... : 줄 시작이나 공백 뒤에서만 주석으로 본다. 문자열 안의 URL(http://)은 건드리지 않는다.
 * - 문자열('', "", ``) 안의 내용은 주석으로 보지 않는다.
 */
export function stripComments(src: string): string {
  let out = '';
  let state: 'code' | 'sq' | 'dq' | 'tpl' = 'code';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        for (const ch of src.slice(i, stop)) out += ch === '\n' ? '\n' : ' ';
        i = stop;
        continue;
      }
      if (c === '/' && next === '/' && (i === 0 || /\s/.test(src[i - 1]!))) {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        out += ' '.repeat(stop - i);
        i = stop;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      i++;
      continue;
    }
    // 문자열 안
    if (c === '\\') {
      out += c + (next ?? '');
      i += 2;
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    out += c;
    i++;
  }
  return out;
}

/** 주석을 뺀 소스에서 금지어가 나오는 줄 번호와 금지어를 찾는다(줄 번호는 원본과 같다). */
export function findForbiddenInSource(source: string, forbidden: string[]): { line: number; word: string }[] {
  const hits: { line: number; word: string }[] = [];
  stripComments(source)
    .split(/\r?\n/)
    .forEach((text, i) => {
      for (const word of forbidden) {
        if (text.includes(word)) hits.push({ line: i + 1, word });
      }
    });
  return hits;
}

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
    const hits = files.flatMap((file) => {
      const found = findForbiddenInSource(readFileSync(file, 'utf8'), FORBIDDEN);
      return found.map((h) => `${relative(SRC_DIR, file)}:${h.line} "${h.word}"`);
    });
    expect(hits).toEqual([]);
  });

  describe('금지어 검사 헬퍼(findForbiddenInSource)', () => {
    it('같은 줄의 블록 주석 뒤 코드에 있는 금지어는 탐지한다', () => {
      const src = '/* x */ export const zz = "부정행위";';
      expect(findForbiddenInSource(src, FORBIDDEN)).toEqual([{ line: 1, word: '부정행위' }]);
    });

    it('줄 주석 안의 금지어는 통과한다', () => {
      expect(findForbiddenInSource('// 부정행위 설명\nconst a = 1;', FORBIDDEN)).toEqual([]);
    });

    it('여러 줄 블록 주석 안의 금지어는 통과하고 줄 번호가 유지된다', () => {
      const src = '/*\n 부정행위\n 커닝\n*/\nconst a = "적발";';
      expect(findForbiddenInSource(src, FORBIDDEN)).toEqual([{ line: 5, word: '적발' }]);
    });

    it('블록 주석 밖의 * 로 시작하는 줄은 코드이므로 탐지한다', () => {
      const src = 'const a = 1;\n* "커닝"';
      expect(findForbiddenInSource(src, FORBIDDEN)).toEqual([{ line: 2, word: '커닝' }]);
    });

    it('문자열 안의 URL(//)은 주석으로 보지 않아 뒤의 금지어를 탐지한다', () => {
      const src = 'const u = "http://x" + "커닝";';
      expect(findForbiddenInSource(src, FORBIDDEN)).toEqual([{ line: 1, word: '커닝' }]);
    });

    it('줄 번호는 원본 파일 기준이다', () => {
      const src = 'a\n/* \n*/ "적발"';
      expect(findForbiddenInSource(src, FORBIDDEN)).toEqual([{ line: 3, word: '적발' }]);
    });
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
