import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ASSET_CACHE = 'public, max-age=31536000, immutable'; // Vite가 파일 이름에 해시를 붙이므로 내용이 바뀌면 이름도 바뀐다
const NO_CACHE = 'no-cache'; // index.html은 항상 새로 확인한다(새 배포가 바로 반영되도록)

/**
 * 빌드된 화면(client/dist)을 같은 주소로 제공한다(운영: 화면·API·실시간을 한 서버가 같은 도메인으로 제공, D-017).
 * - 정적 파일은 그대로, 화면 라우트(/staff/login, /e/…)는 새로고침해도 동작하도록 index.html로 돌려준다.
 * - 확장자가 있는 경로(없는 .js 등)는 index.html이 아니라 404로 둔다(JS 요청에 HTML이 가면 원인 파악이 어렵다).
 * - 숨김 파일(.env 등)은 제공하지 않는다. GET/HEAD 외의 요청은 다루지 않는다.
 * clientDist에 index.html이 없으면(개발·테스트) 아무것도 등록하지 않고 API만 제공한다.
 */
export function registerClient(app: Express, clientDist: string): void {
  const index = join(clientDist, 'index.html');
  if (!existsSync(index)) return;

  app.use(
    express.static(clientDist, {
      index: false,
      dotfiles: 'ignore',
      cacheControl: false,
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? ASSET_CACHE : NO_CACHE);
      },
    }),
  );

  app.get('*', (req, res, next) => {
    const segments = req.path.split('/');
    const lastSegment = segments[segments.length - 1] ?? '';
    // 확장자가 있는 경로(없는 .js 등)나 숨김 세그먼트(/.git/…, /.well-known/…)는 화면이 아니라 404로 둔다
    if (lastSegment.includes('.') || segments.some((s) => s.startsWith('.'))) return next();
    res.setHeader('Cache-Control', NO_CACHE);
    res.sendFile(index);
  });
}
