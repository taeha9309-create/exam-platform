import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarize, formatMarkdown, loadResults, SIGNALS } from './summarize.js';

const trialFile = ({ browser = 'Google Chrome 158', scenario = 'tab-switch', trial = 1, startedAt = '2026-11-26T01:00:00.000Z', signals = [], extra = [] } = {}) => ({
  browser,
  userAgent: 'test',
  startedAt,
  scenario,
  trial,
  entries: [
    { t: 1, wall: 1, kind: 'start', detail: {} },
    ...extra,
    ...signals.map((name, i) => ({ t: 10 + i, wall: 10 + i, kind: 'signal', detail: { name } })),
  ],
});

test('같은 시나리오 3회차 중 2회차에 신호가 있으면 hits 2 / trials 3', () => {
  const rows = summarize([
    trialFile({ trial: 1, signals: ['SIDEBAR_SUSPECT'] }),
    trialFile({ trial: 2, signals: [] }),
    trialFile({ trial: 3, signals: ['SIDEBAR_SUSPECT', 'BLUR'] }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].browser, 'Google Chrome');
  assert.equal(rows[0].scenario, 'tab-switch');
  assert.equal(rows[0].trials, 3);
  assert.deepEqual(rows[0].hits, { SIDEBAR_SUSPECT: 2, BLUR: 1 });
});

test('한 회차에서 같은 신호가 여러 번 나와도 그 회차는 1 hit', () => {
  const rows = summarize([trialFile({ signals: ['BLUR', 'BLUR', 'BLUR'] })]);
  assert.deepEqual(rows[0].hits, { BLUR: 1 });
});

test('브라우저가 다르면 행이 분리되고, 같은 브라우저의 버전 차이는 합쳐진다', () => {
  const rows = summarize([
    trialFile({ browser: 'Google Chrome 157', trial: 1, signals: ['BLUR'] }),
    trialFile({ browser: 'Google Chrome 158', trial: 2, signals: ['BLUR'] }),
    trialFile({ browser: 'Microsoft Edge 140', trial: 1, signals: [] }),
  ]);
  assert.equal(rows.length, 2);
  const chrome = rows.find((r) => r.browser === 'Google Chrome');
  const edge = rows.find((r) => r.browser === 'Microsoft Edge');
  assert.equal(chrome.trials, 2);
  assert.deepEqual(chrome.hits, { BLUR: 2 });
  assert.deepEqual(chrome.versions, ['157', '158']);
  assert.equal(edge.trials, 1);
  assert.deepEqual(edge.hits, {});
});

test('같은 회차 번호가 두 번 있으면 더 늦게 시작한 기록만 센다', () => {
  const rows = summarize([
    trialFile({ trial: 3, startedAt: '2026-11-26T01:00:00.000Z', signals: ['BLUR'] }),
    trialFile({ trial: 3, startedAt: '2026-11-26T02:00:00.000Z', signals: [] }),
  ]);
  assert.equal(rows[0].trials, 1);
  assert.deepEqual(rows[0].hits, {});
  assert.equal(rows[0].duplicatesIgnored, 1);
});

test('startedAt이 없거나 이상한 기록은 정상 기록보다 "늦은 것"으로 뽑히지 않는다(입력 순서와 무관)', () => {
  const good = trialFile({ trial: 3, startedAt: '2026-11-26T01:00:00.000Z', signals: ['BLUR'] });
  for (const bad of [undefined, '', 'not-a-date']) {
    const broken = { ...trialFile({ trial: 3, signals: [] }), startedAt: bad };
    for (const order of [[good, broken], [broken, good]]) {
      const rows = summarize(order);
      assert.equal(rows[0].trials, 1);
      assert.deepEqual(rows[0].hits, { BLUR: 1 }, `startedAt=${String(bad)} 일 때 정상 기록이 선택돼야 함`);
    }
  }
});

test('signal이 아닌 원시 이벤트는 hit로 세지 않는다', () => {
  const rows = summarize([trialFile({ extra: [{ t: 2, wall: 2, kind: 'blur', detail: { name: 'BLUR' } }] })]);
  assert.deepEqual(rows[0].hits, {});
});

test('입력이 없으면 빈 배열', () => {
  assert.deepEqual(summarize([]), []);
});

test('행 정렬: 브라우저, 시나리오 순', () => {
  const rows = summarize([
    trialFile({ browser: 'Microsoft Edge 140', scenario: 'alt-tab' }),
    trialFile({ browser: 'Google Chrome 158', scenario: 'tab-switch' }),
    trialFile({ browser: 'Google Chrome 158', scenario: 'alt-tab' }),
  ]);
  assert.deepEqual(rows.map((r) => `${r.browser}/${r.scenario}`), ['Google Chrome/alt-tab', 'Google Chrome/tab-switch', 'Microsoft Edge/alt-tab']);
});

test('마크다운 표: 신호 9종 열과 "hits/trials" 칸, 알 수 없는 신호는 열이 추가된다', () => {
  const rows = summarize([
    trialFile({ trial: 1, signals: ['SIDEBAR_SUSPECT', 'MY_NEW_SIGNAL'] }),
    trialFile({ trial: 2, signals: ['SIDEBAR_SUSPECT'] }),
    trialFile({ trial: 3, signals: [] }),
  ]);
  const md = formatMarkdown(rows);
  const [header, divider, line] = md.split('\n');
  for (const name of SIGNALS) assert.ok(header.includes(name), `${name} 열 없음`);
  assert.ok(header.includes('MY_NEW_SIGNAL'));
  assert.match(divider, /^\|(---\|)+$/);
  const cells = line.split('|').map((c) => c.trim());
  assert.equal(cells[1], 'Google Chrome');
  assert.equal(cells[2], 'tab-switch');
  assert.equal(cells[3], '3');
  assert.ok(cells.includes('2/3'), 'SIDEBAR_SUSPECT 2/3');
  assert.ok(cells.includes('1/3'), 'MY_NEW_SIGNAL 1/3');
  assert.ok(cells.includes('0/3'), '발생하지 않은 신호는 0/3');
});

test('SIGNALS는 실험 페이지의 후보 신호 9종과 같다', () => {
  assert.deepEqual([...SIGNALS], [
    'VISIBILITY_HIDDEN', 'BLUR', 'FULLSCREEN_EXIT', 'SIDEBAR_SUSPECT', 'POINTER_LEAVE',
    'MULTI_MONITOR', 'DOM_INJECTED', 'INPUT_WITHOUT_FOCUS', 'LARGE_SELECTION',
  ]);
});

const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./summarize.js', import.meta.url)), ...args], { encoding: 'utf8' });

test('CLI: 인자가 없으면 사용법과 종료코드 2', () => {
  const r = cli();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /사용법/);
});

test('CLI: 존재하지 않는 폴더는 스택 트레이스가 아니라 안내 메시지와 종료코드 2', () => {
  const r = cli(join(tmpdir(), 'lab-no-such-folder-xyz'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /폴더를 찾을 수 없습니다/);
  assert.doesNotMatch(r.stderr, /at .*\(.*:\d+:\d+\)/, '스택 트레이스가 노출되면 안 됨');
});

test('CLI: 파일을 폴더 자리에 주어도 같은 안내와 종료코드 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-cli-'));
  try {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{}');
    const r = cli(file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /폴더를 찾을 수 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 결과 파일이 없는 빈 폴더는 안내만 하고 종료코드 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-cli-'));
  try {
    const r = cli(dir);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /집계할 결과 파일이 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// lab.js는 별도 PR(계획0-Task2)로 들어오므로, 파일이 있을 때만 검사한다. 둘 다 병합되면 자동으로 실행된다.
const labUrl = new URL('./lab.js', import.meta.url);
test('lab.js와 summarize.js의 신호 이름 목록이 어긋나지 않는다(한쪽만 바뀌면 집계가 조용히 틀어짐)', { skip: existsSync(labUrl) ? false : 'lab.js 없음(계획0-Task2 PR에서 추가됨)' }, () => {
  const src = readFileSync(labUrl, 'utf8');
  const block = src.match(/const SIGNALS = \[([\s\S]*?)\];/);
  assert.ok(block, 'lab.js에서 SIGNALS 배열을 찾지 못함');
  const labNames = [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(labNames, [...SIGNALS]);
});

test('loadResults: 폴더의 json만 읽고, 깨진 파일은 오류 목록에 담고 계속 진행', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-results-'));
  try {
    writeFileSync(join(dir, 'chrome-tab-switch-1.json'), JSON.stringify(trialFile({ signals: ['BLUR'] })));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'notes.txt'), '무시');
    writeFileSync(join(dir, '.gitkeep'), '');
    writeFileSync(join(dir, 'empty-shape.json'), JSON.stringify({ hello: 1 }));
    const { files, errors } = loadResults(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(errors.map((e) => e.file).sort(), ['broken.json', 'empty-shape.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
