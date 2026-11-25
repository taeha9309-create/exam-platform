import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 화면(5173)에서 /api·/socket.io 요청을 서버(3000)로 넘긴다.
// 운영에서는 서버가 빌드된 화면을 같은 주소로 제공하므로 이 설정이 필요 없다(ADR, D-017).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
