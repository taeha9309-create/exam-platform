import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const app = createApp();
// 본문 없이도 상태를 바꾸는 POST를 대표한다. 통과하면 인증 단계에서 401, 차단되면 403이다.
const POST_PATH = '/api/staff/logout';

function post(host = 'exam.example') {
  return request(app).post(POST_PATH).set('Host', host);
}

afterEach(() => {
  delete process.env.ALLOWED_ORIGINS;
});

describe('Origin 검사', () => {
  it('같은 출처의 Origin은 통과한다', async () => {
    const res = await post().set('Origin', 'http://exam.example');
    expect(res.status).toBe(401);
  });

  it('다른 출처의 Origin은 403 FORBIDDEN_ORIGIN', async () => {
    const res = await post().set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('로그인 요청도 같은 검사를 받는다', async () => {
    const res = await request(app).post('/api/staff/login').set('Host', 'exam.example').set('Origin', 'http://evil.example').send({ email: 'a@b.c', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('Origin이 없으면 Referer로 비교한다(같음 허용, 다름 403)', async () => {
    expect((await post().set('Referer', 'http://exam.example/staff/exams?x=1')).status).toBe(401);
    expect((await post().set('Referer', 'http://evil.example/page')).status).toBe(403);
  });

  it('Origin과 Referer가 모두 없으면 허용한다(브라우저가 아닌 클라이언트)', async () => {
    expect((await post()).status).toBe(401);
  });

  it('Origin이 있으면 Referer는 보지 않는다', async () => {
    const res = await post().set('Origin', 'http://exam.example').set('Referer', 'http://evil.example/');
    expect(res.status).toBe(401);
  });

  it('GET은 검사하지 않는다', async () => {
    const res = await request(app).get('/api/health').set('Host', 'exam.example').set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
  });

  it('접두사·접미사가 비슷한 도메인으로 우회되지 않는다', async () => {
    for (const origin of ['http://exam.example.evil.com', 'http://evil-exam.example', 'http://exam.examplee', 'http://xexam.example', 'http://exam.example@evil.com']) {
      const res = await post().set('Origin', origin);
      expect(res.status, origin).toBe(403);
    }
  });

  it('포트가 다르면 거부하고 같으면 허용한다', async () => {
    expect((await post('exam.example:3000').set('Origin', 'http://exam.example:3001')).status).toBe(403);
    expect((await post('exam.example:3000').set('Origin', 'http://exam.example')).status).toBe(403);
    expect((await post('exam.example:3000').set('Origin', 'http://exam.example:3000')).status).toBe(401);
  });

  it('스킴이 다르면 거부한다', async () => {
    expect((await post().set('Origin', 'https://exam.example')).status).toBe(403);
  });

  it('"null" Origin과 형식이 잘못된 Referer는 거부한다', async () => {
    expect((await post().set('Origin', 'null')).status).toBe(403);
    expect((await post().set('Referer', 'not a url')).status).toBe(403);
  });

  it('trust proxy가 켜져 있으면 X-Forwarded-Proto를 존중한다(https)', async () => {
    const proxied = createApp({ trustProxy: 1 });
    const ok = await request(proxied).post(POST_PATH).set('Host', 'exam.example').set('X-Forwarded-Proto', 'https').set('Origin', 'https://exam.example');
    expect(ok.status).toBe(401);
    const bad = await request(proxied).post(POST_PATH).set('Host', 'exam.example').set('X-Forwarded-Proto', 'https').set('Origin', 'http://exam.example');
    expect(bad.status).toBe(403);
  });

  it('trust proxy가 꺼져 있으면 X-Forwarded-Proto를 믿지 않는다', async () => {
    const res = await post().set('X-Forwarded-Proto', 'https').set('Origin', 'https://exam.example');
    expect(res.status).toBe(403);
  });

  it('ALLOWED_ORIGINS(쉼표 구분)에 있는 출처는 허용한다', async () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173, https://other.example';
    expect((await post('localhost:3000').set('Origin', 'http://localhost:5173')).status).toBe(401);
    expect((await post('localhost:3000').set('Referer', 'https://other.example/a')).status).toBe(401);
    expect((await post('localhost:3000').set('Origin', 'http://localhost:5174')).status).toBe(403);
    expect((await post('localhost:3000').set('Origin', 'https://other.example.evil.com')).status).toBe(403);
  });
});
