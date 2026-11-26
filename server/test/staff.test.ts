import jwt from 'jsonwebtoken';
import request from 'supertest';
import { compare, hash } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { hashPassword, signStaffToken, verifyPassword, verifyStaffToken } from '../src/auth/staffAuth';
import { prisma } from '../src/db';
import { createStaff, CreateStaffError } from '../../scripts/create-staff.js';
import { makeLoginStaff, staffCookie, TEST_PASSWORD } from './helpers/auth';
import { makeStaff, resetDb } from './helpers/db';

// 로그인 때 bcrypt 비교·해시가 실제로 몇 번 호출되는지 세기 위해 compare·hash를 감싼다(동작은 그대로).
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return { ...actual, compare: vi.fn(actual.compare), hash: vi.fn(actual.hash) };
});

const SECRET = process.env.JWT_SECRET as string;
const ORIGINAL_ENV = { ...process.env };
// 이 파일의 테스트는 같은 앱으로 로그인을 수백 번 반복하므로 시도 제한을 사실상 끈다(제한 자체는 loginProtection.test.ts).
const LOOSE = { windowMs: 60_000, max: 1_000_000 };
const app = createApp({ staff: { loginProtection: { ip: LOOSE, account: LOOSE, maxConcurrentVerifications: 1000 } } });

function restoreEnv(key: 'NODE_ENV' | 'JWT_SECRET') {
  if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
  else process.env[key] = ORIGINAL_ENV[key];
}

function setCookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x) => x.startsWith('staff_token='));
  if (!c) throw new Error('staff_token 쿠키가 없습니다');
  return c;
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(compare).mockClear();
});
afterEach(() => {
  restoreEnv('NODE_ENV');
  restoreEnv('JWT_SECRET');
});

describe('비밀번호 해시', () => {
  it('bcrypt cost 10 해시를 만들고 검증한다', async () => {
    const h = await hashPassword('pw-12345678');
    expect(h).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword('pw-12345678', h)).toBe(true);
    expect(await verifyPassword('other', h)).toBe(false);
    expect(await hashPassword('pw-12345678')).not.toBe(h); // salt가 매번 다르다
  });
});

describe('JWT 서명·검증', () => {
  it('왕복: 서명한 토큰에서 staffId를 꺼낸다', () => {
    expect(verifyStaffToken(signStaffToken('abc'))).toEqual({ staffId: 'abc' });
  });

  it('HS256·12시간 만료이고 페이로드에 staffId(sub) 외 정보가 없다', () => {
    const decoded = jwt.decode(signStaffToken('abc'), { complete: true })!;
    expect(decoded.header.alg).toBe('HS256');
    const p = decoded.payload as jwt.JwtPayload;
    expect(Object.keys(p).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(p.sub).toBe('abc');
    expect(p.exp! - p.iat!).toBe(12 * 60 * 60);
  });

  it('변조·위조·만료·다른 비밀키·alg none·다른 알고리즘·쓰레기 값은 모두 null', () => {
    const good = signStaffToken('abc');
    const [h, p, s] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', iat: 1, exp: 9999999999 })).toString('base64url');
    expect(verifyStaffToken(`${h}.${forgedPayload}.${s}`)).toBeNull(); // 내용 변조
    expect(verifyStaffToken(`${h}.${p}.${s!.slice(0, -2)}xx`)).toBeNull(); // 서명 변조
    expect(verifyStaffToken(jwt.sign({}, 'another-secret-another-secret-0000', { subject: 'abc', algorithm: 'HS256' }))).toBeNull();
    expect(verifyStaffToken(jwt.sign({}, SECRET, { subject: 'abc', algorithm: 'HS256', expiresIn: -10 }))).toBeNull(); // 만료
    expect(verifyStaffToken(jwt.sign({}, SECRET, { subject: 'abc', algorithm: 'HS512' }))).toBeNull(); // 다른 알고리즘
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"abc"}').toString('base64url')}.`;
    expect(verifyStaffToken(none)).toBeNull(); // alg none
    expect(verifyStaffToken(jwt.sign({}, SECRET, { algorithm: 'HS256' }))).toBeNull(); // sub 없음
    expect(verifyStaffToken('garbage')).toBeNull();
    expect(verifyStaffToken('')).toBeNull();
  });

  it('JWT_SECRET이 없으면 기본값으로 동작하지 않고 오류를 낸다', () => {
    delete process.env.JWT_SECRET;
    expect(() => signStaffToken('abc')).toThrow(/JWT_SECRET/);
    expect(() => verifyStaffToken('x.y.z')).toThrow(/JWT_SECRET/);
    expect(() => createApp()).toThrow(/JWT_SECRET/); // 서버 시작 시점에 바로 실패
  });

  it('운영(production)에서는 32자 미만 비밀키를 거부하고, 개발·테스트는 짧은 값도 허용한다', () => {
    process.env.JWT_SECRET = 'dev-only-change-me';
    expect(() => signStaffToken('abc')).not.toThrow();
    process.env.NODE_ENV = 'production';
    expect(() => signStaffToken('abc')).toThrow(/32/);
    expect(() => createApp()).toThrow(/32/);
    process.env.JWT_SECRET = 'x'.repeat(32);
    expect(() => signStaffToken('abc')).not.toThrow();
  });
});

describe('사용자 열거 방지: 더미 해시는 서버 시작 시점에 미리 계산한다', () => {
  it('라우터를 만들 때 더미 해시를 계산한다(처음 쓸 때 계산하면, 시작 직후 없는 이메일로 첫 로그인한 요청만 느려져 계정 유무가 드러남)', async () => {
    vi.resetModules(); // 서버를 막 시작한 상태(모듈 상태 초기화)를 재현
    const bcrypt = await import('bcryptjs');
    const { createStaffRouter } = await import('../src/routes/staff');
    vi.mocked(bcrypt.hash).mockClear();
    createStaffRouter();
    await vi.waitFor(() => expect(vi.mocked(bcrypt.hash)).toHaveBeenCalledTimes(1));
  });
});

describe('POST /api/staff/login', () => {
  it('올바른 계정: 200, { staff: {id,name,email} }만 돌려주고 비밀값은 없다', async () => {
    const s = await makeLoginStaff({ email: 'prof@test.local', name: '김교수' });
    const res = await request(app).post('/api/staff/login').send({ email: 'prof@test.local', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staff: { id: s.id, name: '김교수', email: 'prof@test.local' } });
    expect(res.text).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(res.text).not.toContain(TEST_PASSWORD);
  });

  it('쿠키 속성: staff_token, HttpOnly, SameSite=Lax, Path=/, 12시간, 개발에서는 Secure 없음', async () => {
    const s = await makeLoginStaff({ email: 'prof@test.local' });
    const res = await request(app).post('/api/staff/login').send({ email: 'prof@test.local', password: TEST_PASSWORD });
    const c = setCookieOf(res);
    expect(c).toMatch(/^staff_token=[^;]+/);
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=Lax/i);
    expect(c).toMatch(/;\s*Path=\//);
    expect(c).toMatch(/;\s*Max-Age=43200/);
    expect(c).not.toMatch(/;\s*Secure/i);
    const token = /^staff_token=([^;]+)/.exec(c)![1]!;
    expect(verifyStaffToken(token)).toEqual({ staffId: s.id });
    expect(res.text).not.toContain(token); // 토큰은 본문에 넣지 않는다
  });

  it('production에서는 Secure가 붙는다', async () => {
    await makeLoginStaff({ email: 'prof@test.local' });
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'p'.repeat(40);
    const res = await request(app).post('/api/staff/login').send({ email: 'prof@test.local', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toMatch(/;\s*Secure/i);
  });

  it('이메일은 대소문자·앞뒤 공백을 무시한다', async () => {
    await makeLoginStaff({ email: 'prof@test.local' });
    const res = await request(app).post('/api/staff/login').send({ email: '  PROF@Test.local ', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('틀린 비밀번호와 없는 이메일은 완전히 같은 401 응답이고 쿠키는 없다(사용자 열거 방지)', async () => {
    await makeLoginStaff({ email: 'prof@test.local' });
    const wrongPw = await request(app).post('/api/staff/login').send({ email: 'prof@test.local', password: 'wrong-password' });
    const noUser = await request(app).post('/api/staff/login').send({ email: 'nobody@test.local', password: 'wrong-password' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) } });
    expect(noUser.body).toEqual(wrongPw.body);
    expect(noUser.text).toBe(wrongPw.text);
    expect(wrongPw.headers['set-cookie']).toBeUndefined();
    expect(noUser.headers['set-cookie']).toBeUndefined();
  });

  it('없는 이메일일 때도 더미 해시에 대해 bcrypt 비교를 수행한다(응답 시간 차이 완화)', async () => {
    await request(app).post('/api/staff/login').send({ email: 'nobody@test.local', password: 'whatever-pw' });
    expect(vi.mocked(compare)).toHaveBeenCalledTimes(1);
    vi.mocked(compare).mockClear();
    await makeLoginStaff({ email: 'prof@test.local' });
    await request(app).post('/api/staff/login').send({ email: 'prof@test.local', password: 'wrong-password' });
    expect(vi.mocked(compare)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['빈 본문', undefined],
    ['빈 객체', {}],
    ['이메일 누락', { password: 'abc' }],
    ['비밀번호 누락', { email: 'a@b.c' }],
    ['이메일이 배열', { email: ['a@b.c'], password: 'abc' }],
    ['이메일이 객체', { email: { $ne: '' }, password: 'abc' }],
    ['비밀번호가 객체', { email: 'a@b.c', password: { $ne: '' } }],
    ['비밀번호가 숫자', { email: 'a@b.c', password: 12345678 }],
    ['비밀번호가 배열', { email: 'a@b.c', password: ['a'] }],
    ['비밀번호가 빈 문자열', { email: 'a@b.c', password: '' }],
    ['이메일 255자', { email: `${'a'.repeat(244)}@test.local`, password: 'abc' }],
    ['비밀번호 129자', { email: 'a@b.c', password: 'p'.repeat(129) }],
    ['JSON 배열 본문', ['a']],
  ])('입력 검증: %s -> 400 INVALID_INPUT', async (_name, body) => {
    const req = request(app).post('/api/staff/login');
    const res = body === undefined ? await req : await req.send(body as object);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_INPUT', message: expect.any(String) } });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('경계값: 이메일 254자·비밀번호 128자는 검증을 통과해 401(자격 증명 오류)이 된다', async () => {
    const res = await request(app).post('/api/staff/login').send({ email: `${'a'.repeat(243)}@test.local`, password: 'p'.repeat(128) });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/staff/me', () => {
  it('쿠키 없이는 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/staff/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('로그인 쿠키로 200 { staff: { id, name, email } }', async () => {
    const s = await makeLoginStaff({ email: 'prof@test.local', name: '김교수' });
    const login = await request(app).post('/api/staff/login').send({ email: 'prof@test.local', password: TEST_PASSWORD });
    const res = await request(app).get('/api/staff/me').set('Cookie', setCookieOf(login).split(';')[0]!);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staff: { id: s.id, name: '김교수', email: 'prof@test.local' } });
    expect(res.text).not.toMatch(/passwordHash|test-hash/);
  });

  it('유효한 토큰이어도 DB에서 삭제된 교수자는 401', async () => {
    const s = await makeStaff();
    const cookie = staffCookie(s.id);
    expect((await request(app).get('/api/staff/me').set('Cookie', cookie)).status).toBe(200);
    await prisma.staff.delete({ where: { id: s.id } });
    expect((await request(app).get('/api/staff/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('학생 Bearer 토큰만으로는 401', async () => {
    const res = await request(app).get('/api/staff/me').set('Authorization', 'Bearer student-session-token-abcdef');
    expect(res.status).toBe(401);
  });

  it('토큰은 쿠키로만 받는다: Authorization 헤더·쿼리스트링·본문에 담은 유효한 교수자 토큰도 401', async () => {
    const s = await makeStaff();
    const token = signStaffToken(s.id);
    expect((await request(app).get('/api/staff/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/api/staff/me').query({ staff_token: token })).status).toBe(401);
    expect((await request(app).get('/api/staff/me').send({ staff_token: token })).status).toBe(401);
  });

  it('쿠키 값이 쓰레기·만료·alg none이면 401', async () => {
    const s = await makeStaff();
    const expired = jwt.sign({}, SECRET, { subject: s.id, algorithm: 'HS256', expiresIn: -5 });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: s.id })).toString('base64url')}.`;
    for (const v of ['garbage', expired, none]) {
      const res = await request(app).get('/api/staff/me').set('Cookie', `staff_token=${v}`);
      expect(res.status).toBe(401);
    }
  });
});

describe('POST /api/staff/logout (SPEC 7.1: 교수자 인증 필요)', () => {
  it('로그인한 교수자는 같은 속성(HttpOnly, SameSite=Lax, Path=/)으로 쿠키를 지운다', async () => {
    const staff = await makeLoginStaff();
    const res = await request(app).post('/api/staff/logout').set('Cookie', staffCookie(staff.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const c = setCookieOf(res);
    expect(c).toMatch(/^staff_token=;/);
    expect(c).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=Lax/i);
    expect(c).toMatch(/;\s*Path=\//);
    expect(c).not.toMatch(/;\s*Secure/i);
  });

  it('인증 없는 요청은 401이고 쿠키를 지우지 않는다(교차 사이트에서 감독관을 강제 로그아웃시키는 공격 방지)', async () => {
    const res = await request(app).post('/api/staff/logout');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('만료되었거나 위조된 토큰도 401이고 쿠키를 지우지 않는다', async () => {
    const forged = jwt.sign({}, 'another-secret-another-secret-another-secret', { algorithm: 'HS256', subject: 'x' });
    const res = await request(app).post('/api/staff/logout').set('Cookie', `staff_token=${forged}`);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('삭제된 계정의 토큰도 401', async () => {
    const staff = await makeLoginStaff();
    await prisma.staff.delete({ where: { id: staff.id } });
    const res = await request(app).post('/api/staff/logout').set('Cookie', staffCookie(staff.id));
    expect(res.status).toBe(401);
  });

  it('production에서는 지우는 쿠키에도 Secure가 붙는다', async () => {
    const staff = await makeLoginStaff();
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'p'.repeat(40);
    const res = await request(app).post('/api/staff/logout').set('Cookie', staffCookie(staff.id));
    expect(setCookieOf(res)).toMatch(/;\s*Secure/i);
  });
});

describe('로그인 입력의 제어 문자(NUL 등)', () => {
  it('이메일·비밀번호에 제어 문자가 있으면 500이 아니라 400 INVALID_INPUT(DB 오류·로그 범람 방지)', async () => {
    for (const body of [
      { email: 'prof@test.local\u0000', password: 'x' },
      { email: 'prof\u0000@test.local', password: 'x' },
      { email: 'prof@test.local', password: 'pw\u0000x' },
      { email: 'a\u0001@test.local', password: 'x' },
      { email: 'a\u007f@test.local', password: 'x' },
    ]) {
      const res = await request(app).post('/api/staff/login').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('일반 문자와 한글·공백이 든 비밀번호는 여전히 허용된다', async () => {
    await makeLoginStaff({ email: 'ok@test.local' }, '한글 비밀번호 with space 123');
    const res = await request(app).post('/api/staff/login').send({ email: 'ok@test.local', password: '한글 비밀번호 with space 123' });
    expect(res.status).toBe(200);
  });
});

describe('createStaff (npm run create-staff의 핵심 로직)', () => {
  it('교수자를 만들고 비밀번호는 bcrypt 해시로만 저장한다', async () => {
    const out = await createStaff({ email: 'New@Test.local', name: ' 박교수 ', password: 'pw-12345678' });
    expect(out.email).toBe('new@test.local');
    const row = await prisma.staff.findUniqueOrThrow({ where: { email: 'new@test.local' } });
    expect(row.name).toBe('박교수');
    expect(row.passwordHash).not.toContain('pw-12345678');
    expect(await verifyPassword('pw-12345678', row.passwordHash)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('pw-12345678');
  });

  it('이메일이 중복이면 안내 오류를 던진다', async () => {
    await createStaff({ email: 'dup@test.local', name: 'A', password: 'pw-12345678' });
    await expect(createStaff({ email: 'DUP@test.local', name: 'B', password: 'pw-12345678' })).rejects.toThrow(/이미/);
    await expect(createStaff({ email: 'dup@test.local', name: 'B', password: 'pw-12345678' })).rejects.toBeInstanceOf(CreateStaffError);
  });

  it.each([
    ['이메일 형식 오류', { email: 'not-an-email', name: 'A', password: 'pw-12345678' }],
    ['이름 비어 있음', { email: 'a@test.local', name: '  ', password: 'pw-12345678' }],
    ['비밀번호 7자', { email: 'a@test.local', name: 'A', password: '1234567' }],
    ['비밀번호 73바이트', { email: 'a@test.local', name: 'A', password: 'a'.repeat(73) }],
    ['한글 비밀번호 25자(75바이트)', { email: 'a@test.local', name: 'A', password: '가'.repeat(25) }],
  ])('입력 검증: %s는 거부하고 DB에 만들지 않는다', async (_n, input) => {
    await expect(createStaff(input)).rejects.toBeInstanceOf(CreateStaffError);
    expect(await prisma.staff.count()).toBe(0);
  });

  it('비밀번호 8자·72바이트 경계는 허용한다', async () => {
    await createStaff({ email: 'a@test.local', name: 'A', password: '12345678' });
    await createStaff({ email: 'b@test.local', name: 'B', password: 'a'.repeat(72) });
    expect(await prisma.staff.count()).toBe(2);
  });

  it('오류 메시지에 비밀번호를 넣지 않는다', async () => {
    const pw = 'short';
    const err = await createStaff({ email: 'a@test.local', name: 'A', password: pw }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(CreateStaffError);
    expect((err as Error).message).not.toContain(pw);
  });
});
