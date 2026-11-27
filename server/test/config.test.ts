import { describe, expect, it } from 'vitest';
import { parsePort, parseTrustProxyHops } from '../src/config';

describe('parsePort', () => {
  it('값이 없으면 기본값 3000', () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort('')).toBe(3000);
  });

  it('1~65535 정수 문자열은 숫자로 바꾼다', () => {
    expect(parsePort('8080')).toBe(8080);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort(' 3000 ')).toBe(3000);
  });

  it('잘못된 값은 값을 보여 주는 한국어 오류', () => {
    for (const bad of ['abc', '0', '65536', '-1', '3000.5', '80a', '1e3', '0x50']) {
      expect(() => parsePort(bad), bad).toThrow(/PORT/);
      expect(() => parsePort(bad), bad).toThrow(bad);
    }
  });

  it('기본값을 바꿀 수 있다', () => {
    expect(parsePort(undefined, 4000)).toBe(4000);
  });
});

describe('parseTrustProxyHops', () => {
  const prod = (v?: string): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production',
    ...(v === undefined ? {} : { TRUST_PROXY_HOPS: v }),
  });

  it('운영에서 미설정·빈 문자열이면 기본 1', () => {
    expect(parseTrustProxyHops(prod())).toBe(1);
    expect(parseTrustProxyHops(prod(''))).toBe(1);
  });

  it('운영에서 1~3 정수 문자열은 숫자로 바꾼다', () => {
    expect(parseTrustProxyHops(prod('1'))).toBe(1);
    expect(parseTrustProxyHops(prod('2'))).toBe(2);
    expect(parseTrustProxyHops(prod('3'))).toBe(3);
  });

  it('운영에서 범위 밖·비정수·불리언·공백 포함 값은 거부한다', () => {
    for (const bad of ['0', '4', '-1', '1.5', 'abc', 'true', 'loopback', ' ', ' 3 ', '2 ', '02', '1e1']) {
      expect(() => parseTrustProxyHops(prod(bad)), bad).toThrow(/TRUST_PROXY_HOPS/);
    }
  });

  it('오류 메시지는 긴 값을 잘라 낸다', () => {
    expect(() => parseTrustProxyHops(prod('x'.repeat(200)))).toThrow(/^[^x]*x{0,20}[^x]*$/);
  });

  it('운영이 아니면 값이 있어도(잘못된 값도) undefined', () => {
    expect(parseTrustProxyHops({ NODE_ENV: 'test', TRUST_PROXY_HOPS: '2' })).toBeUndefined();
    expect(parseTrustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBeUndefined();
    expect(parseTrustProxyHops({ NODE_ENV: 'development', TRUST_PROXY_HOPS: 'abc' })).toBeUndefined();
  });
});
