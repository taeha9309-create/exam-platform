// 실험 결과 JSON(lab.js가 내보낸 파일)을 (브라우저 × 시나리오)별로 집계해 마크다운 표로 출력한다.
// 사용: node experiments/detection-lab/summarize.js experiments/detection-lab/results/
// 한 회차에서 같은 신호가 여러 번 나와도 그 회차는 1 hit로 센다(채택 기준이 "10회 중 몇 회"이므로).
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// 실험 페이지(lab.js)의 후보 신호 이름과 같아야 한다
export const SIGNALS = [
  'VISIBILITY_HIDDEN', 'BLUR', 'FULLSCREEN_EXIT', 'SIDEBAR_SUSPECT', 'POINTER_LEAVE',
  'MULTI_MONITOR', 'DOM_INJECTED', 'INPUT_WITHOUT_FOCUS', 'LARGE_SELECTION',
];

/** "Google Chrome 158" → { name: "Google Chrome", version: "158" } */
function splitBrowser(label) {
  const m = String(label).match(/^(.*?)\s+(\d[\d.]*)$/);
  return m ? { name: m[1], version: m[2] } : { name: String(label), version: null };
}

/** 회차 하나에서 발생한 신호 이름 집합(중복 제거) */
function signalsOf(file) {
  const names = new Set();
  for (const e of file.entries ?? []) {
    if (e.kind === 'signal' && typeof e.detail?.name === 'string') names.add(e.detail.name);
  }
  return names;
}

/**
 * @param {{browser:string, scenario:string, trial:number, startedAt:string, entries:object[]}[]} files
 * @returns {{browser:string, versions:string[], scenario:string, trials:number, duplicatesIgnored:number, hits:Record<string,number>}[]}
 */
export function summarize(files) {
  // (브라우저, 시나리오) → 회차 번호 → 가장 늦게 시작한 기록
  const groups = new Map();
  for (const f of files) {
    const { name, version } = splitBrowser(f.browser);
    const key = `${name}\u0000${f.scenario}`;
    if (!groups.has(key)) groups.set(key, { browser: name, scenario: f.scenario, versions: new Set(), trials: new Map(), duplicatesIgnored: 0 });
    const g = groups.get(key);
    if (version) g.versions.add(version);
    const prev = g.trials.get(f.trial);
    if (!prev) g.trials.set(f.trial, f);
    else {
      g.duplicatesIgnored += 1;
      if (String(f.startedAt) > String(prev.startedAt)) g.trials.set(f.trial, f);
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const hits = {};
    for (const file of g.trials.values()) {
      for (const name of signalsOf(file)) hits[name] = (hits[name] ?? 0) + 1;
    }
    rows.push({
      browser: g.browser,
      versions: [...g.versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      scenario: g.scenario,
      trials: g.trials.size,
      duplicatesIgnored: g.duplicatesIgnored,
      hits,
    });
  }
  return rows.sort((a, b) => a.browser.localeCompare(b.browser) || a.scenario.localeCompare(b.scenario));
}

/** 행=(브라우저, 시나리오), 열=신호. 칸은 "hits/trials". 알 수 없는 신호 이름은 열을 추가한다. */
export function formatMarkdown(rows) {
  const extra = new Set();
  for (const r of rows) for (const name of Object.keys(r.hits)) if (!SIGNALS.includes(name)) extra.add(name);
  const columns = [...SIGNALS, ...[...extra].sort()];
  const head = `| 브라우저 | 시나리오 | 회차 | ${columns.join(' | ')} |`;
  const divider = `|${'---|'.repeat(columns.length + 3)}`;
  const lines = rows.map((r) => `| ${r.browser} | ${r.scenario} | ${r.trials} | ${columns.map((c) => `${r.hits[c] ?? 0}/${r.trials}`).join(' | ')} |`);
  return [head, divider, ...lines].join('\n');
}

/** 폴더의 .json 파일을 읽는다. 깨졌거나 형식이 다른 파일은 errors에 담고 계속 진행한다. */
export function loadResults(dir) {
  const files = [];
  const errors = [];
  for (const name of readdirSync(dir).sort()) {
    if (extname(name) !== '.json') continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (typeof data?.browser !== 'string' || typeof data?.scenario !== 'string' || typeof data?.trial !== 'number' || !Array.isArray(data?.entries)) {
        throw new Error('실험 페이지가 내보낸 형식이 아님(browser, scenario, trial, entries 필요)');
      }
      files.push(data);
    } catch (err) {
      errors.push({ file: name, message: err.message });
    }
  }
  return { files, errors };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('사용법: node experiments/detection-lab/summarize.js <결과 폴더>');
    process.exit(2);
  }
  const { files, errors } = loadResults(dir);
  for (const e of errors) console.error(`건너뜀: ${e.file} — ${e.message}`);
  const rows = summarize(files);
  if (rows.length === 0) {
    console.error('집계할 결과 파일이 없습니다.');
    process.exit(errors.length ? 1 : 0);
  }
  console.log(formatMarkdown(rows));
  const dup = rows.reduce((n, r) => n + r.duplicatesIgnored, 0);
  const versions = rows.map((r) => `${r.browser} ${r.versions.join('/') || '버전 미상'}`);
  console.log(`\n브라우저 버전: ${[...new Set(versions)].join(', ')}`);
  if (dup) console.log(`중복 회차 ${dup}건은 더 늦게 시작한 기록만 집계했습니다.`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
