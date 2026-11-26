import { describe, expect, it } from 'vitest';
import { hasControlChars, hasLoneSurrogate, safeString } from '../src/validation';

const NUL = String.fromCharCode(0);

describe('safeString', () => {
  it('일반 문자열(한글·이모지)을 통과시킨다', () => {
    expect(safeString({ min: 1, max: 10 }).safeParse('시험 😀').success).toBe(true);
  });

  it('길이 상한·하한을 지킨다', () => {
    expect(safeString({ min: 1, max: 3 }).safeParse('').success).toBe(false);
    expect(safeString({ min: 1, max: 3 }).safeParse('abcd').success).toBe(false);
    expect(safeString({ min: 0, max: 3 }).safeParse('').success).toBe(true);
  });

  it('NUL·제어 문자·DEL을 거부한다', () => {
    const s = safeString({ min: 0, max: 100 });
    for (const code of [0, 1, 8, 11, 12, 27, 31, 127]) {
      expect(s.safeParse(`a${String.fromCharCode(code)}b`).success, `code ${code}`).toBe(false);
    }
  });

  it('줄바꿈·탭은 기본적으로 거부하고 allowNewlines일 때만 허용한다', () => {
    expect(safeString({ min: 0, max: 100 }).safeParse('a\nb').success).toBe(false);
    expect(safeString({ min: 0, max: 100 }).safeParse('a\tb').success).toBe(false);
    const s = safeString({ min: 0, max: 100, allowNewlines: true });
    expect(s.safeParse('a\nb\r\n\tc').success).toBe(true);
    expect(s.safeParse(`a${NUL}b`).success).toBe(false);
  });

  it('짝 없는 서로게이트를 거부한다', () => {
    const s = safeString({ min: 0, max: 100, allowNewlines: true });
    expect(s.safeParse('a\ud800b').success).toBe(false);
    expect(s.safeParse('a\udc00b').success).toBe(false);
    expect(s.safeParse('끝\ud83d').success).toBe(false);
    expect(s.safeParse('😀').success).toBe(true);
  });

  it('문자열이 아니면 거부한다', () => {
    expect(safeString({ min: 0, max: 5 }).safeParse(5).success).toBe(false);
  });
});

describe('길이 단위', () => {
  it('길이는 code point(글자) 기준이다: 이모지 51개는 max 100을 통과, 101개는 거부', () => {
    const s = safeString({ min: 1, max: 100 });
    expect(s.safeParse('😀'.repeat(51)).success).toBe(true);
    expect(s.safeParse('😀'.repeat(100)).success).toBe(true);
    expect(s.safeParse('😀'.repeat(101)).success).toBe(false);
  });
});

describe('판별 함수', () => {
  it('hasControlChars', () => {
    expect(hasControlChars(`x${NUL}`, false)).toBe(true);
    expect(hasControlChars('x\n', false)).toBe(true);
    expect(hasControlChars('x\n', true)).toBe(false);
  });
  it('hasLoneSurrogate', () => {
    expect(hasLoneSurrogate('\ud800')).toBe(true);
    expect(hasLoneSurrogate('😀')).toBe(false);
  });
});
