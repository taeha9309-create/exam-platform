import { describe, expect, it } from 'vitest';
import { generateExamCode, generatePasscode } from '../../src/domain/codes';

describe('generateExamCode', () => {
  it('8자 영숫자(혼동 문자 제외)를 1000회 생성한다', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateExamCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });
  it('매번 다른 값을 낸다 (중복 확률 무시 가능)', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateExamCode()));
    expect(set.size).toBe(200);
  });
});

describe('generatePasscode', () => {
  it('6자리 숫자를 1000회 생성한다', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePasscode()).toMatch(/^\d{6}$/);
    }
  });
  it('앞자리 0을 허용한다 (길이는 항상 6)', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generatePasscode()));
    expect([...seen].some((p) => p.startsWith('0'))).toBe(true);
  });
});
