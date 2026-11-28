# 계획 3: 부하·실시간성·답안 보존·공정성 검증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 이 계획은 새 기능이 아니라 **PRD 성공 기준을 측정하는 검증 작업**이다. 제품 코드 수정은 측정 중 발견된 결함에 한해 Coordinator 승인 후에만 한다.

**Goal:** SPEC 9장의 성공 기준 2(동시 응시)·3(실시간성)·4(답안 보존)·6(공정성)을 자동 측정하고 결과를 `docs/STUDY.md`에 남긴다.

**Architecture:** 부하는 Node 스크립트(`socket.io-client`)로 실제 서버에 붙고, 답안 보존은 Playwright(로컬 전용), 공정성은 Vitest 정적 검사. 측정 결과는 숫자와 환경을 함께 기록한다.

**Tech Stack:** TypeScript(tsx), socket.io-client, Playwright, Vitest.

**Spec:** `docs/SPEC.md` v1.4.4 9장(성공 기준 측정 절차), 5.2(전송 규칙), F-11(답안 저장), F-13(대시보드), 7.2(이벤트).

## 범위 (사용자 결정 2026-11-28: 계획 3 진행)
- **[자동]** Task 1(부하·실시간성), Task 2(답안 보존 자동화 1개), Task 3(공정성 정적 검사 확대)
- **[수동·사용자]** 우회 시나리오(기준 5)의 Edge 항목, 답안 보존 수동 10회, 지인 1명 접속 테스트(기준 7), Render 배포 URL에서의 9단계 체크리스트(기준 1). 결과는 STUDY에 사용자가 알려 주면 Coordinator가 반영.
- **[제외]** F-20 데이터 보관 작업.

## Global Constraints
- 부하·E2E는 **전용 DB**(`exam_load`·`exam_e2e`, 이름이 `_test`로 끝나지 않아도 되지만 개발 DB와 분리)만 쓴다. `.env`는 읽지 않는다. 운영(Render) 서버에 부하를 걸지 않는다(무료 서버·공용 DB 보호).
- 가상 학생 입장은 입장 시도 제한(IP당)에 걸리므로 부하 스크립트는 서버를 `loopback` 환경 변수로 띄우거나 시험 데이터를 DB에 직접 시드한다(기존 `server/test/helpers`·`scripts/demo-reset.ts` 방식 참고). 제한 값은 바꾸지 않는다.
- 화면 문구 금지어: "부정행위", "AI 사용", "적발", "커닝".

## Review Focus
1. **부하 중 일부 가상 학생이 끊겼다 재연결** → 답안이 보존되고 제출 20/20. → Task 1.
2. **교수자 소켓이 느려도 서버가 막히지 않는다**(수신 누락 0은 소켓별 카운트로 확인). → Task 1.
3. **네트워크 차단 중 입력한 답안이 복구 후 저장되고 새로고침해도 남는다.** → Task 2.
4. **정적 검사가 `ko.ts`뿐 아니라 화면에 렌더링되는 모든 클라이언트 소스를 훑는다.** → Task 3.

---

### Task 1: 부하·실시간성 측정 스크립트 (`scripts/load-test.ts`)

**Files:**
- Create: `scripts/load-test.ts`
- Modify: `package.json`(`"load-test": "tsx --env-file-if-exists=.env scripts/load-test.ts"` — `.env` 자동 로드는 기존 스크립트와 같은 방식이며 이 작업은 `.env`를 읽거나 쓰지 않는다)
- Create: `docs/load-test-results/` 아래 결과 JSON(요약)

**Interfaces:**
- Consumes: 학생 입장 API(`POST /api/student/entry`…)·소켓 이벤트(`hb`, `signal`, `answer:save`, `attempt:state`, `exam:started`), 교수자 로그인(`/api/staff/login`)·`dashboard:join`/`signal:new`. 정확한 경로·페이로드는 `server/src/routes`·`server/src/realtime/socket.ts`·SPEC 7장을 읽어 따른다.
- Produces: `npm run load-test -- --base http://localhost:PORT [--students 20]` 가 종료 코드 0/1과 JSON 요약(`submitted`, `http5xx`, `staffMissed`, `signalLatencyMs{p50,p95,max}`, 환경: Node 버전·CPU·DB)을 출력한다.

- [ ] **Step 1:** 가상 학생 20명(기본값): 입장→대기→(교수자 시작)→10초마다 `answer:save`·2분마다 `signal`(LEAVE 등 일부는 `LEAVE_START`+`LEAVE`)→제출. 교수자 소켓 2개가 `dashboard:join` 후 `signal:new`를 수신.
- [ ] **Step 2:** 실시간성: 학생이 `signal` ack를 받은 시각이 아니라 **보낸 시각**(`performance.now()`)과 교수자 소켓의 `signal:new` 수신 시각 차이를 같은 프로세스에서 측정, 100건 이상 표본, 교수자 소켓별 수신 누락 수를 센다. 합격: 제출 20/20, 서버 5xx 0, 수신 누락 0, 95% ≤ 2000ms.
- [ ] **Step 3:** 단위 점검: 순수 함수(백분위 계산·요약)는 Vitest로 테스트. 스크립트 전체는 로컬 서버(`exam_load` DB)에서 실제로 실행해 결과를 JSON으로 저장.
- [ ] **Step 4:** 결과를 `docs/STUDY.md`에 새 절로(환경·표본 수·p50/p95/max·합격 여부) 정리하는 문안을 보고에 포함(STUDY 반영은 Coordinator).
- [ ] **Step 5:** Commit — `test: 부하·실시간성 측정 스크립트 (계획3 Task1)`

### Task 2: 답안 보존 자동화 (`e2e/answer-preservation.spec.ts`)

**Files:** Create `e2e/answer-preservation.spec.ts` (기존 `core-flow.spec.ts` 헬퍼 재사용, `core-flow` 수정은 불가피한 최소만).

- [ ] **Step 1:** 시나리오: 응시 중 서술형 입력 → 네트워크 차단(`context.setOffline(true)`) → 추가 입력 → 새로고침(오프라인) → 복구 후 온라인 → 입력한 답이 보존되고 서버(API 조회)에도 저장됨. 이를 연속 3회 반복해 모두 통과(플레이크 확인).
- [ ] **Step 2:** `npm run e2e` 전체가 통과하는지 확인(기존 3개 + 신규). 포트·DB는 기존 E2E 설정을 따른다.
- [ ] **Step 3:** Commit — `test: 답안 보존 E2E (계획3 Task2)`

### Task 3: 공정성 정적 검사 확대 (`client/src/copy/ko.test.ts`)

**Files:** Modify `client/src/copy/ko.test.ts` (필요 시 신규 테스트 파일).

- [ ] **Step 1:** 금지어 검사가 `ko.ts` 문자열뿐 아니라 `client/src/**/*.{ts,tsx}`(테스트 파일·`*.test.*` 제외)의 한글 문자열 리터럴·JSX 텍스트도 훑게 한다. 금지어가 단정문(테스트의 "AI 사용 여부를 판단하지 않음" 같은 부정 서술)에 쓰인 곳은 `ko.ts` 외 소스에서 허용 목록 없이 통과해야 하므로, 허용할 곳이 있으면 이유와 함께 허용 목록에 명시. 위반 사례를 임시로 넣어 테스트가 실패하는 것을 확인한 뒤 되돌린다(변이 시험).
- [ ] **Step 2:** 조치 기록 통합 테스트(PRD 기준 6의 두 번째 항목)는 이미 `server/test/actions.test.ts`에 있음을 확인하고 테스트 이름으로 보고.
- [ ] **Step 3:** Commit — `test: 금지어 정적 검사 확대 (계획3 Task3)`

## 실행 순서
| 묶음 | 작업 | 담당 |
|---|---|---|
| 병렬 | Task 1, Task 2, Task 3 | Sonnet(Task 3은 Haiku 가능), 서로 다른 파일 |
| 후 | STUDY 반영·RETROSPECTIVE·평가자 안내(Coordinator, 문서 PR) | Coordinator |
