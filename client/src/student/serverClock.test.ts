import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerClock } from './serverClock';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createServerClock', () => {
  it('학생 PC 시계가 5분 빨라도 now()는 서버 기준 값이다', () => {
    const serverNow = Date.UTC(2026, 10, 27, 5, 0, 0);
    vi.setSystemTime(serverNow + 5 * 60_000); // 학생 시계가 +5분
    const clock = createServerClock(serverNow); // receivedAt 기본값 = 학생의 Date.now()
    expect(clock.now()).toBe(serverNow);
    vi.advanceTimersByTime(3000);
    expect(clock.now()).toBe(serverNow + 3000);
  });

  it('receivedAt을 직접 줄 수 있다(오프셋 = serverNow - receivedAt)', () => {
    vi.setSystemTime(10_000);
    const clock = createServerClock(100_000, 15_000);
    expect(clock.now()).toBe(95_000);
  });

  it('학생 시계가 5분 느려도 남은 시간 계산이 같다', () => {
    const serverNow = 1_000_000_000;
    vi.setSystemTime(serverNow - 5 * 60_000);
    const clock = createServerClock(serverNow);
    const deadline = serverNow + 60_000;
    expect(deadline - clock.now()).toBe(60_000);
  });
});
