import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_DATABASE_URL, redactConnectionStrings, testDatabaseUrl } from './testDatabase';

describe('testDatabaseUrl: 어떤 환경에서도 개발 DB를 가리키지 않는다', () => {
  it('아무 설정이 없으면 기본 exam_test', () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it('DATABASE_URL이 개발 DB(…/exam)면 무시하고 기본값을 쓴다', () => {
    expect(testDatabaseUrl({ DATABASE_URL: 'postgresql://exam:exam@localhost:5432/exam' })).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it('DATABASE_URL이 _test로 끝나면(CI) 그것을 쓴다', () => {
    const ci = 'postgresql://exam:exam@localhost:5432/exam_test';
    expect(testDatabaseUrl({ DATABASE_URL: ci })).toBe(ci);
  });

  it('TEST_DATABASE_URL이 가장 우선한다(전용 DB)', () => {
    const own = 'postgresql://exam:exam@localhost:5432/exam_t4_test';
    expect(testDatabaseUrl({ TEST_DATABASE_URL: own, DATABASE_URL: 'postgresql://exam:exam@localhost:5432/exam' })).toBe(own);
  });
});

describe('redactConnectionStrings: 오류 출력에서 접속 문자열을 가린다', () => {
  it('비밀번호가 든 접속 문자열을 가린다', () => {
    const out = redactConnectionStrings('connect failed: postgresql://exam:SuperSecret@db.example.com:5432/exam?sslmode=require end');
    expect(out).not.toContain('SuperSecret');
    expect(out).not.toContain('db.example.com');
    expect(out).toBe('connect failed: postgresql://*** end');
  });

  it('여러 개와 따옴표·다른 스킴도 가린다', () => {
    const out = redactConnectionStrings(`a "postgres://u:p1@h/d" b 'mongodb+srv://u:p2@c.net/x' c redis://:p3@r:6379`);
    expect(out).not.toMatch(/p1|p2|p3/);
  });

  it('TLS Redis(rediss://)와 비밀번호가 없는 형태도 가린다', () => {
    expect(redactConnectionStrings('x rediss://u:secret@h:6380 y')).toBe('x rediss://*** y');
    expect(redactConnectionStrings('postgresql://user@host/db')).toBe('postgresql://***');
  });

  it('접속 문자열이 없으면 그대로 둔다', () => {
    expect(redactConnectionStrings('Error: P1001 Can\'t reach database server')).toBe('Error: P1001 Can\'t reach database server');
  });
});
