import { describe, expect, it } from 'vitest';
import { detectSidebarShrink } from './sidebarShrink';

const w = (outerWidth: number, innerWidth: number) => ({ outerWidth, innerWidth });

describe('detectSidebarShrink', () => {
  it('80px 미만 줄어듦은 무시', () => {
    expect(detectSidebarShrink(w(1200, 1180), w(1200, 1101))).toBeNull();
  });
  it('정확히 80px은 감지', () => {
    expect(detectSidebarShrink(w(1200, 1180), w(1200, 1100))).toEqual({ deltaInner: 80 });
  });
  it('outer가 변하면(창을 직접 줄임) null', () => {
    expect(detectSidebarShrink(w(1200, 1180), w(1100, 1000))).toBeNull();
  });
  it('늘어남·같음은 null', () => {
    expect(detectSidebarShrink(w(1200, 1000), w(1200, 1180))).toBeNull();
    expect(detectSidebarShrink(w(1200, 1000), w(1200, 1000))).toBeNull();
  });
});
