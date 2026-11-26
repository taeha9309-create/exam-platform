import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

describe('GET /api/health', () => {
  it('200과 { ok: true }를 돌려준다', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('존재하지 않는 /api 경로는 JSON 형식의 404 오류를 돌려준다', async () => {
    const res = await request(createApp()).get('/api/없는-경로');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('1MB를 넘는 JSON 본문은 413으로 거부한다', async () => {
    const big = JSON.stringify({ text: 'a'.repeat(1_100_000) });
    const res = await request(createApp()).post('/api/health').set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
  });

  it('X-Powered-By 헤더를 노출하지 않는다', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
