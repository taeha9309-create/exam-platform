import { useEffect, useState } from 'react';
import { t } from './copy/ko';

type Health = 'checking' | 'ok' | 'down';

// 뼈대 확인용 화면: 개발 서버 프록시(/api → 서버)가 동작하는지 보여 준다. 이후 Task 13~15에서 라우팅·실제 화면으로 대체된다.
export function App() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { ok?: boolean }) => setHealth(body.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{t.appName}</h1>
      <p>{t.server[health]}</p>
    </main>
  );
}
