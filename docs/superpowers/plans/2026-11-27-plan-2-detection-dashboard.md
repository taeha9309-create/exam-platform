# 계획 2: 행동 감지와 감독 대시보드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생 응시 중 화면 이탈·전체화면 해제·붙여넣기를 기록하고, 위반 5회마다 응시를 자동 잠금하며, 감독관이 대시보드에서 학생 카드·신호·조치를 실시간으로 보고 처리하는 흐름을 배포 URL에서 동작시킨다. (계획 1의 응시·승인·채점 위에 얹는다)

**Architecture:** 신호 종류·심각도·위반 판정·네트워크 장애 판정은 DB와 무관한 순수 함수(`server/src/domain/signals.ts`)로 두고 단위 테스트한다. 서버는 학생 소켓의 `hb`·`signal`을 검증해 `Signal`로 저장하고(`services/signals.ts`), 위반 카운트와 자동 잠금은 응시 행 잠금 안에서 처리한다. 감독관 화면은 `dashboard:snapshot`(DB가 원본)과 변경분 이벤트(`attempt:updated`, `signal:new`)만으로 상태를 만든다. 감독관 조치는 `services/actions.ts` 한 곳에서 상태 전이·`ProctorAction` 기록·알림을 처리한다. 학생 클라이언트는 `useSignalCollector` 훅이 신호를 `seq`와 함께 큐에 쌓아 보낸다.

**Tech Stack:** 계획 1과 같다(Node 24, Express, Socket.IO 4, Prisma 6 + PostgreSQL, React 18, Vitest, Playwright).

**Spec:** `docs/SPEC.md` v1.4.2 · ADR-001~014 (`docs/DECISIONS.md`) — 2장(상태 전이), 5장(5.1~5.5, 5.7), F-12~F-16, 7장(7.1 `timeline`·`actions`, 7.2 신호·대시보드 이벤트). **5.6(`POINTER_LEAVE`)과 0단계 실험 채택 항목은 실험 결과 후 SPEC 개정이 있어야 하므로 Task 11에서 다룬다.** `F-20`(데이터 보관 작업)은 이번 일정에서 제외한다(한계로 문서에 적는다).

## 범위 태그 (사용자 결정, 2026-11-27)
- **[핵심]** 일정 안에 반드시: Task 0·1·2·3·4·6·7·8·10
- **[되면]** 여력이 있으면: Task 5(연결 감시·네트워크 장애 묶음), Task 9(학생 상세 패널)
- **[조건부]** 실험 결과 후: Task 11
- **[제외]** F-20 데이터 보관 작업, 자발적 시범 운영

## Global Constraints
- 모든 화면 문구는 `client/src/copy/ko.ts` 한 파일에서만 정의. 금지어 "부정행위", "AI 사용", "적발", "커닝"(타임라인·배지·알림 모두 관찰 사실만 서술).
- 위반 기준 5회 고정(`VIOLATION_LIMIT = 5`). 위반으로 세는 신호: `LEAVE`(`durationMs ≥ 3000`), `FULLSCREEN_EXIT`, `PASTE`, `DROP`(차단된 시도 포함). 세지 않는 신호: 3초 미만 이탈, `LEAVE_START`, `DISCONNECT`, `RECONNECT`, `HEARTBEAT_GAP`, `SEQ_GAP`, `MULTI_MONITOR`. 위반은 **`ACTIVE` 상태에서 발생한 신호만** 센다.
- `LEAVE` severity: <3초 `INFO`, 3~15초 `WARN`, >15초 `ALERT`. `LEAVE_START`·`FULLSCREEN_EXIT`·`PASTE`·`DROP`·`MULTI_MONITOR`·`DISCONNECT`·`HEARTBEAT_GAP`·`SEQ_GAP`은 `WARN`, `RECONNECT`는 `INFO`.
- 신호가 저장되면 `unackedSeverity`를 지금 값과 신호 severity 중 높은 값으로 올린다(네트워크 신호가 장애 묶음에 포함되면 올리지 않음, 5.5).
- 자동 잠금: `violationCount`가 5의 배수가 되는 순간 `PAUSED` + `ProctorAction { type: 'AUTO_PAUSE', staffId: null, reason: '시스템 자동 일시정지(위반 N회)' }`. 해제는 감독관 `RESUME`으로만, 카운트는 초기화하지 않는다. 잠긴 동안에도 시간은 흐른다(D-014).
- 하트비트 5초(`HEARTBEAT_MS`), `HEARTBEAT_GAP` 15초, `DISCONNECT` 판정 10초, 네트워크 장애 묶음: 10초 안에 3명 이상 또는 응시 인원의 30% 이상.
- 모든 클라이언트 메시지(`hb`, `signal`)는 응시 단위로 1씩 증가하는 `seq`를 가지며 `localStorage`에 보관해 새로고침 후에도 이어진다. 끊긴 동안의 신호는 큐에 쌓았다가 재연결 시 순서대로 보낸다.
- 감독관 조치 사유는 필수(`ACK`만 불필요). `ADD_TIME`은 1~60분, `PAUSE`·`WARN`·`RESUME`·`TERMINATE`·`ADD_TIME`은 모두 `ProctorAction(staffId, type, reason, payload, createdAt)`으로 같은 트랜잭션에서 기록.
- 잠금 순서는 시험 → 응시(계획 1의 규칙). 알림은 커밋 후, 실패해도 상태 변경을 되돌리지 않는다. 학생 소켓만 `hb`·`signal`을 보낼 수 있다.

## Review Focus
1. **오프라인 중 이탈을 반복하고 재연결** → 큐의 신호가 `seq` 순서대로 도착하고 `SEQ_GAP`·중복 저장이 생기지 않는다. → Task 6(클라이언트 큐), Task 2(서버 중복 `seq` 무시) 테스트.
2. **위반이 5번째가 되는 순간 신호 두 건이 동시에 도착** → 카운트가 5를 건너뛰지 않고 자동 잠금이 정확히 한 번 일어난다(`AUTO_PAUSE` 기록 1건). → Task 2 `Promise.all` 테스트.
3. **`PAUSED`(잠금) 중·시험 종료 후 도착한 신호** → 위반으로 세지 않고(`PAUSED`) / 저장하지 않는다(종착 상태). → Task 2 테스트.
4. **감독관이 대시보드를 새로고침하거나 두 교수자가 동시에 연다** → 같은 카드 색·상태·승인 요청이 복원된다(스냅샷 = DB). → Task 4·8 테스트.
5. **클라이언트가 위조한 신호**(알 수 없는 `type`, 서버 전용 타입, 거대한 `meta`, 음수·거대한 `durationMs`, 다른 응시의 `questionId`) → 거부되고 저장·카운트되지 않는다. → Task 2 테스트.

---

## 작업 순서와 병렬 묶음
| 파동 | 작업 | 선행 | 담당·리뷰 |
|---|---|---|---|
| 1 (병렬) | Task 0 소켓 보안 후속 · Task 1 공유 타입·도메인 · Task 6 학생 신호 수집 | 없음 | Sonnet / 0: Opus, 1·6: Sonnet |
| 2 (병렬) | Task 3 감독관 조치·타임라인 API · Task 4 대시보드 스냅샷·변경분 · Task 8 감독 대시보드 화면 | 1 | Sonnet / 3: Opus, 4·8: Sonnet |
| 3 (병렬) | Task 2 서버 신호 수신·위반·자동 잠금 · Task 7 학생 화면 보호 | 2: 0·1·4, 7: 6 | Sonnet / 2: Opus, 7: Sonnet |
| 4 | Task 5 연결 감시·네트워크 장애 [되면] · Task 9 학생 상세 패널 [되면] · Task 10 E2E | 5: 2, 9: 3·8, 10: 2·3·7·8 | Sonnet |
| 후 | Task 11 실험 채택 항목 [조건부] | 실험 결과 + SPEC 개정 | Sonnet |
`shared/`·`server/src/app.ts`·`broadcast.ts`·`ko.ts`는 여러 작업이 건드리므로 병합 때 Coordinator가 충돌을 해결한다.

### Task 0: 소켓 보안 후속 (이슈 #46) [핵심]

**Files:**
- Modify: `server/src/realtime/socket.ts`, `server/src/security/rateLimit.ts`(재사용만), `server/test/realtime.test.ts`
- Create: `server/test/socketLimits.test.ts`

**Interfaces:**
- Consumes: 계획 1 Task 6의 `attachSocket`, `authenticateStaff`, `createRateLimiter`, `normalizeIpKey`.
- Produces: 교수자 소켓은 인증 때 토큰 `exp`까지만 연결을 유지하고 `dashboard:join`마다 DB 재확인에 더해 **주기적(60초) 재확인**으로 계정 삭제·만료 시 연결을 끊는다. 소켓 인증 실패는 IP(`/64` 정규화)당 **교수자 쿠키 인증 1분 30회(`STAFF_AUTH_FAIL_MAX`)·학생 토큰 1분 200회(`STUDENT_AUTH_FAIL_MAX`)로 한도를 분리**해(교실 공용 IP에서 한 명의 실패가 같은 IP의 모든 학생 연결을 막지 않도록, Opus 리뷰 M-2) 넘으면 DB 조회 없이 거절하고, **IP별 진행 중(inflight) 인증 수와 연결 하나당 동시 인증 1개 제한**으로 한 연결에서 CONNECT를 연달아 보내는 버스트를 막는다(Opus 리뷰 M-1). 프록시 뒤에서 실제 클라이언트 IP를 쓰도록 `attachSocket(httpServer, { trustProxy })`에 앱과 같은 홉 수를 넘기고 `X-Forwarded-For`의 포트는 제거한다. 한 클라이언트(같은 학생 응시·같은 교수자 계정)의 소켓은 동시에 `MAX_SOCKETS_PER_PRINCIPAL = 3`개까지, 넘으면 가장 오래된 것을 끊는다.

- [ ] **Step 1: 실패하는 테스트** — `socketLimits.test.ts`: (a) 교수자 소켓이 `dashboard:join` 뒤 계정을 삭제하면 재확인 주기(테스트에서 주입한 50ms) 안에 `disconnect`된다, (b) 만료된 JWT로 이미 붙은 소켓이 `exp` 시각에 끊긴다(가짜 시계), (c) 잘못된 학생 토큰으로 같은 IP에서 31번째 연결은 DB 호출 없이 `connect_error`(spy로 `findAttemptByToken` 호출 수 확인), (d) 같은 학생 토큰으로 4번째 소켓을 열면 첫 소켓이 끊긴다.
- [ ] **Step 2: 실패 확인** — `npm test -w server -- socketLimits` / Expected: FAIL
- [ ] **Step 3: 구현** — `attachSocket(httpServer, options?: { staffRecheckMs?: number; now?: () => number })`. 만료 타이머와 재확인 타이머는 `socket.on('disconnect')`에서 정리. 인증 실패 한도는 `createRateLimiter` 별도 인스턴스.
- [ ] **Step 4: 통과 확인** — 위 테스트와 기존 `realtime.test.ts` PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(realtime): 소켓 재검증과 연결 수·인증 실패 제한 (#46)"`

### Task 1: 공유 타입·상수와 신호 도메인 함수 [핵심]

**Files:**
- Modify: `shared/src/index.ts`
- Create: `server/src/domain/signals.ts`, `server/test/domain/signals.test.ts`

**Interfaces:**
- Produces(`shared`): 상수 `LEAVE_VIOLATION_MS = 3000`, `HEARTBEAT_GAP_MS = 15000`, `DISCONNECT_GRACE_MS = 10000`, `NETWORK_INCIDENT_WINDOW_MS = 10000`, `NETWORK_INCIDENT_MIN_COUNT = 3`, `NETWORK_INCIDENT_RATIO = 0.3`; 타입 `ClientSignalType = 'LEAVE'|'LEAVE_START'|'FULLSCREEN_EXIT'|'PASTE'|'DROP'`, `SignalDto = { id: string; type: SignalType; severity: SignalSeverity; clientAt: number | null; receivedAt: number; durationMs: number | null; questionId: string | null; meta: Record<string, unknown> }`, `AttemptSummary = { attemptId: string | null; studentNo: string; name: string; state: AttemptState | null /* null = 미입장 */; ready: boolean; consentDeclined: boolean; violationCount: number; unackedSeverity: Severity; locked: boolean /* PAUSED이고 마지막 중지가 AUTO_PAUSE */; connected: boolean; away: boolean /* LEAVE_START 후 LEAVE 전 */; extraSeconds: number; deadline: number | null; pausedAt: number | null; lastSignal: { type: SignalType; severity: SignalSeverity; receivedAt: number } | null }`.
- Produces(`domain/signals.ts`): `signalSeverity(type: SignalType, durationMs?: number | null): SignalSeverity`, `countsAsViolation(type: SignalType, durationMs: number | null | undefined, state: AttemptState): boolean`, `maxSeverity(current: Severity, incoming: SignalSeverity): Severity`, `isNetworkSignal(type: SignalType): boolean`, `shouldAutoPause(newViolationCount: number): boolean`, `detectNetworkIncident(events: { attemptId: string; at: number }[], totalAttempts: number, now: number): { count: number; attemptIds: string[]; since: number } | null`.

- [ ] **Step 1: 실패하는 테스트** — `signals.test.ts`(표 기반): `signalSeverity('LEAVE', 2999)`=`INFO`, `3000`=`WARN`, `15000`=`WARN`, `15001`=`ALERT`, `LEAVE_START`·`FULLSCREEN_EXIT`·`PASTE`·`DROP`·`DISCONNECT`·`HEARTBEAT_GAP`·`SEQ_GAP`=`WARN`, `RECONNECT`=`INFO`; `countsAsViolation('LEAVE', 3000, 'ACTIVE')`=true, `2999`=false, `FULLSCREEN_EXIT`·`PASTE`·`DROP`은 `ACTIVE`에서 true, `PAUSED`·`WAITING`에서 false, `DISCONNECT`·`HEARTBEAT_GAP`·`SEQ_GAP`·`MULTI_MONITOR`·`LEAVE_START`·`RECONNECT`는 항상 false; `maxSeverity('NONE','INFO')`=`INFO`, `('ALERT','INFO')`=`ALERT`; `shouldAutoPause`: 4 false, 5 true, 6 false, 10 true, 0 false; `detectNetworkIncident`: 10초 안에 서로 다른 3명 → 객체, 같은 학생 3건은 null, 서로 다른 3명 이상이면 응시 인원과 무관하게 객체(3명 이상 **또는** 30% 이상이므로 "20명 중 5명"도 객체), 응시 20명 중 2명(10%) → null, 응시 5명 중 2명(40%) → 비율만으로 객체, 총원 0이면 비율 무시, 10초보다 오래된 이벤트는 제외.
- [ ] **Step 2: 실패 확인** — `npm test -w server -- signals` / Expected: FAIL
- [ ] **Step 3: 구현** — 순수 함수만(Prisma·시계 의존 없음, `now`는 인자). `shared`에는 값과 타입만 추가.
- [ ] **Step 4: 통과 확인** — PASS, 루트 `npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -m "feat(domain): 신호 심각도·위반 판정 순수 함수와 공유 타입"`

### Task 2: 서버 신호 수신·위반 카운트·자동 잠금 [핵심]

**Files:**
- Create: `server/src/services/signals.ts`, `server/test/signals.test.ts`
- Modify: `server/src/realtime/socket.ts`, `server/src/realtime/broadcast.ts`

**Interfaces:**
- Consumes: Task 0의 소켓 제한, Task 1의 `signalSeverity`·`countsAsViolation`·`maxSeverity`·`shouldAutoPause`, Task 4의 `broadcast.attemptUpdated(attemptId)`.
- Produces: `recordClientSignal(attemptId: string, tokenHash: string, payload: unknown, now: Date): Promise<{ ok: true } | { ok: false; code: 'INVALID' | 'NOT_ACTIVE' }>` — 소켓 `signal` 핸들러가 호출. `recordHeartbeat(attemptId: string, seq: number, now: Date): Promise<void>`(`lastHeartbeatAt`·`lastSeq` 갱신). `recordServerSignal(attemptId: string, type: 'MULTI_MONITOR'|'DISCONNECT'|'RECONNECT'|'HEARTBEAT_GAP'|'SEQ_GAP', meta: object, now: Date): Promise<void>`(Task 5가 사용, 기존 `recordEnv`의 `MULTI_MONITOR`도 이를 쓰도록 맞춘다). 소켓 이벤트 `signal` ack `{ ok: true } | { ok: false, code }`. 학생에게 `violation:counted { count, limit: 5, type }`, 감독관에게 `signal:new { attemptId, signal: SignalDto }`.

- [ ] **Step 1: 실패하는 테스트** — `signals.test.ts`(실제 DB·실제 소켓): (a) `FULLSCREEN_EXIT`를 `ACTIVE` 응시가 보내면 Signal 1건·`violationCount` 1·학생이 `violation:counted {count:1, limit:5}`·교수자가 `signal:new`를 받는다, (b) 위반 5건이면 응시가 `PAUSED`이고 `AUTO_PAUSE`(`staffId` null, 사유 "시스템 자동 일시정지(위반 5회)")가 1건 기록되고 `attempt:state PAUSED`가 간다, (c) **동시에 도착한 위반 신호 6건**(`Promise.all`)에서 신호 6건이 모두 저장되고 `violationCount`는 5(5번째 커밋 뒤 응시가 `PAUSED`가 되어 6번째는 SPEC 5.7에 따라 저장만 되고 세지 않음, 구현 중 확인)이며 `AUTO_PAUSE`는 정확히 1건, (d) `PAUSED` 응시의 `PASTE`는 저장되지만 카운트되지 않고, 종착 상태 응시의 신호는 `NOT_ACTIVE`로 거부되며 저장되지 않는다, (e) 2초짜리 `LEAVE`는 `INFO`로 저장되지만 카운트되지 않고 3초 `LEAVE`는 카운트된다, (f) **같은 `seq`를 두 번 보내면 두 번째는 무시**되고(Signal 1건, **ack는 `{ok:true}`** — 클라이언트가 ack 실패 때 같은 `seq`를 재전송하므로 ok가 아니면 큐 맨 앞이 영원히 막힘; 영구 거절은 `INVALID`·`NOT_ACTIVE`뿐) `seq`가 `lastSeq+2`면 `SEQ_GAP` 서버 신호 1건이 `meta {expected, got}`로 기록되며 위반 카운트는 늘지 않는다, (g) `LEAVE_START` 뒤 `LEAVE`가 오면 `meta.serverDurationMs`가 저장된다, (h) 위조 거부(Review Focus 5): 알 수 없는 `type`, 서버 전용 타입(`DISCONNECT`), `meta`가 2KB 초과, `durationMs`가 음수·`3_600_000` 초과·소수, 다른 시험의 `questionId`, 교수자 소켓·다른 응시의 토큰 → `INVALID` 또는 거부, (i) 폐기된 세션 토큰(해시 불일치)은 `NOT_ACTIVE`+연결 종료.
- [ ] **Step 2: 실패 확인** — `npm test -w server -- signals.test` / Expected: FAIL
- [ ] **Step 3: 구현** — 응시 행 `FOR UPDATE` 안에서 상태·토큰 해시를 다시 읽고 `seq` 처리, Signal 생성, `unackedSeverity` 갱신, 위반이면 `violationCount += 1` 후 `shouldAutoPause`면 `nextState(…,'PAUSE')`와 `pausedAt`, `AUTO_PAUSE` 기록을 같은 트랜잭션에서 한다(시험 행은 잠그지 않는다). 소켓 핸들러는 `answer:save`와 같은 속도 제한 버킷 방식을 따로 둔다(버스트 30, 초당 10). `meta`·`durationMs`·`type`은 엄격 검증(알 수 없는 키 거부). 알림은 커밋 후.
- [ ] **Step 4: 통과 확인** — PASS, 서버 전체 테스트 PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(signals): 신호 수신·위반 카운트·자동 잠금"`

### Task 3: 감독관 조치와 타임라인 API [핵심]

**Files:**
- Create: `server/src/services/actions.ts`, `server/test/actions.test.ts`
- Modify: `server/src/routes/attempts.ts`, `server/src/realtime/broadcast.ts`, `server/src/services/submission.ts`(종료 처리 시 객관식 채점 함수를 `TERMINATE`에서도 쓰도록 export)

**Interfaces:**
- Consumes: Task 1의 `AttemptSummary`·`SignalDto`, 계획 1의 `runExamTx`·`lockExam`·`nextState`·`broadcast`.
- Produces: `applyAction(attemptId: string, staffId: string, input: { type: 'WARN'|'PAUSE'|'RESUME'|'TERMINATE'|'ADD_TIME'|'ACK'; reason?: string; payload?: { minutes?: number; addPausedTime?: boolean } }, now?: Date): Promise<AttemptSummary>`. 기존 `APPROVE_*`·`REJECT_*` 처리는 그대로 두고 `POST /api/attempts/:id/actions`가 type으로 분기. `GET /api/attempts/:id/timeline` → `{ attempt: AttemptSummary; signals: SignalDto[] /* receivedAt 오름차순 */; actions: { id: string; type: ProctorActionType; reason: string; staffName: string | null; payload: object; createdAt: number }[] }`. 학생에게 `proctor:warning { message }`.

- [ ] **Step 1: 실패하는 테스트** — `actions.test.ts`: (a) 각 조치를 1회씩 실행하면 `ProctorAction`에 실행자·시각·사유가 모두 기록된다(F-16 AC), (b) `PAUSE` 사유 없이 → 400, `ACK`는 사유 없이 200이고 `unackedSeverity`가 `NONE`, (c) `PAUSE`→학생이 `attempt:state PAUSED`를 받고 `answer:save`가 `NOT_ACTIVE`로 거부, `RESUME`→`ACTIVE`로 이어서 저장 가능, (d) `ADD_TIME` 10분 → 그 응시의 `extraSeconds`만 600 늘고 `deadline`이 같은 만큼 늘며 다른 응시는 그대로, `minutes`가 0·61·소수·문자열이면 400, 한 응시의 `extraSeconds` 누적이 24시간(`MAX_EXTRA_SECONDS = 86400`)을 넘으면 409 `EXTRA_TIME_LIMIT`(기록·변경·알림 없음, 구현 중 결정), `WARN` 메시지는 한 줄만(줄바꿈·제어 문자 거부), (e) 자동 잠금된 응시를 `RESUME` + `addPausedTime:true`로 풀면 `RESUME`과 `ADD_TIME`이 **모두 기록**되고 `minutes = min(60, 올림((now − pausedAt)/60초))`(최소 1)이며 `pausedAt`은 null이 된다, (f) `WARN`은 `proctor:warning`이 학생 방에 가고 응시 상태는 그대로, (g) `TERMINATE`는 `ACTIVE`·`PAUSED`에서만 `TERMINATED`가 되고 제출된 객관식 답안이 채점되며(`awardedPoints`) 이미 종착이면 409 `INVALID_STATE`, (h) 무인증·학생 토큰 401, 잘못된 id 400, 없는 응시 404, 허용되지 않는 상태 조합은 409이며 기록·알림이 생기지 않는다, (i) 같은 응시에 `PAUSE` 두 건이 동시에 오면 하나만 200(409 하나)이고 기록은 1건, (j) `timeline`이 신호를 시간순으로, 조치에 `staffName`을 담고 passcode·해시·정답이 없다.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 시험 행 잠금 → 응시 행 잠금 순서, 같은 트랜잭션에서 상태 전이·`ProctorAction`, 커밋 후 알림(`attempt:state`, `proctor:warning`, `broadcast.attemptUpdated`). 사유는 `safeString`(1~500).
- [ ] **Step 4: 통과 확인** — PASS, 서버 전체 PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(actions): 감독관 조치와 타임라인 API"`

### Task 4: 대시보드 스냅샷과 변경분 [핵심]

**Files:**
- Create: `server/src/services/dashboard.ts`, `server/test/dashboard.test.ts`
- Modify: `server/src/realtime/socket.ts`(`dashboard:join` 뒤 스냅샷 전송), `server/src/realtime/broadcast.ts`(`attemptUpdated`), `server/src/services/entry.ts`·`examLifecycle.ts`·`submission.ts`(상태가 바뀌는 곳에서 `broadcast.attemptUpdated` 호출만 추가)

**Interfaces:**
- Consumes: Task 1의 `AttemptSummary`.
- Produces: `buildAttemptSummary(attempt, rosterEntry, lastSignal, lastPauseAction): AttemptSummary`(순수), `loadDashboardSnapshot(examId: string): Promise<{ exam: { id: string; title: string; status: ExamStatus; endsAt: number | null; lockNewEntry: boolean; serverNow: number; ready: number /* 준비 완료 인원 */; total: number /* 명단 인원 */ }; attempts: AttemptSummary[] /* 명단 전원, 미입장 포함, 학번순 */; pendingApprovals: { attemptId: string; kind: 'LATE' | 'DUPLICATE'; studentNo: string; name: string }[]; networkIncident: { count: number; attemptIds: string[]; since: number } | null }>`, `broadcast.attemptUpdated(attemptId: string): Promise<void>`(응시 요약을 `exam:{id}:staff` 방에 `attempt:updated`로 전송). `dashboard:join` 성공 뒤 같은 소켓에 `dashboard:snapshot` 이벤트를 보낸다(ack는 기존 `{ ok, code }` 유지).

- [ ] **Step 1: 실패하는 테스트** — `dashboard.test.ts`: (a) 응시 20명 중 일부만 입장한 시험의 스냅샷에 명단 20명이 모두 있고 미입장은 `state: null`·학번순, (b) `AUTO_PAUSE`로 잠긴 응시는 `locked: true`, 감독관 `PAUSE`는 `locked: false`, (c) `pendingApprovals`가 지각·중복 요청 각각 학번·이름과 함께 들어 있다, (d) **같은 시험을 두 교수자 소켓이 열면 둘 다 같은 스냅샷을 받고**, 상태 변경(예: 동의 완료) 뒤 둘 다 `attempt:updated`를 2초 안에 받는다, (e) 스냅샷을 다시 받아도(새로고침) 직전과 같은 `unackedSeverity`·`state`가 복원된다, (f) 학생 소켓은 스냅샷을 받지 못한다, (g) 스냅샷·변경분 어디에도 passcode·토큰 해시·정답이 없다.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 스냅샷은 쿼리 몇 개로(N+1 금지: 응시·명단·마지막 신호 그룹·마지막 중지 조치 그룹). `attemptUpdated`는 단일 응시를 다시 읽어 요약을 만들어 보낸다. 기존 상태 변경 지점(입장 확인, 준비 완료, 시작·종료, 제출, 승인)의 커밋 후 알림에 호출 한 줄씩 추가.
- [ ] **Step 4: 통과 확인** — PASS, 서버 전체 PASS(기존 `waiting:count`·`attempt:state` 테스트 유지)
- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): 스냅샷과 응시 요약 변경분"`

### Task 5: 연결 감시와 네트워크 장애 묶음 [되면]

**Files:**
- Create: `server/src/jobs/connectionMonitor.ts`, `server/test/connection.test.ts`
- Modify: `server/src/realtime/socket.ts`, `server/src/services/dashboard.ts`, `server/src/index.ts`(감시 시작·종료)

**Interfaces:**
- Consumes: Task 2의 `recordServerSignal`·`recordHeartbeat`, Task 1의 `detectNetworkIncident`·`isNetworkSignal`, Task 4의 `broadcast.attemptUpdated`.
- Produces: `startConnectionMonitor(options?: { intervalMs?: number; now?: () => Date }): { stop(): Promise<void> }`; 소켓 `disconnect` 후 `DISCONNECT_GRACE_MS` 안에 재연결이 없으면 `DISCONNECT`, 재연결하면 `RECONNECT`(`meta.offlineMs`); 연결돼 있으나 `lastHeartbeatAt`이 `HEARTBEAT_GAP_MS` 넘게 없으면 `HEARTBEAT_GAP`(응시당 갭 하나에 1건); `network:incident { count, attemptIds, since } | null`(해제 시 `null`).

- [ ] **Step 1: 실패하는 테스트** — `connection.test.ts`(가짜 시계·주입한 짧은 간격): (a) 소켓이 끊기고 10초(가짜 시계) 안에 돌아오면 `DISCONNECT`는 없고 `RECONNECT`만, 10초 넘게 안 돌아오면 `DISCONNECT` 1건, (b) 연결 중 하트비트가 15초 끊기면 `HEARTBEAT_GAP` 1건이고 `violationCount`는 늘지 않으며 갭이 이어져도 중복 기록하지 않고 하트비트가 돌아오면 다음 갭을 다시 기록, (c) **학생 3명이 10초 안에 `DISCONNECT`**면 `network:incident`가 가고 그 응시들의 `unackedSeverity`는 올라가지 않으며 Signal은 저장되고, 해제 조건이 되면 `null`이 간다, (d) 응시 20명 중 2명만 끊기면 장애가 아니다(카드 색 반영), (e) 종료·제출된 응시는 감시 대상이 아니다, (f) 감시 `stop()`이 진행 중 점검을 기다리고 서버 종료 때 정리된다.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 점검은 겹쳐 실행하지 않고 응시별 try/catch(`deadlineTicker`와 같은 패턴). 서버 재시작 직후에는 첫 점검에서 기존 응시를 즉시 `DISCONNECT`로 만들지 않도록 유예를 둔다.
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(monitor): 연결 끊김·하트비트 갭·네트워크 장애 묶음"`

### Task 6: 학생 신호 수집 클라이언트 [핵심]

**Files:**
- Create: `client/src/student/useSignalCollector.ts`, `client/src/student/signalQueue.ts`, `client/src/student/useSignalCollector.test.ts`, `client/src/student/signalQueue.test.ts`

**Interfaces:**
- Consumes: 계획 1의 `session.ts`(`localStorage` 접근 모음), `socket.ts`.
- Produces: `createSignalQueue(storage: Storage | null, key: string): { nextSeq(): number; enqueue(msg: { seq: number; type: ClientSignalType; clientAt: number; durationMs?: number; questionId?: string; meta: object }): void; drain(send: (msg) => Promise<{ ok: boolean }>): Promise<void>; size(): number }`(`seq`는 저장소에 보관해 새로고침 후 이어짐, 보낸 뒤 ack가 `ok`면 제거, 실패하면 순서를 유지한 채 남김). `useSignalCollector(options: { socket; examCode: string; enabled: boolean /* ACTIVE일 때만 신호 수집 */; heartbeatEnabled: boolean /* WAITING·ACTIVE·PAUSED */; pasteMode: 'RECORD' | 'BLOCK'; getQuestionId(): string | null }): { awayNow: boolean }` — 하트비트 `hb {seq}`를 5초마다, 탭 숨김·`blur`(1초 주기 `document.hasFocus()` 확인 포함) 이탈 시 `LEAVE_START` 즉시·복귀 시 `LEAVE {durationMs, meta:{cause}}`, `fullscreenchange`로 `FULLSCREEN_EXIT`, 답안 입력란 `paste`·`drop`에서 `PASTE`·`DROP {meta:{length, blocked}}`(BLOCK이면 `preventDefault`).

- [ ] **Step 1: 실패하는 테스트**(가짜 타이머·가짜 소켓) — (a) 하트비트가 5초마다 `seq`가 1씩 늘며 전송되고 신호와 `seq`를 공유한다, (b) 탭 숨김 → 즉시 `LEAVE_START`, 5초 뒤 복귀 → `LEAVE`(`durationMs≈5000`, `cause:'hidden'`), `blur`만 발생해도 `cause:'blur'`, 둘이 겹쳐도 `LEAVE`는 1건, (c) `fullscreenchange`로 전체화면이 풀리면 `FULLSCREEN_EXIT` 1건, (d) `BLOCK`에서 `paste`는 기본 동작이 막히고 `PASTE {length, blocked:true}`가 가며 `RECORD`에서는 `blocked:false`, (e) **오프라인 중 신호 3건을 쌓고 재연결하면 `seq` 순서대로 한 번씩** 전송되고 ack가 오기 전에는 제거되지 않으며 실패하면 순서가 유지된다(Review Focus 1), (f) 새로고침(새 큐 인스턴스)해도 `seq`가 이어지고 미전송 신호가 남아 있다, (g) `enabled=false`(`PAUSED`·대기)에서는 위반 신호를 만들지 않고 하트비트는 계속 보낸다, (h) 언마운트 시 모든 리스너·타이머가 정리된다.
- [ ] **Step 2: 실패 확인** — `npm test -w client -- useSignalCollector signalQueue` / Expected: FAIL
- [ ] **Step 3: 구현** — 이벤트 리스너는 `document`/`window`에 달고 정리. 시간은 `Date.now()`(테스트에서 가짜 타이머). `localStorage` 접근은 `try/catch`로 감싸 실패해도 메모리 큐로 동작.
- [ ] **Step 4: 통과 확인** — PASS, 루트 `npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -m "feat(client): 학생 신호 수집과 오프라인 큐"`

### Task 7: 학생 화면 보호와 위반 표시 [핵심]

**Files:**
- Modify: `client/src/pages/student/ExamTaking.tsx`, `client/src/pages/student/StudentFlow.tsx`, `client/src/copy/ko.ts`, `client/src/pages/student/student.module.css`
- Create: `client/src/pages/student/FullscreenGate.tsx`, `client/src/pages/student/WarningDialog.tsx`, `client/src/pages/student/ExamProtection.test.tsx`

**Interfaces:**
- Consumes: Task 6의 `useSignalCollector`, 계획 1의 `attempt:state`·`useAutosave`.
- Produces: 응시 화면이 `useSignalCollector`를 연결하고(`pasteMode`는 시험 설정에서), 전체화면이 아니면 문항을 가리는 `FullscreenGate`(P-07: [전체화면으로 돌아가기] 버튼 클릭에서 `requestFullscreen`), `PAUSED`면 문항을 가리고 "감독관이 응시를 일시정지했습니다"(자동 잠금이면 "위반이 5회 쌓여 화면이 잠겼습니다" 문구) 표시, 상단 "기록 중 · 이 시험은 화면 이탈과 붙여넣기 등을 기록합니다"와 **"위반 n/5"** 카운터, `violation:counted`·`attempt:state.violationCount` 갱신과 알림("위반 3/5: 전체화면 해제" — 관찰 사실만), `proctor:warning` 수신 시 [확인]을 눌러야 닫히는 `WarningDialog`.

- [ ] **Step 1: 실패하는 테스트** — `ExamProtection.test.tsx`: (a) 전체화면이 아닐 때 문항 영역이 보이지 않고 버튼 클릭 시 `requestFullscreen`이 호출된다, (b) `attempt:state PAUSED`면 문항이 가려지고 입력이 막힌다(`RESUME`→`ACTIVE`로 다시 보인다), (c) `violation:counted {count:3, limit:5, type:'FULLSCREEN_EXIT'}`가 오면 카운터가 "위반 3/5"로 바뀌고 알림에 "전체화면 해제"가 표시된다, (d) `proctor:warning`이 오면 대화상자가 뜨고 [확인] 전에는 닫히지 않으며 Esc로도 닫히지 않는다, (e) `BLOCK` 시험에서 붙여넣기 시도에 "이 시험에서는 붙여넣기를 할 수 없습니다" 안내가 보인다, (f) 화면 어디에도 금지어가 없고 `ko.test`의 금지어 검사가 통과한다, (g) 시험 중 정답 정보가 DOM에 없다.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 모든 문구는 `ko.ts`. 가림은 CSS 숨김이 아니라 문항 컴포넌트를 렌더하지 않는 방식(개발자 도구로 되돌리기 어렵게).
- [ ] **Step 4: 통과 확인** — PASS, client 전체 PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(client): 학생 화면 보호와 위반 표시"`

### Task 8: 감독 대시보드 화면 (S-04) [핵심]

**Files:**
- Create: `client/src/pages/staff/dashboard/StudentCard.tsx`, `DashboardCards.tsx`, `ActionBar.tsx`, `useDashboard.ts`, `dashboard.test.tsx`
- Modify: `client/src/pages/staff/ExamRunPage.tsx`(카드 목록을 운영 화면 아래에 통합), `client/src/pages/staff/staffApi.ts`(`postAction`), `client/src/copy/ko.ts`

**Interfaces:**
- Consumes: Task 1의 `AttemptSummary`·`SignalDto`, Task 4의 `dashboard:snapshot`·`attempt:updated`·`signal:new`·`network:incident`, Task 3의 `POST /api/attempts/:id/actions`.
- Produces: `useDashboard(examId: string): { exam; cards: AttemptSummary[]; pendingApprovals; networkIncident; sortBy: 'STUDENT_NO' | 'NEEDS_ATTENTION'; setSortBy; query: string; setQuery }`(스냅샷으로 시작해 변경분만 적용, 재연결 시 스냅샷 재요청), `StudentCard`(이름·학번·상태 배지(미입장·대기·응시·일시정지·잠김·제출·종료·연결 끊김·이탈 중)·"위반 n/5"·색(`NONE`·`INFO` 초록, `WARN` 노랑, `ALERT` 빨강, `PAUSED` 회색 테두리, 종착 흐리게)·최근 신호 요약·[확인] 버튼), `ActionBar`(일시정지·재개(잠긴 학생이면 "잠겨 있던 시간 n분 추가" 버튼)·시간 추가·경고 메시지·응시 종료(확인 대화상자), 사유 입력란과 빠른 선택 버튼 "현장 확인 결과 문제 없음"·"본인 요청"·"현장 확인 후 경고").

- [ ] **Step 1: 실패하는 테스트** — `dashboard.test.tsx`(소켓·API 모킹): (a) 스냅샷에 20명이 있으면 카드 20개가 이름·학번·상태와 함께 보이고 미입장도 표시된다, (b) `NEEDS_ATTENTION`에서 새 `WARN`이 생긴 카드가 맨 위로 올라온다(`attempt:updated` 수신 직후), 기본은 학번순, (c) 이름·학번 검색이 카드를 거른다, (d) 색 규칙(`WARN` 노랑 등)과 잠김(`locked`)이 빨강 + 잠금 표시, (e) [확인]이 `ACK`를 보내고 사유 입력을 요구하지 않는다, (f) 사유가 비어 있으면 일시정지·종료 버튼이 비활성이고 빠른 선택 버튼이 사유를 채운다, (g) 응시 종료는 확인 대화상자 뒤에만 API를 호출한다, (h) `networkIncident`가 있으면 상단에 "네트워크 장애 의심 (3명)" 배너, 해제(`null`)되면 사라진다, (i) 같은 이벤트가 두 번 와도(재전송) 카드가 중복되지 않는다, (j) 화면에 금지어가 없다.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 카드 정렬·검색은 클라이언트에서. 요청 중 중복 클릭 방지(`useBusy` 재사용), 409 `BUSY`는 다시 시도 안내, 모든 문구는 `ko.ts`. 승인 목록은 `pendingApprovals`의 학번·이름을 표시하도록 기존 `ExamRunPage`의 목록을 교체.
- [ ] **Step 4: 통과 확인** — PASS, client 전체 PASS, 루트 `npm run build`
- [ ] **Step 5: Commit** — `git commit -m "feat(client): 감독 대시보드 학생 카드와 조치"`

### Task 9: 학생 상세 패널 (S-05) [되면]

**Files:**
- Create: `client/src/pages/staff/dashboard/StudentPanel.tsx`, `timelineText.ts`, `studentPanel.test.tsx`
- Modify: `client/src/pages/staff/staffApi.ts`(`getTimeline`), `client/src/copy/ko.ts`

**Interfaces:**
- Consumes: Task 3의 `GET /api/attempts/:id/timeline`, Task 8의 `StudentCard`, 소켓 `signal:new`.
- Produces: `describeSignal(signal: SignalDto): string`(관찰 사실만: "다른 탭/앱으로 이동 (12초)", "전체화면 해제", "붙여넣기 340자 (차단됨)", "연결 끊김"), 카드 클릭으로 여는 패널(학생 정보·상태·남은 시간(추가 시간 포함)·타임라인·조치 기록), 열린 패널에 새 신호가 실시간으로 추가.

- [ ] **Step 1: 실패하는 테스트** — `describeSignal`의 모든 신호 타입 문구, 패널이 신호를 시간순으로 보여주고 `signal:new`가 오면 맨 아래에 추가되며, **화면에 "부정행위"·"AI 사용"·"적발" 같은 판정 표현이 없다**.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(client): 학생 상세 패널과 타임라인"`

### Task 10: 감지·대시보드 E2E [핵심]

**Files:**
- Create: `e2e/detection-flow.spec.ts`
- Modify: `e2e/playwright.config.ts`(필요 시), `docs/DEMO.md`(감지 시연 절)

**Interfaces:**
- Consumes: 계획 1의 `e2e/core-flow.spec.ts` 헬퍼, `scripts/demo-reset.ts`, Task 2·3·7·8의 화면.
- Produces: `npm run e2e`에 포함되는 시나리오.

- [ ] **Step 1: E2E 작성** — 교수자 대시보드 + 학생 2명 컨텍스트: (a) 학생1이 다른 탭으로 5초 갔다 오면 대시보드에 `LEAVE`(약 5초)가 **2초 안에** 나타나고 카드가 노랑, (b) 학생1이 전체화면을 해제하면 문항이 가려지고 `FULLSCREEN_EXIT`가 기록되고 위반 1/5, (c) `BLOCK` 시험에서 붙여넣기가 막히고 `PASTE(차단됨)`가 기록, (d) 위반 5회에서 학생1 화면이 잠기고 대시보드 카드가 빨강 + 잠금, (e) 감독관이 [재개] + "잠겨 있던 시간 추가"를 누르면 학생1이 이어서 응시하고 마감이 늘고 `RESUME`·`ADD_TIME`이 기록, (f) 감독관 경고 메시지가 **2초 안에** 학생 화면에 뜨고 [확인]으로 닫힘, (g) 대시보드를 새로고침해도 같은 카드 색·상태, (h) 두 번째 교수자 컨텍스트도 같은 신호를 2초 안에 받음, (i) 학생2는 영향 없이 계속 응시.
- [ ] **Step 2: 실행해 실패 지점 확인 후 수정** — `npm run build` 후 `npm run e2e` / Expected: 최종 PASS(통합 버그는 원인과 재현 단계를 기록하고 작은 것은 고치되 큰 것은 이슈로).
- [ ] **Step 3: Commit** — `git commit -m "test(e2e): 감지와 감독 대시보드 흐름"`

### Task 11: 실험 채택 항목 반영 [조건부]

**Files:** 실험 결과로 정한다. (예: `client/src/student/useSignalCollector.ts`, `server/src/domain/signals.ts`, `docs/SPEC.md` 5.1 표)

**Interfaces:** 사용자가 감지 실험(이슈 #6)을 수행해 `docs/STUDY.md` 2~4절의 채택 판단(10회 중 9회 이상 발생, 일상 행동 오탐 1회 이하)을 확정하면, 채택된 신호를 SPEC 5.1 표에 행으로 추가(SPEC 개정은 사용자 승인)한 뒤 이 작업에서 구현한다. `POINTER_LEAVE`(5.6)가 채택되면 `signalSeverity`·`countsAsViolation`(`durationMs ≥ 3000`)·`ClientSignalType`·수집 훅(`document mouseleave`, 1초 이상 밖에 있을 때 복귀 시 1건)·화면 가림 오버레이·E2E를 확장한다.

- [ ] **Step 1~5:** 채택 항목이 정해지면 이 작업을 위 Task와 같은 형식(실패 테스트 → 구현 → 통과 → 커밋)으로 구체화한다. 채택 항목이 없으면 이 작업은 닫고 STUDY에 근거를 남긴다.

---

## 자체 검토 (Self-Review)
- **SPEC 커버리지:** 5.1(신호 종류) → Task 2·5·6, 5.2(전송 규칙) → Task 6, 5.3(붙여넣기 모드) → Task 6·7, 5.4(카드 색·확인) → Task 2·8, 5.5(네트워크 장애) → Task 5·8, 5.7(위반·자동 잠금) → Task 1·2·3·7, F-12 → Task 6·7·10, F-13 → Task 4·8, F-14(승인 표시 보강) → Task 4·8, F-15 → Task 3·9, F-16 → Task 3·8, 7.2 이벤트 → Task 2·4·5. **제외:** 5.6(`POINTER_LEAVE`, 실험 후 Task 11), F-20(일정상 제외, 한계로 기록).
- **타입 일관성:** `AttemptSummary`·`SignalDto`는 Task 1에서만 정의하고 Task 3·4·8·9가 그대로 쓴다. `broadcast.attemptUpdated`는 Task 4에서 만들고 Task 2·3·5가 호출한다. `recordServerSignal`은 Task 2에서 만들고 Task 5가 호출한다.
- **PR 충돌 예상:** `broadcast.ts`(Task 2·3·4), `socket.ts`(Task 0·2·4·5), `ko.ts`(Task 7·8·9), `shared/src/index.ts`(Task 1만)는 Coordinator가 병합 때 해결한다.
