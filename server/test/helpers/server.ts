import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { createApp } from '../../src/app';
import { attachSocket, type AttachSocketOptions } from '../../src/realtime/socket';

/**
 * 실제 http 서버(앱 + Socket.IO)를 빈 포트에 띄운다. 소켓·통합 테스트용.
 * close()는 소켓과 http 서버를 모두 닫아 열린 핸들이 남지 않게 한다.
 */
export async function startTestServer(options?: AttachSocketOptions): Promise<{ url: string; io: Server; close(): Promise<void> }> {
  const httpServer = createServer(createApp());
  const io = attachSocket(httpServer, options);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    io,
    url: `http://127.0.0.1:${port}`,
    // io.close()가 연결된 소켓을 끊고 아래의 http 서버도 닫는다.
    close: () => new Promise<void>((resolve) => void io.close(() => resolve())),
  };
}
