import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 화면(5173)에서 /api·/socket.io 요청을 서버(3000)로 넘긴다.
// 운영에서는 서버가 빌드된 화면을 같은 주소로 제공하므로 이 설정이 필요 없다(ADR, D-017).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin을 끄면 Host가 5173으로 유지되어 브라우저의 Origin(http://localhost:5173)과 같은 출처로 판정된다.
      // 축약형('/api': url)은 changeOrigin: true라 Host가 3000으로 바뀌어 서버의 Origin 검사가 모든 POST를 403으로 거부한다.
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
