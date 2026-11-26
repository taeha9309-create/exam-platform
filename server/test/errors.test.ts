import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { onError } from '../src/app';
import { AppError } from '../src/errors';

function appThrowing(make: () => unknown) {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/x', () => {
    throw make();
  });
  app.use(onError);
  return app;
}

describe('AppError와 onError', () => {
  it('AppError는 자신의 status·code를 그대로 응답한다', async () => {
    const res = await request(appThrowing(() => new AppError(409, 'X', '충돌했습니다.'))).post('/x');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'X', message: '충돌했습니다.' } });
  });

  it('AppError는 Error의 하위 클래스이고 status·code를 가진다', () => {
    const e = new AppError(404, 'NOPE');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(404);
    expect(e.code).toBe('NOPE');
  });

  it('이미 응답을 보냈다면 응답을 다시 쓰지 않고 next(err)로 넘긴다', () => {
    const err = new AppError(409, 'X');
    const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
    const next = vi.fn();
    onError(err, {} as never, res as never, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('회귀: 413 / INVALID_JSON / BAD_REQUEST / INTERNAL 동작을 유지한다', async () => {
    const big = await request(appThrowing(() => new Error('unused')))
      .post('/x')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 'a'.repeat(2000) }));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const bad = await request(appThrowing(() => new Error('unused')))
      .post('/x')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');

    const generic4xx = await request(appThrowing(() => Object.assign(new Error('x'), { status: 418 }))).post('/x');
    expect(generic4xx.status).toBe(418);
    expect(generic4xx.body.error.code).toBe('BAD_REQUEST');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = await request(appThrowing(() => new Error('비밀 내부 정보'))).post('/x');
    spy.mockRestore();
    expect(internal.status).toBe(500);
    expect(internal.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(internal.body)).not.toContain('비밀 내부 정보');
  });
});
