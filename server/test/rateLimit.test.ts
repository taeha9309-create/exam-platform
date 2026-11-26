import { describe, expect, it } from 'vitest';
import { createConcurrencyLimiter, createRateLimiter } from '../src/security/rateLimit';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createRateLimiter: 시간 창 카운터', () => {
  it('창 안에서 max번까지 허용하고 초과하면 거부한다', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 60_000, max: 3, maxKeys: 100, now: clock.now });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    const third = rl.hit('a');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = rl.hit('a');
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(rl.check('a').allowed).toBe(false);
  });

  it('키마다 따로 센다', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100, now: fakeClock().now });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.hit('b').allowed).toBe(true);
  });

  it('창이 지나면 다시 허용한다(가짜 시계)', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100, now: clock.now });
    rl.hit('a');
    expect(rl.hit('a').allowed).toBe(false);
    clock.advance(59_999);
    expect(rl.check('a').allowed).toBe(false);
    clock.advance(1);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
  });

  it('check는 횟수를 늘리지 않는다', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100, now: fakeClock().now });
    for (let i = 0; i < 5; i++) expect(rl.check('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
  });

  it('reset은 그 키만 초기화한다', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100, now: fakeClock().now });
    rl.hit('a');
    rl.hit('b');
    rl.reset('a');
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(false);
    rl.reset('없는 키'); // 오류 없음
  });

  it('retryAfterSec은 남은 시간을 올림하고 최소 1이다', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100, now: clock.now });
    rl.hit('a');
    expect(rl.hit('a').retryAfterSec).toBe(60);
    clock.advance(1); // 남은 59_999ms
    expect(rl.check('a').retryAfterSec).toBe(60); // 올림
    clock.advance(58_000); // 남은 1_999ms
    expect(rl.check('a').retryAfterSec).toBe(2);
    clock.advance(1_500); // 남은 499ms
    expect(rl.check('a').retryAfterSec).toBe(1); // 최소 1
    clock.advance(499); // 남은 0 직전... 1ms
    expect(rl.check('a').retryAfterSec).toBe(1);
  });

  it('키를 아무리 많이 만들어도 size는 maxKeys를 넘지 않고, 가장 오래된 것부터 제거한다', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 50, now: clock.now });
    for (let i = 0; i < 10_000; i++) {
      rl.hit(`k${i}`);
      expect(rl.size()).toBeLessThanOrEqual(50);
    }
    expect(rl.size()).toBe(50);
    expect(rl.check('k0').allowed).toBe(true); // 제거됨(새로 시작)
    expect(rl.check('k9999').allowed).toBe(false); // 최근 것은 유지
  });

  it('만료된 항목은 다른 키 접근 때 정리된다', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1_000, max: 1, maxKeys: 1_000, now: clock.now });
    for (let i = 0; i < 100; i++) rl.hit(`k${i}`);
    expect(rl.size()).toBe(100);
    clock.advance(1_000);
    rl.hit('새 키');
    expect(rl.size()).toBe(1);
  });

  it('창이 갱신된 키도 다시 뒤로 가서 정리 순서가 어긋나지 않는다', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1_000, max: 1, maxKeys: 1_000, now: clock.now });
    rl.hit('a');
    clock.advance(500);
    rl.hit('b');
    clock.advance(600); // a 만료, b 유효
    rl.hit('a'); // 새 창
    expect(rl.size()).toBe(2); // b, a
    expect(rl.check('b').allowed).toBe(false);
    clock.advance(500); // b 만료, a 유효
    rl.hit('c');
    expect(rl.size()).toBe(2); // a, c
    expect(rl.check('a').allowed).toBe(false);
  });

  it('시계가 크게 뒤로 가도 retryAfter가 창 길이를 넘지 않는다', () => {
    const clock = fakeClock(10_000_000);
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100, now: clock.now });
    rl.hit('a');
    clock.advance(-3_600_000);
    expect(rl.check('a').retryAfterSec).toBeLessThanOrEqual(60);
    expect(rl.hit('a')).toMatchObject({ allowed: false });
    expect(rl.hit('a').retryAfterSec).toBeLessThanOrEqual(60);
    clock.advance(60_000); // 줄어든 창이 끝난다
    expect(rl.check('a').allowed).toBe(true);
  });

  it('만료 시각이 된 항목은(정리 전이라도) 없는 것으로 본다', () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ windowMs: 1_000, max: 1, maxKeys: 100, now: clock.now });
    rl.hit('a');
    clock.advance(1_000);
    expect(rl.check('a')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('잘못된 설정은 거부한다', () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1, maxKeys: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1, max: 0, maxKeys: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1, max: 1, maxKeys: 0 })).toThrow();
  });
});

describe('createConcurrencyLimiter: 동시 실행 상한', () => {
  it('max개까지 얻고 그 이상은 null, release하면 다시 얻는다', () => {
    const cl = createConcurrencyLimiter(2);
    const a = cl.tryAcquire();
    const b = cl.tryAcquire();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(cl.tryAcquire()).toBeNull();
    a!();
    const c = cl.tryAcquire();
    expect(c).toBeTypeOf('function');
    expect(cl.tryAcquire()).toBeNull();
    b!();
    c!();
    expect(cl.active()).toBe(0);
  });

  it('같은 release를 여러 번 불러도 한 번만 반환된다', () => {
    const cl = createConcurrencyLimiter(1);
    const a = cl.tryAcquire()!;
    a();
    a();
    a();
    expect(cl.active()).toBe(0);
    const b = cl.tryAcquire();
    expect(b).not.toBeNull();
    expect(cl.tryAcquire()).toBeNull(); // 중복 release로 슬롯이 늘어나지 않았다
    a(); // 이전 release가 새 슬롯을 반환하면 안 된다
    expect(cl.tryAcquire()).toBeNull();
  });

  it('finally로 release하면 예외가 나도 슬롯이 돌아온다', async () => {
    const cl = createConcurrencyLimiter(1);
    const run = async () => {
      const release = cl.tryAcquire();
      if (!release) throw new Error('busy');
      try {
        throw new Error('boom');
      } finally {
        release();
      }
    };
    await expect(run()).rejects.toThrow('boom');
    expect(cl.active()).toBe(0);
    expect(cl.tryAcquire()).not.toBeNull();
  });

  it('잘못된 max는 거부한다', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
  });
});
