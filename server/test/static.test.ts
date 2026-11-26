import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'client-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>시험 무결성 플랫폼</title><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("app")');
  writeFileSync(join(dir, 'secret.txt'), 'x');
  writeFileSync(join(dir, '.hidden'), 'dotfile');
  app = createApp({ clientDist: dir });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('빌드된 화면 제공(운영: 화면과 API를 같은 주소로)', () => {
  it('/ 는 index.html, 캐시하지 않는다(새 배포가 바로 반영되도록)', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('시험 무결성 플랫폼');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('화면 라우트(/staff/login, /e/ABC12345)는 index.html로 돌려준다(새로고침해도 동작)', async () => {
    for (const path of ['/staff/login', '/staff/exams/abc/run', '/e/ABCD2345']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('id="root"');
      expect(res.headers['cache-control'], path).toBe('no-cache');
    }
  });

  it('해시가 붙은 정적 파일은 오래 캐시한다', async () => {
    const res = await request(app).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.text).toBe('console.log("app")');
  });

  it('없는 정적 파일은 index.html이 아니라 404(JS 요청에 HTML이 가면 원인 파악이 어려움)', async () => {
    const res = await request(app).get('/assets/missing-xyz.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('id="root"');
  });

  it('API는 화면으로 새지 않는다: 없는 /api 경로는 JSON 404, /api/health는 그대로', async () => {
    const nope = await request(app).get('/api/없는경로');
    expect(nope.status).toBe(404);
    expect(nope.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    const health = await request(app).get('/api/health');
    expect(health.body).toEqual({ ok: true });
  });

  it('GET이 아닌 요청은 화면으로 돌려주지 않고 JSON 404', async () => {
    const res = await request(app).post('/staff/login').send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('숨김 폴더·파일이 들어간 경로(/.git/config 등)는 화면이 아니라 404(스캐너가 "있는 파일"로 오인하지 않게)', async () => {
    // 점을 %2e로 인코딩해도 같은 취급(디코딩한 경로로 검사)
    for (const path of ['/.git/config', '/.well-known/x', '/a/.b/c', '/.hidden/', '/%2ehid', '/%2egit/config', '/a/%2E%2e/x', '/%2Ehidden/']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('id="root"');
    }
  });

  it('숨김 파일(.hidden)과 경로 탈출 시도는 파일 내용을 돌려주지 않는다', async () => {
    const hidden = await request(app).get('/.hidden');
    expect(hidden.status).toBe(404);
    expect(hidden.text).not.toContain('dotfile');
    for (const path of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2f..%2fpackage.json']) {
      const res = await request(app).get(path);
      expect(res.text, path).not.toContain('"workspaces"');
      expect(res.text, path).not.toContain('"name"');
    }
  });

  it('보안 헤더가 화면과 API 모두에 붙는다(클릭재킹·MIME 추측 방지)', async () => {
    for (const path of ['/', '/api/health', '/assets/app-abc123.js']) {
      const res = await request(app).get(path);
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['x-frame-options'], path).toBe('DENY');
      expect(res.headers['referrer-policy'], path).toBe('no-referrer');
    }
  });
});

describe('화면 폴더가 없으면(개발·테스트) API만 제공한다', () => {
  it('clientDist를 주지 않으면 / 는 404', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('존재하지 않는 폴더를 주면 오류 없이 API만 제공한다', async () => {
    const res = await request(createApp({ clientDist: join(dir, '없는-폴더') })).get('/api/health');
    expect(res.body).toEqual({ ok: true });
    expect((await request(createApp({ clientDist: join(dir, '없는-폴더') })).get('/')).status).toBe(404);
  });
});

describe('프록시 뒤에서 동작(Railway)', () => {
  it('trustProxy 옵션은 Express의 trust proxy 설정으로 반영된다(실제 req.ip 동작은 Express 몫 — 가장 오른쪽 XFF 값을 쓰는 것을 Reviewer가 직접 확인)', () => {
    expect(createApp({ trustProxy: 1 }).get('trust proxy')).toBe(1);
  });

  it('기본값은 프록시를 신뢰하지 않는다(헤더로 IP를 위조할 수 없음)', () => {
    expect(createApp().get('trust proxy')).toBeFalsy();
  });
});
