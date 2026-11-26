# 감지 실험 페이지 (detection-lab)

SPEC 5.2·5.6·8장의 "검증 필요" 감지 항목을 **Chrome·Edge에서 직접 실험**하기 위한 독립 페이지입니다.
제품 코드(`client/`, `server/`)와 공유하지 않는 **버리는 코드**이며, 결과는 `docs/STUDY.md`에 기록합니다.

## 실행
브라우저 모듈은 `file://`로 열면 동작하지 않으므로 로컬 서버가 필요합니다.

```bash
npx serve experiments/detection-lab      # → 표시된 주소(보통 http://localhost:3000)
# 또는 Python이 있다면
python -m http.server 3100 -d experiments/detection-lab   # → http://localhost:3100
```

## 실험 전 준비
1. **브라우저 버전 기록**: Chrome은 `chrome://version`, Edge는 `edge://version` (페이지 상단에도 표시됨).
2. OS, 모니터 대수(두 번째 모니터 시나리오 때 필요), 사용한 확장·사이드바 종류를 메모해 둡니다(STUDY 문서에 기록).
3. 한 시나리오마다 **10회** 반복합니다. 회차 사이에 페이지를 새로고침하지 않아도 됩니다(기록 시작이 로그를 초기화).

## 한 회차 진행 절차
1. 시나리오 선택, 회차 번호 입력
2. (필요하면) **[전체화면 진입]** — 전체화면은 버튼 클릭으로만 들어갈 수 있습니다
3. **[기록 시작]** → 시나리오 행동 수행 → **[기록 정지]**
4. **[JSON 내보내기]** → 내려받은 파일을 `experiments/detection-lab/results/`에 저장
   - 파일명은 자동 생성: `{browser}-{scenario}-{trial}.json` (예: `chrome-tab-switch-3.json`)

화면 오른쪽의 **후보 신호 카운터**가 이번 기록에서 발생한 신호를 바로 보여 줍니다(0이 아닌 값은 빨간색).
"커서가 나가면 화면 가림"을 켜 두면 SPEC 5.6의 동작(커서가 페이지 밖이면 흰 화면 + 안내)까지 함께 확인합니다.

## 시나리오 (SPEC 8장)
**대상 행동** — `tab-switch` 다른 탭 이동 · `alt-tab` 다른 앱 전환 · `split-screen` 화면 분할 · `second-monitor-window` 두 번째 모니터로 창 이동 ·
`cursor-second-monitor` 커서를 두 번째 모니터로 · `cursor-over-sidebar` 커서를 AI 사이드바 위에 올리고 읽기만 · `chrome-gemini-sidebar` · `claude-extension-sidebar` · `edge-copilot-sidebar` ·
`fullscreen-sidebar` 전체화면 중 사이드바 시도 · `ai-extension-read` AI 확장의 페이지 읽기 · `agent-input` 에이전트형 조작

**일상 행동 (오탐 측정)** — `fp-permission-popup` · `fp-os-notification` · `fp-update-window` · `fp-lid-sleep` · `fp-ime-toggle` · `fp-hangul-typing` · `fp-touchpad-edge` · `fp-fullscreen-top-edge`

채택 기준(SPEC 8장): 대상 행동에서 신호가 **10회 중 9회 이상**, 일상 행동에서 같은 신호가 **10회 중 1회 이하**.

## 후보 신호
| 신호 | 발생 조건 |
|---|---|
| `VISIBILITY_HIDDEN` | 탭이 숨겨짐(`visibilitychange` → hidden) |
| `BLUR` | 창 포커스 상실(`blur`) |
| `FULLSCREEN_EXIT` | 전체화면이었다가 해제됨 |
| `SIDEBAR_SUSPECT` | 창(outer) 너비는 같고 페이지(inner) 너비만 80px 이상 감소 |
| `POINTER_LEAVE` | 커서가 페이지 밖에 1초 이상 머물렀다가 복귀 (`severity`·`durationMs` 포함) |
| `MULTI_MONITOR` | `screen.isExtended === true` (시작 시, 모니터 구성 변경 시) |
| `DOM_INJECTED` | 이 페이지가 만들지 않은 요소가 DOM에 추가됨(태그·id·class 기록) |
| `INPUT_WITHOUT_FOCUS` | 페이지에 포커스가 없는데 `input` 이벤트 발생 |
| `LARGE_SELECTION` | 20자 이상 텍스트 선택 |

원시 이벤트(`visibilitychange`, `blur`, `focus`, `hasFocusPoll`, `fullscreenchange`, `resize`, `mouseleave`, `mouseenter`, `mouseout-null`, `keydown`(Alt·Meta·Control·Tab·F11·Escape), `screen`, `copy`, `paste`, `drop`, `input`, `compositionstart/end`)와
`leave`/`return`(이탈·복귀, `cause`: `hidden`·`blur`)도 모두 함께 기록됩니다. `hasFocusPoll`은 1초 폴링이며 상태가 바뀔 때만 기록하고 `driftMs`(예상 시각과의 차이, 백그라운드 탭 지연)를 남깁니다.

## 내보내기 JSON 형식
```json
{
  "browser": "Google Chrome 131",
  "userAgent": "…",
  "startedAt": "2026-11-26T01:23:45.678Z",
  "scenario": "tab-switch",
  "trial": 3,
  "entries": [
    { "t": 1234.5, "wall": 1766710000000, "kind": "signal", "detail": { "name": "BLUR" } }
  ]
}
```
`t`는 `performance.now()`(ms), `wall`은 `Date.now()`. 신호는 `kind: "signal"`, `detail.name`에 이름이 들어갑니다.
결과 집계는 `node experiments/detection-lab/summarize.js experiments/detection-lab/results/`(계획 0 Task 3).

## 알아둘 점
- **전체화면 진입은 사용자 클릭이 필요**합니다(페이지 로드 직후 자동 진입 불가).
- `<select>`를 열면 브라우저 기본 팝업이 떠서 `mouseleave`가 발생하는지 확인할 수 있습니다(오탐 측정용으로 시험지에 하나 넣어 둠).
- 이 페이지가 만든 요소(로그 등)는 `data-lab` 속성으로 표시해 `DOM_INJECTED`에서 제외합니다.
- `window.__lab.state`에서 현재 기록 상태를 확인할 수 있습니다(디버깅용).
