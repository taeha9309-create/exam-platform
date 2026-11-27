// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { DetailedApiError, putQuestions, putRoster } from './staffApi';

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('문항·명단 저장 호출', () => {
  it('400 응답의 details를 DetailedApiError로 전달한다', async () => {
    stubFetch(400, { error: { code: 'INVALID_INPUT', message: 'x', details: [{ index: 0, field: 'choices', code: 'CHOICES_COUNT' }] } });
    const err = await putQuestions('id', []).catch((e) => e);
    expect(err).toBeInstanceOf(DetailedApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.details).toEqual([{ index: 0, field: 'choices', code: 'CHOICES_COUNT' }]);
  });

  it('성공 응답은 그대로 돌려주고 쿠키 인증(same-origin)과 JSON 본문으로 보낸다', async () => {
    stubFetch(200, { rosterCount: 2 });
    await expect(putRoster('id', 'a,b')).resolves.toEqual({ rosterCount: 2 });
    const [path, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(path).toBe('/api/exams/id/roster');
    expect(init).toMatchObject({ method: 'PUT', credentials: 'same-origin', body: JSON.stringify({ csv: 'a,b' }) });
  });

  it('네트워크 오류는 NETWORK 코드다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('x'))));
    await expect(putRoster('id', '')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
