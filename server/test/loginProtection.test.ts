import request from 'supertest';
import { compare } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { normalizeIpKey } from '../src/security/loginProtection';
import { prisma } from '../src/db';
import { makeLoginStaff, TEST_PASSWORD } from './helpers/auth';
import { resetDb } from './helpers/db';

// bcrypt 비교 호출 수를 세고, 동시성 테스트에서 느리게 만들기 위해 compare를 감싼다(기본 동작은 그대로).
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return { ...actual, compare: vi.fn(actual.compare), hash: vi.fn(actual.hash) };
});

const actualBcrypt = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');

const EMAIL = 'prof@test.local';
const IP_A = '10.0.0.1';
const IP_B = '10.0.0.2';

let clockMs = 5_000_000;
const clock = { now: () => clockMs, advance: (ms: number) => (clockMs += ms) };

type Opts = NonNullable<NonNullable<Parameters<typeof createApp>[0]>['staff']>['loginProtection'];
function appWith(loginProtection: Opts) {
  return createApp({ trustProxy: 1, staff: { loginProtection: { now: clock.now, ...loginProtection } } });
}

function login(app: ReturnType<typeof createApp>, ip: string, email: string, password: string) {
  return request(app).post('/api/staff/login').set('X-Forwarded-For', ip).send({ email, password });
}

function expectRejected429(res: request.Response) {
  expect(res.status).toBe(429);
  expect(res.body).toEqual({ error: { code: 'TOO_MANY_ATTEMPTS', message: expect.any(String) } });
  expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
  expect(res.headers['set-cookie']).toBeUndefined();
}

beforeEach(async () => {
  await resetDb();
  clockMs = 5_000_000;
  vi.mocked(compare).mockReset();
  vi.mocked(compare).mockImplementation(actualBcrypt.compare as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(compare).mockImplementation(actualBcrypt.compare as never);
});

describe('로그인 IP 한도', () => {
  it('한도 초과는 429 + Retry-After, 다른 IP는 영향 없고, 창이 지나면 다시 허용한다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith({ ip: { windowMs: 60_000, max: 3 }, account: { windowMs: 900_000, max: 1000 } });
    for (let i = 0; i < 3; i++) expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
    const blocked = await login(app, IP_A, EMAIL, TEST_PASSWORD); // 올바른 비밀번호여도
    expectRejected429(blocked);
    expect(blocked.headers['retry-after']).toBe('60');

    expect((await login(app, IP_B, EMAIL, TEST_PASSWORD)).status).toBe(200); // 다른 IP

    clock.advance(30_000);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).headers['retry-after']).toBe('30');
    clock.advance(30_000);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
  });

  it('입력 검증에 걸린 요청도 한도에 센다', async () => {
    const app = appWith({ ip: { windowMs: 60_000, max: 2 } });
    expect((await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_A).send({})).status).toBe(400);
    expect((await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_A).send({ email: 1 })).status).toBe(400);
    expectRejected429(await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_A).send({}));
    expect((await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_B).send({})).status).toBe(400);
  });

  it('한도를 넘긴 잘못된 JSON 본문도 앱의 기존 처리(400)를 따른다(파서가 앞이라 제한 대상 아님)', async () => {
    // 한계 문서화용: express.json 파싱 오류는 라우터 도달 전이라 IP 한도에 세지 않는다. bcrypt를 쓰지 않으므로 비용은 싸다.
    const app = appWith({ ip: { windowMs: 60_000, max: 1 } });
    const res = await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_A).set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });
});

describe('로그인 IP+이메일 실패 한도', () => {
  const cfg = { ip: { windowMs: 60_000, max: 1000 }, account: { windowMs: 900_000, max: 5 } };

  it('5회 실패하면 6번째는 올바른 비밀번호여도 429, 같은 IP의 다른 이메일은 통과한다', async () => {
    await makeLoginStaff({ email: EMAIL });
    await makeLoginStaff({ email: 'other@test.local' });
    const app = appWith(cfg);
    for (let i = 0; i < 5; i++) expect((await login(app, IP_A, EMAIL, 'wrong-password')).status).toBe(401);
    expectRejected429(await login(app, IP_A, EMAIL, TEST_PASSWORD));
    expect((await login(app, IP_A, 'other@test.local', TEST_PASSWORD)).status).toBe(200);
  });

  it('같은 이메일의 다른 IP는 영향 없다(계정 잠금이 아니다)', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    for (let i = 0; i < 5; i++) await login(app, IP_A, EMAIL, 'wrong-password');
    expectRejected429(await login(app, IP_A, EMAIL, TEST_PASSWORD));
    expect((await login(app, IP_B, EMAIL, TEST_PASSWORD)).status).toBe(200);
  });

  it('이메일 정규화(대소문자·공백)를 우회해도 같은 조합으로 센다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    const variants = [EMAIL, ' PROF@test.local', 'Prof@Test.Local ', EMAIL, '  prof@TEST.local  '];
    for (const v of variants) expect((await login(app, IP_A, v, 'wrong-password')).status).toBe(401);
    expectRejected429(await login(app, IP_A, EMAIL, TEST_PASSWORD));
  });

  it('없는 이메일도 같은 횟수에서 같은 429를 받는다(존재하는 계정과 상태·본문·헤더 동일)', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    const results: request.Response[] = [];
    for (const email of [EMAIL, 'nobody@test.local']) {
      for (let i = 0; i < 5; i++) expect((await login(app, IP_A, email, 'wrong-password')).status).toBe(401);
      results.push(await login(app, IP_A, email, 'wrong-password'));
    }
    const [real, ghost] = results as [request.Response, request.Response];
    expectRejected429(real);
    expectRejected429(ghost);
    expect(ghost.status).toBe(real.status);
    expect(ghost.text).toBe(real.text);
    expect(ghost.headers['retry-after']).toBe(real.headers['retry-after']);
  });

  it('창이 지나면 다시 시도할 수 있다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    for (let i = 0; i < 5; i++) await login(app, IP_A, EMAIL, 'wrong-password');
    const blocked = await login(app, IP_A, EMAIL, TEST_PASSWORD);
    expectRejected429(blocked);
    expect(blocked.headers['retry-after']).toBe('900');
    clock.advance(900_000);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
  });

  it('성공하면 그 조합의 실패 카운터가 초기화된다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    for (let i = 0; i < 4; i++) await login(app, IP_A, EMAIL, 'wrong-password');
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(app, IP_A, EMAIL, 'wrong-password')).status).toBe(401);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200); // 5번 누적됐다면 429였을 것
  });

  it('입력 검증 실패는 계정 실패로 세지 않는다(이메일이 정해지지 않았으므로)', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    for (let i = 0; i < 10; i++) expect((await login(app, IP_A, EMAIL, '')).status).toBe(400);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
  });
});

describe('동시 bcrypt 상한', () => {
  const cfg = { ip: { windowMs: 60_000, max: 1000 }, account: { windowMs: 900_000, max: 1000 }, maxConcurrentVerifications: 2 };

  function gatedCompare() {
    const gates: Array<() => void> = [];
    vi.mocked(compare).mockImplementation((async (pw: string, h: string) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return actualBcrypt.compare(pw, h);
    }) as never);
    return gates;
  }

  it('동시 3건이면 2건은 진행하고 1건은 bcrypt 없이 429, 끝나면 다시 허용한다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith(cfg);
    const gates = gatedCompare();

    const p1 = login(app, '10.1.0.1', EMAIL, TEST_PASSWORD).then((r) => r);
    const p2 = login(app, '10.1.0.2', EMAIL, TEST_PASSWORD).then((r) => r);
    await vi.waitFor(() => expect(vi.mocked(compare)).toHaveBeenCalledTimes(2), { timeout: 5000 });

    const rejected = await login(app, '10.1.0.3', EMAIL, TEST_PASSWORD);
    expectRejected429(rejected);
    expect(vi.mocked(compare)).toHaveBeenCalledTimes(2); // 세 번째는 bcrypt를 실행하지 않았다

    gates.splice(0).forEach((open) => open());
    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(200);

    vi.mocked(compare).mockImplementation(actualBcrypt.compare as never);
    expect((await login(app, '10.1.0.3', EMAIL, TEST_PASSWORD)).status).toBe(200);
  });

  it('동시 상한에 걸린 요청은 DB 조회도 하지 않는다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith({ ...cfg, maxConcurrentVerifications: 1 });
    const gates = gatedCompare();
    const p1 = login(app, '10.1.0.1', EMAIL, TEST_PASSWORD).then((r) => r);
    await vi.waitFor(() => expect(vi.mocked(compare)).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const spy = vi.spyOn(prisma.staff, 'findUnique');
    expectRejected429(await login(app, '10.1.0.2', EMAIL, TEST_PASSWORD));
    expect(spy).not.toHaveBeenCalled();

    gates.splice(0).forEach((open) => open());
    expect((await p1).status).toBe(200);
  });

  it('bcrypt가 예외를 던져도 슬롯을 반환한다', async () => {
    await makeLoginStaff({ email: EMAIL });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith({ ...cfg, maxConcurrentVerifications: 1 });
    vi.mocked(compare).mockImplementationOnce((async () => {
      throw new Error('boom');
    }) as never);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(500);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
  });

  it('DB 조회가 실패해도 슬롯을 반환한다', async () => {
    await makeLoginStaff({ email: EMAIL });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith({ ...cfg, maxConcurrentVerifications: 1 });
    vi.spyOn(prisma.staff, 'findUnique').mockRejectedValueOnce(new Error('db down'));
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(500);
    expect((await login(app, IP_A, EMAIL, TEST_PASSWORD)).status).toBe(200);
  });
});

describe('429로 거절된 요청은 싸다', () => {
  it('IP 한도·계정 한도로 거절되면 bcrypt도 DB 조회도 하지 않고, 쿠키·이메일·횟수·종류를 드러내지 않는다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith({ ip: { windowMs: 60_000, max: 5 }, account: { windowMs: 900_000, max: 2 } });
    await login(app, IP_A, EMAIL, 'wrong-password');
    await login(app, IP_A, EMAIL, 'wrong-password');
    const compareCalls = vi.mocked(compare).mock.calls.length;
    const spy = vi.spyOn(prisma.staff, 'findUnique');

    const byAccount = await login(app, IP_A, EMAIL, TEST_PASSWORD); // 계정 한도
    expectRejected429(byAccount);
    await login(app, IP_A, 'x1@test.local', 'p');
    await login(app, IP_A, 'x2@test.local', 'p');
    const callsBeforeIp = vi.mocked(compare).mock.calls.length;
    spy.mockClear();
    const byIp = await login(app, IP_A, 'x3@test.local', 'p'); // IP 한도(6번째)
    expectRejected429(byIp);
    expect(vi.mocked(compare).mock.calls.length).toBe(callsBeforeIp);
    expect(spy).not.toHaveBeenCalled();
    expect(compareCalls).toBe(2);

    for (const res of [byAccount, byIp]) {
      expect(res.text).not.toContain(EMAIL);
      expect(res.text).not.toMatch(/x3@|\d/); // 횟수·시간 숫자 없음
      expect(res.text).not.toMatch(/IP|계정|동시/i);
    }
    expect(byAccount.text).toBe(byIp.text); // 어떤 제한인지 구분되지 않는다
  });
});

describe('계정 한도 거절은 bcrypt·DB 조회 전에 일어난다', () => {
  it('IP+이메일 실패 한도로 거절된 요청은 compare도 findUnique도 호출하지 않는다', async () => {
    await makeLoginStaff({ email: EMAIL });
    const app = appWith({ ip: { windowMs: 60_000, max: 1000 }, account: { windowMs: 900_000, max: 2 } });
    await login(app, IP_A, EMAIL, 'wrong-password');
    await login(app, IP_A, EMAIL, 'wrong-password');
    vi.mocked(compare).mockClear();
    const spy = vi.spyOn(prisma.staff, 'findUnique');
    expectRejected429(await login(app, IP_A, EMAIL, TEST_PASSWORD));
    expect(vi.mocked(compare)).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('IPv6 /64 집계', () => {
  const cfg = { ip: { windowMs: 60_000, max: 20 }, account: { windowMs: 900_000, max: 1000 } };
  const bad = (app: ReturnType<typeof createApp>, ip: string) => request(app).post('/api/staff/login').set('X-Forwarded-For', ip).send({});

  it('같은 /64 안의 주소를 바꿔 가며 시도해도 20회 이후 429, 다른 /64는 영향 없다', async () => {
    const app = appWith(cfg);
    for (let i = 0; i < 20; i++) expect((await bad(app, `2001:db8:1:2::${i + 1}`)).status).toBe(400);
    for (let i = 20; i < 40; i++) expectRejected429(await bad(app, `2001:db8:1:2:${i}::${i}`));
    expect((await bad(app, '2001:db8:1:3::1')).status).toBe(400);
  });

  it('::ffff:1.2.3.4 와 1.2.3.4 는 같은 IP로 센다', async () => {
    const app = appWith({ ...cfg, ip: { windowMs: 60_000, max: 2 } });
    expect((await bad(app, '1.2.3.4')).status).toBe(400);
    expect((await bad(app, '::ffff:1.2.3.4')).status).toBe(400);
    expectRejected429(await bad(app, '::FFFF:0102:0304'));
    expectRejected429(await bad(app, '1.2.3.4'));
  });

  it('대문자·0 생략·:: 압축 표기가 달라도 같은 키다', async () => {
    const app = appWith({ ...cfg, ip: { windowMs: 60_000, max: 3 } });
    expect((await bad(app, '2001:db8::1')).status).toBe(400);
    expect((await bad(app, '2001:0DB8:0000:0000:0000:0000:0000:0001')).status).toBe(400);
    expect((await bad(app, '2001:DB8:0:0::1')).status).toBe(400);
    expectRejected429(await bad(app, '2001:db8:0:0:0:0:0:2'));
  });

  it('존 ID는 제거하고 같은 키로 만든다(키 함수 단위 검사)', () => {
    expect(normalizeIpKey('fe80::1%eth0')).toBe(normalizeIpKey('fe80::2'));
    expect(normalizeIpKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIpKey('2001:DB8::1')).toBe(normalizeIpKey('2001:db8:0:0:ffff::9'));
    expect(normalizeIpKey('2001:db8:0:1::1')).not.toBe(normalizeIpKey('2001:db8::1'));
    expect(normalizeIpKey('garbage')).toBe('garbage');
    expect(normalizeIpKey(undefined)).toBe('unknown');
  });

  it('IPv4는 주소별로 따로 센다(기존 동작)', async () => {
    const app = appWith({ ...cfg, ip: { windowMs: 60_000, max: 1 } });
    expect((await bad(app, '10.0.0.1')).status).toBe(400);
    expect((await bad(app, '10.0.0.2')).status).toBe(400);
    expectRejected429(await bad(app, '10.0.0.1'));
  });

  it('IP가 문자열이 아닌 쓰레기 값이어도 그대로 한 키로 센다(기존 동작)', async () => {
    const app = appWith({ ...cfg, ip: { windowMs: 60_000, max: 1 } });
    expect((await bad(app, 'garbage')).status).toBe(400);
    expectRejected429(await bad(app, 'garbage'));
    expect((await bad(app, 'garbage2')).status).toBe(400);
  });
});

describe('기본 설정', () => {
  it('인자 없는 createApp()은 엄격한 기본값(IP 분당 20회)을 적용한다', async () => {
    const app = createApp({ trustProxy: 1 });
    let last: request.Response | undefined;
    for (let i = 0; i < 21; i++) last = await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_A).send({});
    expectRejected429(last!);
    expect((await request(app).post('/api/staff/login').set('X-Forwarded-For', IP_A).send({})).status).toBe(429);
  });

  it('기본값: 같은 IP+이메일 15분 5회 실패', async () => {
    const app = createApp({ trustProxy: 1 });
    for (let i = 0; i < 5; i++) expect((await login(app, IP_A, 'nobody@test.local', 'wrong-password')).status).toBe(401);
    expectRejected429(await login(app, IP_A, 'nobody@test.local', 'wrong-password'));
  });
});
