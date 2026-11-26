import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

afterEach(() => vi.unstubAllGlobals());

describe('api()', () => {
  it('성공 시 JSON을 돌려주고 body를 JSON으로 보낸다', async () => {
    const f = mockFetch(async () => json(200, { ok: true }));
    const r = await api<{ ok: boolean }>('POST', '/api/x', { a: 1 });
    expect(r).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.credentials).toBe('same-origin');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
  });

  it('토큰이 있으면 Authorization: Bearer', async () => {
    const f = mockFetch(async () => json(200, {}));
    await api('GET', '/api/student/attempt', undefined, { token: 'abc' });
    const init = f.mock.calls[0]![1];
    expect(headersOf(init).Authorization).toBe('Bearer abc');
    expect(init.body).toBeUndefined();
  });

  it('토큰이 없으면 Authorization 헤더가 없다', async () => {
    const f = mockFetch(async () => json(200, {}));
    await api('GET', '/api/x');
    expect(headersOf(f.mock.calls[0]![1]).Authorization).toBeUndefined();
  });

  it('4xx 오류 JSON이면 ApiError(status, code)', async () => {
    mockFetch(async () => json(401, { error: { code: 'ENTRY_FAILED', message: 'x' } }));
    const err = await api('POST', '/api/student/entry', {}).catch((e: ApiError) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('ENTRY_FAILED');
  });

  it('깨진 JSON 오류 본문이면 상태 코드로 안전하게 처리', async () => {
    mockFetch(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = await api('GET', '/api/x').catch((e: ApiError) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('INTERNAL');
  });

  it('성공인데 본문이 비어 있어도 던지지 않는다', async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    await expect(api('POST', '/api/staff/logout')).resolves.toBeUndefined();
  });

  it('네트워크 실패면 status 0, code NETWORK', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await api('GET', '/api/x').catch((e: ApiError) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK');
  });
});
