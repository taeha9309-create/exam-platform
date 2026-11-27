import { describe, expect, it } from 'vitest';
import { detectBrowser } from './browserCheck';

describe('detectBrowser', () => {
  it('Chrome', () => expect(detectBrowser([{ brand: 'Not A;Brand' }, { brand: 'Google Chrome' }])).toBe('chrome'));
  it('Edge', () => expect(detectBrowser([{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }])).toBe('edge'));
  it('userAgentData가 없으면(Firefox 등) 지원하지 않음', () => expect(detectBrowser(undefined)).toBe('unsupported'));
  it('Whale 등 다른 Chromium 계열은 지원하지 않음', () => expect(detectBrowser([{ brand: 'Whale' }, { brand: 'Chromium' }])).toBe('unsupported'));
  it('빈 목록', () => expect(detectBrowser([])).toBe('unsupported'));
});
