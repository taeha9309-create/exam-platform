// 실험 페이지 전용 로컬 서버(버리는 코드). 정적 파일 + 내보내기 JSON 자동 저장(POST /__save → results/).
// 사용: node experiments/detection-lab/serve.js [포트=3100]
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(root, 'results');
const port = Number(process.argv[2] ?? 3100);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
// 파일명은 {browser}-{scenario}-{trial}.json 형태만 허용한다(경로 탈출 방지)
const SAFE_NAME = /^[a-z0-9]+-[a-z0-9-]+-\d{1,3}\.json$/;

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url?.startsWith('/__save')) {
      const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
      if (!SAFE_NAME.test(name)) { res.writeHead(400).end('bad name'); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      JSON.parse(body); // 형식 확인
      await mkdir(resultsDir, { recursive: true });
      await writeFile(join(resultsDir, name), body, 'utf8');
      res.writeHead(204).end();
      console.log(`저장: results/${name}`);
      return;
    }
    const urlPath = new URL(req.url ?? '/', 'http://x').pathname;
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^([/\\])+/, '');
    const file = resolve(root, rel);
    if (!file.startsWith(root) || rel.startsWith('results')) { res.writeHead(404).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`감지 실험 페이지: http://localhost:${port}`));
