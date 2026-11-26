/**
 * 범용 시도 제한 모듈. 로그인(교수자)과 학생 입장(계획 1 Task 8)이 함께 쓴다.
 *
 * 한계(중요): 상태는 이 프로세스의 메모리에만 있다. 서버가 1대인 구성에서만 정확하며,
 * 서버를 재시작하면 모든 카운터가 초기화된다. 서버를 여러 대로 늘리면 인스턴스마다 따로 센다(공유 저장소 필요).
 */

export interface RateLimitResult {
  /** (check) 지금 시도를 받아도 되는가 / (hit) 이번 시도가 허용되었는가 */
  allowed: boolean;
  /** 거부되었을 때 다시 시도할 수 있기까지 남은 초(올림, 최소 1). 허용일 때도 창이 끝나기까지의 값을 준다 */
  retryAfterSec: number;
  /** 이 창에서 남은 허용 횟수 */
  remaining: number;
}

export interface RateLimiterOptions {
  /** 창 길이(ms). 키의 첫 시도부터 시작하는 고정 창이다 */
  windowMs: number;
  /** 한 창에서 허용하는 횟수 */
  max: number;
  /** 동시에 기억하는 키 수 상한. 넘으면 가장 오래된 키부터 지운다(메모리 고갈 방지) */
  maxKeys: number;
  /** 시계(ms). 테스트에서 가짜 시계를 넣는다. 기본 Date.now */
  now?: () => number;
}

export interface RateLimiter {
  /** 횟수를 늘리지 않고, 한 번 더 시도를 받아도 되는지 본다 */
  check(key: string): RateLimitResult;
  /** 시도를 한 번 센다. 이미 max에 도달했으면 세지 않고 거부한다 */
  hit(key: string): RateLimitResult;
  /** 그 키의 기록을 지운다(예: 로그인 성공) */
  reset(key: string): void;
  /** 지금 기억 중인 키 수 */
  size(): number;
}

interface Entry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max, maxKeys } = options;
  const now = options.now ?? Date.now;
  if (!(windowMs > 0) || !(max >= 1) || !(maxKeys >= 1)) throw new Error('createRateLimiter: windowMs, max, maxKeys는 양수여야 합니다.');

  // Map은 삽입 순서를 유지한다. 모든 창 길이가 같고 "새 창이 시작될 때만(delete 후 set)" 삽입하므로
  // 맨 앞이 항상 가장 일찍 만료되는 항목이다. 그래서 정리는 앞에서부터 만료된 것만 지우면 되고(분할 상환 O(1)),
  // 상한 초과 때 맨 앞을 지우면 "가장 오래된 키"를 지우는 것이 된다.
  const entries = new Map<string, Entry>();

  // 시계가 뒤로 가면(NTP 보정·VM 복원 등) 저장된 resetAt이 "지금 + 창 길이"보다 멀어져 차단이 아주 길어질 수 있다.
  // 그래서 resetAt - now > windowMs이면 now + windowMs로 줄인다. 정리(sweep)가 앞쪽부터 같은 보정을 하므로
  // 삽입 순서 = 만료 순서 가정이 유지된다: 시계가 뒤로 가면 범위를 벗어나는 항목은 항상 맨 앞쪽 연속 구간이고
  // (앞쪽일수록 resetAt이 작았으므로) 그 구간이 모두 now + windowMs로 같아져 비내림차순이 보존된다.
  // 정상일 때는 맨 앞 항목이 범위 안이라 첫 반복에서 멈춘다(O(1)).
  function sweep(t: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= t) entries.delete(key);
      else if (entry.resetAt - t > windowMs) entry.resetAt = t + windowMs;
      else break;
    }
  }

  function view(entry: Entry | undefined, t: number): RateLimitResult {
    if (entry && entry.resetAt <= t) entry = undefined; // 만료 시각이 지난 항목은 없는 것으로 본다
    if (entry && entry.resetAt - t > windowMs) entry.resetAt = t + windowMs;
    if (!entry) return { allowed: true, retryAfterSec: 1, remaining: max };
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    return { allowed: entry.count < max, retryAfterSec, remaining: Math.max(0, max - entry.count) };
  }

  return {
    check(key) {
      const t = now();
      sweep(t);
      return view(entries.get(key), t);
    },
    hit(key) {
      const t = now();
      sweep(t);
      let entry = entries.get(key);
      if (entry && entry.resetAt <= t) {
        entries.delete(key); // 뒤에 다시 넣어 삽입 순서 = 만료 순서를 지킨다
        entry = undefined;
      }
      if (entry && entry.resetAt - t > windowMs) entry.resetAt = t + windowMs;
      if (!entry) {
        while (entries.size >= maxKeys) {
          const oldest = entries.keys().next().value as string;
          entries.delete(oldest);
        }
        entry = { count: 0, resetAt: t + windowMs };
        entries.set(key, entry);
      }
      if (entry.count >= max) return { ...view(entry, t), allowed: false };
      entry.count += 1;
      return { ...view(entry, t), allowed: true };
    },
    reset(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}

export interface ConcurrencyLimiter {
  /** 슬롯을 얻으면 release 함수, 가득 찼으면 null. release는 한 번만 효과가 있다 */
  tryAcquire(): (() => void) | null;
  /** 지금 사용 중인 슬롯 수 */
  active(): number;
}

/** 동시에 실행 중인 작업 수의 상한. 사용하는 쪽은 반드시 try/finally로 release한다. */
export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  if (!(max >= 1)) throw new Error('createConcurrencyLimiter: max는 1 이상이어야 합니다.');
  let inUse = 0;
  return {
    tryAcquire() {
      if (inUse >= max) return null;
      inUse += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inUse -= 1;
      };
    },
    active() {
      return inUse;
    },
  };
}
