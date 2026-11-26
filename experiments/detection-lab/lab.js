// 감지 실험 페이지: 후보 브라우저 이벤트를 시각과 함께 기록하고 JSON으로 내보낸다.
// 판정 로직은 detectors.js(단위 테스트 있음)에 있고, 이 파일은 이벤트를 모아 넘기기만 한다.
// 제품 코드와 공유하지 않는 버리는 코드이며, 화면 문구는 관찰 사실만 쓴다.
import { detectSidebarResize, pointerLeaveSignal, inputWithoutFocus } from './detectors.js';

// 후보 신호 이름 (Task 3 집계 스크립트가 같은 이름을 쓴다. 이 파일은 DOM에 의존하므로 Node에서 import하지 않는다)
const SIGNALS = [
  'VISIBILITY_HIDDEN', 'BLUR', 'FULLSCREEN_EXIT', 'SIDEBAR_SUSPECT', 'POINTER_LEAVE',
  'MULTI_MONITOR', 'DOM_INJECTED', 'INPUT_WITHOUT_FOCUS', 'LARGE_SELECTION',
];

// SPEC 8장 시나리오. id는 파일명에 쓰이므로 ASCII.
const TARGET_SCENARIOS = [
  ['tab-switch', '다른 탭으로 이동했다가 복귀'],
  ['alt-tab', 'Alt+Tab으로 다른 앱 전환 후 복귀'],
  ['split-screen', '화면 분할로 옆에 다른 창 띄우기'],
  ['second-monitor-window', '두 번째 모니터로 창 이동'],
  ['cursor-second-monitor', '커서를 두 번째 모니터로 이동'],
  ['cursor-over-sidebar', '커서를 AI 사이드바 위에 올리고 읽기만'],
  ['chrome-gemini-sidebar', 'Chrome Gemini 사이드바 열기·사용'],
  ['claude-extension-sidebar', 'Claude 확장 사이드바 열기·사용'],
  ['edge-copilot-sidebar', 'Edge Copilot 사이드바 열기·사용'],
  ['fullscreen-sidebar', '전체화면 중 사이드바 열기 시도'],
  ['ai-extension-read', 'AI 확장이 페이지 내용을 읽음'],
  ['agent-input', '에이전트형 조작으로 답안 입력'],
];
const DAILY_SCENARIOS = [
  ['fp-permission-popup', '권한 창(브라우저 팝업) 표시'],
  ['fp-os-notification', 'OS 알림 표시·클릭'],
  ['fp-update-window', '업데이트·보안 창 표시'],
  ['fp-lid-sleep', '노트북 덮개 닫기·절전 후 복귀'],
  ['fp-ime-toggle', '한/영 전환'],
  ['fp-hangul-typing', '한글 입력(조합 중 포함)'],
  ['fp-touchpad-edge', '터치패드로 입력 중 커서가 가장자리로 밀림'],
  ['fp-fullscreen-top-edge', '전체화면에서 커서를 화면 상단에 댐'],
];

const KEYS = new Set(['Alt', 'Meta', 'Control', 'Tab', 'F11', 'Escape']);
const $ = (id) => document.getElementById(id);
const readSize = () => ({ innerWidth, outerWidth, innerHeight, outerHeight });

const state = {
  recording: false,
  startedAt: null,
  entries: [],
  counts: {},
  prevSize: readSize(),
  pointerOutAt: null,
  wasFullscreen: !!document.fullscreenElement,
  lastFocus: document.hasFocus(),
  selectionBig: false,
};
window.__lab = { state }; // 디버깅·자동 확인용

function browserInfo() {
  const brands = navigator.userAgentData?.brands ?? [];
  const pick = brands.find((b) => b.brand === 'Microsoft Edge') ?? brands.find((b) => b.brand === 'Google Chrome') ?? brands.find((b) => b.brand === 'Chromium');
  if (!pick) return { label: navigator.userAgent, key: 'other' };
  return { label: `${pick.brand} ${pick.version}`, key: pick.brand.includes('Edge') ? 'edge' : pick.brand.includes('Chrome') ? 'chrome' : 'chromium' };
}

function round1(n) { return Math.round(n * 10) / 10; }

function renderCounts() {
  const box = $('counts');
  box.replaceChildren();
  for (const name of SIGNALS) {
    const n = state.counts[name] ?? 0;
    const label = document.createElement('span');
    label.textContent = name;
    const value = document.createElement('span');
    value.textContent = String(n);
    if (n > 0) value.className = 'hit';
    box.append(label, value);
  }
}

function renderLogLine(e) {
  const log = $('log');
  const line = document.createElement('div');
  line.textContent = `${round1(e.t).toFixed(1).padStart(10)}  ${e.kind}  ${JSON.stringify(e.detail)}`;
  log.prepend(line);
  while (log.childElementCount > 200) log.lastElementChild.remove();
}

function add(kind, detail = {}) {
  if (!state.recording) return;
  const e = { t: round1(performance.now()), wall: Date.now(), kind, detail };
  state.entries.push(e);
  renderLogLine(e);
}

function signal(name, extra = {}) {
  if (!state.recording) return;
  state.counts[name] = (state.counts[name] ?? 0) + 1;
  add('signal', { name, ...extra });
  renderCounts();
}

function setStatus(text) { $('status').textContent = text; }

// ── 탭·창 이탈 ────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  add('visibilitychange', { state: document.visibilityState });
  if (hidden) { add('leave', { cause: 'hidden' }); signal('VISIBILITY_HIDDEN'); }
  else add('return', { cause: 'hidden' });
});
window.addEventListener('blur', () => { add('blur', {}); add('leave', { cause: 'blur' }); signal('BLUR'); });
window.addEventListener('focus', () => { add('focus', {}); add('return', { cause: 'blur' }); });

// 이벤트 누락에 대비한 1초 폴링: 상태가 바뀔 때만 기록하고 예상 시각과의 차이(백그라운드 탭 지연)를 함께 남긴다
let expectedPoll = performance.now() + 1000;
setInterval(() => {
  const now = performance.now();
  const drift = now - expectedPoll;
  expectedPoll = now + 1000;
  const focused = document.hasFocus();
  if (focused !== state.lastFocus) {
    state.lastFocus = focused;
    add('hasFocusPoll', { hasFocus: focused, driftMs: Math.round(drift) });
  }
}, 1000);

document.addEventListener('fullscreenchange', () => {
  const fullscreen = !!document.fullscreenElement;
  add('fullscreenchange', { fullscreen });
  if (state.wasFullscreen && !fullscreen) signal('FULLSCREEN_EXIT');
  state.wasFullscreen = fullscreen;
});

// ── 창 크기(사이드바 후보) ────────────────────────────────────
window.addEventListener('resize', () => {
  const next = readSize();
  const sidebar = detectSidebarResize(state.prevSize, next);
  add('resize', { prev: state.prevSize, next, sidebar });
  if (sidebar) signal('SIDEBAR_SUSPECT', { deltaInner: sidebar.deltaInner });
  state.prevSize = next;
});

// ── 커서 이탈 + 화면 가림 (SPEC 5.6) ──────────────────────────
document.documentElement.addEventListener('mouseleave', (e) => {
  state.pointerOutAt = performance.now();
  add('mouseleave', { x: e.clientX, y: e.clientY });
  if ($('cover-on').checked) $('cover').hidden = false;
});
document.documentElement.addEventListener('mouseenter', () => {
  const duration = state.pointerOutAt == null ? null : performance.now() - state.pointerOutAt;
  state.pointerOutAt = null;
  $('cover').hidden = true;
  add('mouseenter', { durationMs: duration == null ? null : Math.round(duration) });
  const s = duration == null ? null : pointerLeaveSignal(duration);
  if (s) signal('POINTER_LEAVE', { severity: s.severity, durationMs: Math.round(duration) });
});
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget === null) add('mouseout-null', { x: e.clientX, y: e.clientY });
});

document.addEventListener('keydown', (e) => {
  if (KEYS.has(e.key)) add('keydown', { key: e.key, repeat: e.repeat });
});

// ── 모니터 ───────────────────────────────────────────────────
function checkScreen(source) {
  const isExtended = typeof screen.isExtended === 'boolean' ? screen.isExtended : null;
  add('screen', { isExtended, source });
  if (isExtended === true) signal('MULTI_MONITOR', { source });
}
screen.addEventListener?.('change', () => checkScreen('screen-change'));

// ── AI 확장·에이전트 흔적 후보 ────────────────────────────────
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.closest('[data-lab]')) continue; // 이 페이지가 만든 요소(로그 등)는 제외
      signal('DOM_INJECTED', { tag: node.tagName, id: node.id || null, class: node.getAttribute('class') });
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('selectionchange', () => {
  const length = String(getSelection() ?? '').length;
  const big = length >= 20;
  if (big && !state.selectionBig) signal('LARGE_SELECTION', { length });
  state.selectionBig = big;
});
document.addEventListener('copy', () => add('copy', { length: String(getSelection() ?? '').length }));
document.addEventListener('paste', (e) => add('paste', { length: e.clipboardData?.getData('text')?.length ?? null }));
document.addEventListener('drop', (e) => add('drop', { length: e.dataTransfer?.getData('text')?.length ?? null }));

document.addEventListener('input', (e) => {
  const hasFocus = document.hasFocus();
  add('input', { inputType: e.inputType, hasFocus, isComposing: e.isComposing });
  if (inputWithoutFocus({ hasFocus, inputType: e.inputType })) signal('INPUT_WITHOUT_FOCUS', { inputType: e.inputType });
}, true);
document.addEventListener('compositionstart', () => add('compositionstart', {}), true);
document.addEventListener('compositionend', () => add('compositionend', {}), true);

// ── 컨트롤 ───────────────────────────────────────────────────
function fillScenarios() {
  const select = $('scenario');
  const groups = [['대상 행동', TARGET_SCENARIOS], ['일상 행동 (오탐 측정)', DAILY_SCENARIOS]];
  for (const [label, items] of groups) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const [id, text] of items) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = text;
      og.append(opt);
    }
    select.append(og);
  }
}

function startRecording() {
  state.entries = [];
  state.counts = {};
  state.startedAt = new Date().toISOString();
  state.prevSize = readSize();
  state.wasFullscreen = !!document.fullscreenElement;
  state.lastFocus = document.hasFocus();
  state.selectionBig = false;
  $('log').replaceChildren();
  state.recording = true;
  $('rec').textContent = '기록 정지';
  $('rec').classList.add('on');
  renderCounts();
  add('start', { browser: browserInfo().label, scenario: $('scenario').value, trial: Number($('trial').value) });
  checkScreen('start');
  setStatus('기록 중…');
}

function stopRecording() {
  add('stop', {});
  state.recording = false;
  $('rec').textContent = '기록 시작';
  $('rec').classList.remove('on');
  setStatus(`기록 정지 (이벤트 ${state.entries.length}건)`);
}

function exportJson() {
  const b = browserInfo();
  const scenario = $('scenario').value;
  const trial = Number($('trial').value);
  const entries = [...state.entries].sort((x, y) => x.wall - y.wall || x.t - y.t);
  const payload = { browser: b.label, userAgent: navigator.userAgent, startedAt: state.startedAt, scenario, trial, entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${b.key}-${scenario}-${trial}.json`;
  a.setAttribute('data-lab', '');
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  setStatus(`내보냄: ${a.download}`);
}

$('rec').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
$('export').addEventListener('click', exportJson);
$('clear').addEventListener('click', () => {
  state.entries = [];
  state.counts = {};
  $('log').replaceChildren();
  renderCounts();
});
// 전체화면은 사용자 클릭으로만 진입할 수 있다(브라우저 정책)
$('fs').addEventListener('click', () => {
  document.documentElement.requestFullscreen().catch((err) => setStatus(`전체화면 실패: ${err.message}`));
});

fillScenarios();
renderCounts();
setStatus(`${browserInfo().label} · 준비됨`);
