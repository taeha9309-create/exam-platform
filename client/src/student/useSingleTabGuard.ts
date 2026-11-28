import { useEffect, useState } from 'react';

/** Web Locks(navigator.locks) 중 쓰는 부분만. 테스트에서 가짜로 바꿔 끼운다. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

export type TabGuardState = 'checking' | 'owner' | 'blocked';

export interface TabGuardOptions {
  /** 기본은 navigator.locks. null이면 미지원 환경으로 본다. */
  locks?: LockManagerLike | null;
  /** 첫 시도 실패 뒤 다시 시도하는 횟수(새로고침 직후 이전 페이지의 락 해제가 늦을 수 있다) */
  retries?: number;
  intervalMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultLocks(): LockManagerLike | null {
  return typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks as unknown as LockManagerLike) : null;
}

/**
 * 같은 응시 화면은 한 탭에서만 활성화한다(#95). 탭별 seq 카운터가 충돌하면 서버가 신호를 중복으로 버리기 때문이다.
 * 락은 탭 수명(언마운트·탭 닫힘) 동안 쥔다. 락을 못 얻으면 'blocked'. 미지원·오류 시에는 막지 않는다.
 */
export function useSingleTabGuard(key: string, options: TabGuardOptions = {}): TabGuardState {
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  const retries = options.retries ?? 4;
  const intervalMs = options.intervalMs ?? 500;
  const [state, setState] = useState<TabGuardState>(locks ? 'checking' : 'owner');

  useEffect(() => {
    if (!locks) return;
    let cancelled = false;
    let release: (() => void) | null = null;

    const tryAcquire = () =>
      new Promise<boolean>((resolve) => {
        locks
          .request(key, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(false);
              return;
            }
            resolve(true);
            return new Promise<void>((r) => {
              release = r;
              if (cancelled) r();
            });
          })
          .catch(() => resolve(true)); // 락 API 오류는 가드 없이 진행(응시를 막지 않는다)
      });

    void (async () => {
      for (let i = 0; i <= retries; i++) {
        if (cancelled) return;
        if (await tryAcquire()) {
          if (!cancelled) setState('owner');
          return;
        }
        if (i < retries) await sleep(intervalMs);
      }
      if (!cancelled) setState('blocked');
    })();

    return () => {
      cancelled = true;
      (release as (() => void) | null)?.();
    };
  }, [key, locks, retries, intervalMs]);

  return state;
}
