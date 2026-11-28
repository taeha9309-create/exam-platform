// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LockManagerLike, useSingleTabGuard } from './useSingleTabGuard';

/** Web Locks의 ifAvailable 동작만 흉내 낸 가짜: 이미 쥐고 있으면 콜백에 null을 준다. */
function makeLocks() {
  const held = new Set<string>();
  const locks: LockManagerLike = {
    request: vi.fn((name: string, _opts: { ifAvailable: true }, cb: (lock: unknown) => unknown) => {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    }) as LockManagerLike['request'],
  };
  return { locks, held };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

describe('useSingleTabGuard (#95)', () => {
  it('첫 탭은 락을 얻어 owner가 된다', async () => {
    const { locks, held } = makeLocks();
    const { result } = renderHook(() => useSingleTabGuard('EXAM1', { locks }));
    expect(result.current).toBe('checking');
    await flush();
    expect(result.current).toBe('owner');
    expect(held.size).toBe(1);
  });

  it('두 번째 탭은 재시도 끝에 blocked가 된다', async () => {
    const { locks } = makeLocks();
    renderHook(() => useSingleTabGuard('EXAM1', { locks }));
    await flush();
    const second = renderHook(() => useSingleTabGuard('EXAM1', { locks, retries: 3, intervalMs: 500 }));
    await flush();
    expect(second.result.current).toBe('checking');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(second.result.current).toBe('blocked');
    expect(locks.request).toHaveBeenCalledTimes(1 + 4);
  });

  it('다른 응시 키는 서로 막지 않는다', async () => {
    const { locks } = makeLocks();
    renderHook(() => useSingleTabGuard('EXAM1', { locks }));
    const other = renderHook(() => useSingleTabGuard('EXAM2', { locks }));
    await flush();
    expect(other.result.current).toBe('owner');
  });

  it('재시도 중 이전 락이 풀리면 owner가 된다(새로고침 직후)', async () => {
    const { locks } = makeLocks();
    const first = renderHook(() => useSingleTabGuard('EXAM1', { locks }));
    await flush();
    const second = renderHook(() => useSingleTabGuard('EXAM1', { locks, retries: 4, intervalMs: 500 }));
    await flush();
    expect(second.result.current).toBe('checking');
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(second.result.current).toBe('owner');
  });

  it('Web Locks 미지원이면 가드 없이 owner', () => {
    const { result } = renderHook(() => useSingleTabGuard('EXAM1', { locks: null }));
    expect(result.current).toBe('owner');
  });

  it('락 요청이 예외를 던지면 막지 않는다', async () => {
    const locks: LockManagerLike = { request: vi.fn(() => Promise.reject(new Error('SecurityError'))) as LockManagerLike['request'] };
    const { result } = renderHook(() => useSingleTabGuard('EXAM1', { locks }));
    await flush();
    expect(result.current).toBe('owner');
  });

  it('언마운트하면 락을 놓는다', async () => {
    const { locks, held } = makeLocks();
    const { unmount } = renderHook(() => useSingleTabGuard('EXAM1', { locks }));
    await flush();
    expect(held.size).toBe(1);
    unmount();
    await flush();
    expect(held.size).toBe(0);
  });
});
