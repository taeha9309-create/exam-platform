# 계획 0: 감지 실험실(Detection Lab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SPEC 5.2(검증 필요)·5.6(커서 이탈 화면 가림) 항목을 Chrome·Edge에서 실험할 수 있는 독립 실험 페이지와 기록 양식을 만든다. 실험 수행은 사용자가 직접 한다.

**Architecture:** 빌드 도구 없는 단일 정적 페이지(`experiments/detection-lab/index.html` + `lab.js`). 모든 후보 브라우저 이벤트를 시각과 함께 화면 로그로 남기고 JSON으로 내보낸다. 판정 로직(이벤트 → 후보 신호)은 `detectors.js`에 순수 함수로 두어 Node 테스트로 검증한다. 제품 코드와 공유하지 않는다(버리는 코드).

**Tech Stack:** HTML, 바닐라 JS(ES 모듈), Node 24 내장 테스트 러너(`node --test`), 로컬 서빙은 `npx serve`.

**Spec:** `docs/SPEC.md` v1.3 — 5.1, 5.6, 8장 / `docs/PRD.md` v1.3 — 5.2

## Global Constraints
- 실험 브라우저: Chrome, Edge 최신 안정 버전(버전 번호 기록).
- 채택 기준: 대상 행동에서 신호가 10회 중 9회 이상, 일상 행동에서 같은 신호가 10회 중 1회 이하.
- 실험 페이지는 제품(`client/`, `server/`)에서 import하지 않는다.
- 결과는 `docs/STUDY.md`에 "행동 × 브라우저 × 발생 신호 × 횟수" 표로 기록.
- 화면 문구에 "부정행위", "AI 사용", "적발" 같은 판정 표현을 쓰지 않는다.

## Review Focus
- 페이지를 열자마자(사용자 클릭 전) 전체화면 요청이 실패하는 경우 → 버튼 클릭으로만 진입해야 함.
- 이탈 중 생긴 이벤트가 로그 순서와 다르게 쌓이는 경우 → 모든 항목에 `performance.now()`와 `Date.now()`를 함께 기록하고 내보낼 때 시각순 정렬.
- `mouseleave`가 `<select>` 등 브라우저 기본 팝업에서 발생 → 실험 페이지에 `<select>`를 하나 두어 오탐을 측정할 수 있게 함.
- 한글 입력(IME 조합) 중 `blur`/`input` 이벤트 순서가 달라지는 경우 → `compositionstart/end`도 기록.
- 탭이 백그라운드일 때 타이머 지연으로 `hasFocus` 폴링이 늦게 찍히는 경우 → 폴링 결과는 "상태 변화가 있을 때만" 기록하고 지연 시간(예상 시각과의 차이)을 함께 기록.

---

### Task 1: 판정 함수(detectors) — 원시 이벤트에서 후보 신호 만들기

**Files:**
- Create: `experiments/detection-lab/detectors.js`
- Test: `experiments/detection-lab/detectors.test.js`

**Interfaces:**
- Produces:
  - `detectSidebarResize(prev: {innerWidth, outerWidth, innerHeight, outerHeight}, next: same): null | {type: 'SIDEBAR_SUSPECT', deltaInner: number}` — `outerWidth`가 같은데 `innerWidth`가 **80px 이상** 줄어들면 신호.
  - `pairLeaves(events: {t: number, kind: 'leave'|'return', cause: string}[]): {cause, start, end, durationMs}[]` — 이탈·복귀 쌍 만들기(복귀 없는 이탈은 `end: null`).
  - `pointerLeaveSignal(durationMs: number): null | {type: 'POINTER_LEAVE', severity: 'INFO'|'WARN'|'ALERT'}` — <1000ms는 null, <3000 INFO, 3000~15000 WARN, >15000 ALERT.
  - `inputWithoutFocus(e: {hasFocus: boolean, inputType: string}): boolean` — 포커스 없이 들어온 입력이면 true.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSidebarResize, pairLeaves, pointerLeaveSignal, inputWithoutFocus } from './detectors.js';

test('사이드바: outer 같고 inner 80px 이상 감소', () => {
  const r = detectSidebarResize({ innerWidth: 1920, outerWidth: 1920, innerHeight: 1000, outerHeight: 1080 },
                                { innerWidth: 1520, outerWidth: 1920, innerHeight: 1000, outerHeight: 1080 });
  assert.deepEqual(r, { type: 'SIDEBAR_SUSPECT', deltaInner: 400 });
});
test('사이드바: 창 자체 크기 변경은 신호 아님', () => {
  assert.equal(detectSidebarResize({ innerWidth: 1920, outerWidth: 1920, innerHeight: 1000, outerHeight: 1080 },
                                   { innerWidth: 960, outerWidth: 960, innerHeight: 1000, outerHeight: 1080 }), null);
});
test('사이드바: 50px 감소는 신호 아님', () => {
  assert.equal(detectSidebarResize({ innerWidth: 1920, outerWidth: 1920, innerHeight: 1000, outerHeight: 1080 },
                                   { innerWidth: 1870, outerWidth: 1920, innerHeight: 1000, outerHeight: 1080 }), null);
});
test('이탈·복귀 쌍과 지속 시간', () => {
  assert.deepEqual(pairLeaves([{ t: 1000, kind: 'leave', cause: 'blur' }, { t: 6000, kind: 'return', cause: 'blur' }, { t: 9000, kind: 'leave', cause: 'hidden' }]),
    [{ cause: 'blur', start: 1000, end: 6000, durationMs: 5000 }, { cause: 'hidden', start: 9000, end: null, durationMs: null }]);
});
test('커서 이탈 단계', () => {
  assert.equal(pointerLeaveSignal(999), null);
  assert.equal(pointerLeaveSignal(1000).severity, 'INFO');
  assert.equal(pointerLeaveSignal(3000).severity, 'WARN');
  assert.equal(pointerLeaveSignal(15001).severity, 'ALERT');
});
test('포커스 없는 입력', () => {
  assert.equal(inputWithoutFocus({ hasFocus: false, inputType: 'insertText' }), true);
  assert.equal(inputWithoutFocus({ hasFocus: true, inputType: 'insertText' }), false);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test experiments/detection-lab/` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: `detectors.js`에 위 4개 함수 구현** (ES 모듈 `export`)
- [ ] **Step 4: 통과 확인** — Run: `node --test experiments/detection-lab/` / Expected: 6 tests PASS
- [ ] **Step 5: Commit** — `git add experiments/detection-lab && git commit -m "feat(lab): 감지 실험 판정 함수"`

### Task 2: 실험 페이지 — 이벤트 기록·화면 가림·내보내기

**Files:**
- Create: `experiments/detection-lab/index.html`, `experiments/detection-lab/lab.js`, `experiments/detection-lab/README.md`

**Interfaces:**
- Consumes: Task 1의 4개 함수.
- Produces: 내보내기 JSON 형식 `{ browser: string, userAgent: string, startedAt: string, scenario: string, trial: number, entries: {t: number, wall: number, kind: string, detail: object}[] }`

- [ ] **Step 1: 페이지 구성 구현**
  - 상단: 시나리오 선택(`<select>`: 8장 시나리오 목록 + 일상 행동 목록), 회차 번호 입력, [전체화면 진입], [기록 시작/정지], [JSON 내보내기], [로그 지우기], "커서 이탈 시 화면 가림" 체크박스(기본 켬).
  - 본문: 가짜 시험지(객관식 1개, 서술형 `<textarea>` 1개, 오탐 측정용 `<select>` 1개).
  - 오른쪽: 실시간 로그(최근 200건), 후보 신호 카운터(시나리오별 발생 횟수).
- [ ] **Step 2: 기록할 이벤트 연결** — `visibilitychange`, `blur`/`focus`, 1초 `document.hasFocus()` 폴링(변화 시만 기록 + 예상 대비 지연 ms), `fullscreenchange`, `resize`(inner/outer 4값, 직전 값과 함께 `detectSidebarResize` 결과), `document`의 `mouseleave`/`mouseenter` 및 `mouseout`(`relatedTarget === null`), `keydown`(Alt·Meta·Control·Tab·F11·Escape만), `screen.isExtended`(시작 시 + `screen` `change` 이벤트), `MutationObserver`(body 하위에 페이지가 만들지 않은 요소 추가 시 태그명·id·class), `selectionchange`(선택 길이 ≥ 20자일 때), `copy`, `paste`, `drop`, `input`(그때의 `hasFocus`와 `inputWithoutFocus` 결과), `compositionstart`/`compositionend`.
- [ ] **Step 3: 화면 가림** — 체크박스가 켜져 있으면 `mouseleave` 즉시 시험지 영역에 흰 덮개 + "커서를 시험 화면 안으로 다시 가져와 주세요", `mouseenter`에서 제거. 복귀 시 지속 시간으로 `pointerLeaveSignal` 결과 기록.
- [ ] **Step 4: README 작성** — 실행 방법(`npx serve experiments/detection-lab` → `http://localhost:3000`), 브라우저 버전 확인법(`chrome://version`, `edge://version`), 회차 진행 절차(시나리오 선택 → 회차 입력 → 기록 시작 → 행동 → 기록 정지 → 내보내기), 파일 이름 규칙 `{browser}-{scenario}-{trial}.json`을 `experiments/detection-lab/results/`에 저장.
- [ ] **Step 5: 수동 확인** — Chrome에서 페이지를 열고 [전체화면 진입] → 다른 탭 이동·복귀 → 로그에 `visibilitychange hidden/visible`, `blur/focus`가 찍히고 JSON 내보내기 파일이 위 형식인지 확인. Expected: 로그와 파일 모두 확인됨.
- [ ] **Step 6: Commit** — `git commit -m "feat(lab): 감지 실험 페이지"`

### Task 3: 결과 집계 스크립트와 STUDY 문서 양식

**Files:**
- Create: `experiments/detection-lab/summarize.js`, `experiments/detection-lab/summarize.test.js`, `docs/STUDY.md`

**Interfaces:**
- Consumes: Task 2의 내보내기 JSON.
- Produces: `summarize(files: ExportJson[]): {browser, scenario, trials: number, hits: Record<signalName, number>}[]`, CLI `node experiments/detection-lab/summarize.js results/` → 마크다운 표 출력.
  - 신호 이름: `VISIBILITY_HIDDEN`, `BLUR`, `FULLSCREEN_EXIT`, `SIDEBAR_SUSPECT`, `POINTER_LEAVE`, `MULTI_MONITOR`, `DOM_INJECTED`, `INPUT_WITHOUT_FOCUS`, `LARGE_SELECTION`. 한 회차에 여러 번 발생해도 그 회차는 1 hit.

- [ ] **Step 1: 실패하는 테스트** — 같은 시나리오 3회차 중 2회차에 `SIDEBAR_SUSPECT`가 있으면 `{trials: 3, hits: {SIDEBAR_SUSPECT: 2}}`; 브라우저가 다르면 행이 분리됨.
- [ ] **Step 2: 실패 확인** — `node --test experiments/detection-lab/` / FAIL
- [ ] **Step 3: `summarize` 구현 + CLI(마크다운 표: 행=시나리오, 열=신호, 칸="hits/trials")**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: `docs/STUDY.md` 양식 작성** — 과제 형식(몰랐던 것 → 공부 방법·자료 → 적용·결과)으로 절 구성:
  - 1. 브라우저 이탈 감지 API (visibilitychange·blur·fullscreen) — 몰랐던 것/공부/적용·결과
  - 2. 브라우저 내 AI(사이드바·확장) 흔적 감지 실험 — 실험 환경(브라우저 버전, OS, 모니터 수), 결과 표(집계 스크립트 출력 붙여넣기), 채택/제외 판단과 근거
  - 3. 커서 이탈 화면 가림 실험(SPEC 5.6)
  - 4. 일상 행동 오탐 측정
  - (이후 계획에서 추가) Socket.IO 실시간 통신, 배포
- [ ] **Step 6: Commit** — `git commit -m "feat(lab): 실험 결과 집계와 STUDY 양식"`

### Task 4: (사용자 수행) 실험 실행과 판단

- [ ] **Step 1:** 사용자가 Chrome·Edge에서 SPEC 8장 시나리오와 일상 행동 시나리오를 각 10회 수행하고 JSON을 `results/`에 저장.
- [ ] **Step 2:** `node experiments/detection-lab/summarize.js experiments/detection-lab/results/` 출력을 STUDY 2~4절에 붙여넣고 채택 기준으로 판단.
- [ ] **Step 3:** 채택 항목이 있으면 SPEC 5.1 표에 행 추가(버전 올림), `docs/DECISIONS.md`에 결정 기록. 결과는 계획 2(감지·대시보드)에 반영.
- [ ] **Step 4: Commit** — `git commit -m "docs: 감지 실험 결과와 채택 판단"`
