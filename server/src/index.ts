import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { parsePort } from './config';

let port: number;
try {
  port = parsePort(process.env.PORT);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// 빌드된 화면 위치: server/src(개발)와 server/dist(번들) 모두 두 단계 위의 client/dist. 없으면 API만 제공한다.
const clientDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
// 운영(Railway)은 프록시 한 겹 뒤에 있다. 그때만 X-Forwarded-For를 믿는다.
const trustProxy = process.env.NODE_ENV === 'production' ? 1 : undefined;

const app = createApp({ clientDist, trustProxy });
// Socket.IO는 같은 http 서버에 붙이므로(Task 6) 여기서 http.Server를 직접 만든다.
const httpServer = createServer(app);

httpServer.listen(port, () => {
  console.log(`서버 시작: http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
  });
}
