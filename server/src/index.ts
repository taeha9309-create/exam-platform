import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { parsePort } from './config';
import { attachSocket } from './realtime/socket';

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

// 설정이 잘못되면(예: JWT_SECRET 없음·운영에서 32자 미만) 앱 생성 단계에서 실패한다.
// 배포 로그에 스택 트레이스 대신 원인을 읽을 수 있는 한 줄로 남긴다.
let app: ReturnType<typeof createApp>;
try {
  app = createApp({ clientDist, trustProxy });
} catch (err) {
  console.error(`서버를 시작할 수 없습니다: ${(err as Error).message}`);
  process.exit(1);
}
// Socket.IO는 같은 http 서버에 붙이므로 여기서 http.Server를 직접 만든다.
const httpServer = createServer(app);
const io = attachSocket(httpServer);

httpServer.listen(port, () => {
  console.log(`서버 시작: http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // io.close()는 소켓 연결을 모두 끊고 http 서버도 닫는다(소켓이 열려 있으면 httpServer.close만으로는 끝나지 않는다).
    void io.close(() => process.exit(0));
  });
}
