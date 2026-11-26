import { describe, expect, it } from 'vitest';
import { parsePort } from '../src/config';

describe('parsePort', () => {
  it('값이 없으면 기본값 3000', () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort('')).toBe(3000);
  });

  it('1~65535 정수 문자열은 숫자로 바꾼다', () => {
    expect(parsePort('8080')).toBe(8080);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort(' 3000 ')).toBe(3000);
  });

  it('잘못된 값은 값을 보여 주는 한국어 오류', () => {
    for (const bad of ['abc', '0', '65536', '-1', '3000.5', '80a', '1e3', '0x50']) {
      expect(() => parsePort(bad), bad).toThrow(/PORT/);
      expect(() => parsePort(bad), bad).toThrow(bad);
    }
  });

  it('기본값을 바꿀 수 있다', () => {
    expect(parsePort(undefined, 4000)).toBe(4000);
  });
});
