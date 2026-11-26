import { createServer } from 'node:http';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
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
