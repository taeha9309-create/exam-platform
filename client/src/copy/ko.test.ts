import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@exam/shared';
import { errorText, t } from './ko';

const FORBIDDEN = ['부정행위', 'AI 사용', '적발', '커닝'];

describe('화면 문구', () => {
  it('금지어가 없다', () => {
    const all = JSON.stringify(t);
    for (const w of FORBIDDEN) expect(all).not.toContain(w);
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
