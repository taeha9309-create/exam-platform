# 계획 1: 핵심 시험 흐름 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교수자가 시험을 만들고 입장을 열고 시작하면, 학생이 학번+비밀번호로 들어와 대기실을 거쳐 응시·자동 저장·제출하고 설문을 남기며, 교수자가 채점·결과·설문을 보는 전 과정을 배포 URL에서 동작시킨다. (행동 감지·대시보드·조치는 계획 2)

**Architecture:** npm workspaces 모노레포(`shared`, `server`, `client`). 서버는 Express(REST) + Socket.IO(실시간) + Prisma(PostgreSQL). 상태 전이·마감 계산·섞기·CSV 파싱·채점은 DB와 무관한 순수 함수(`server/src/domain/`)로 두고 단위 테스트한다. 라우트는 서비스 함수를 호출하고, 실시간 알림은 `server/src/realtime/broadcast.ts`로만 보낸다. 운영 환경에서는 서버가 빌드된 React 정적 파일을 같은 도메인으로 제공한다.

**Tech Stack:** Node 24, TypeScript 5, Express 4, Socket.IO 4, Prisma 6 + PostgreSQL 16(로컬은 Docker), zod, bcryptjs, jsonwebtoken, cookie-parser, express-rate-limit, React 18 + Vite + React Router 6, socket.io-client, Vitest, supertest, Playwright.

**Spec:** `docs/SPEC.md` v1.4 · ADR-001~008 (`docs/DECISIONS.md`) — 1장, 2장, 3장, 4장, 6장(F-01~F-11, F-14 승인 API, F-17, F-18, F-19 일부), 7장 / `docs/PRD.md` v1.3

## Global Constraints
- 저장은 UTC, 화면 표시는 Asia/Seoul.
- 모든 화면 문구는 `client/src/copy/ko.ts` 한 파일에서만 정의(성공 기준 6). 금지어: "부정행위", "AI 사용", "적발", "커닝".
- 오류 응답 형식: `{ error: { code: string, message: string } }`.
- 교수자 인증: httpOnly·Secure(운영)·SameSite=Lax 쿠키 `staff_token`(JWT, 12시간). **모든 교수자 계정이 모든 시험에 접근**(D-016).
- 학생 인증: `Authorization: Bearer {sessionToken}`, 서버는 SHA-256 해시만 저장. 클라이언트 보관 키 `exam:{examCode}:token`(localStorage).
- 시험 비밀번호 6자리 숫자, `examCode` 8자리 영숫자(혼동 문자 0/O/1/I/L 제외).
- 입장 실패 레이트 리밋: 같은 IP 1분 10회 초과 시 429.
- 학생에게 `correctChoiceId`를 절대 보내지 않는다.
- 일시정지 중에도 시간은 흐른다(D-014). 학생 마감 = `exam.endsAt + attempt.extraSeconds`.
- 답안: 서술형 최대 5000자, `rev`가 저장값보다 작으면 무시.
- 지원 브라우저 Chrome·Edge(`navigator.userAgentData.brands`).

## Review Focus
1. **두 교수자가 거의 동시에 [시험 시작]을 누름** → 한 번만 시작되고 두 번째는 409 (`endsAt`이 두 번 바뀌면 안 됨). → Task 7 테스트.
2. **Excel에서 저장한 명단 CSV(UTF-8 BOM, CRLF, 끝 빈 줄)** → 정상 파싱. → Task 5 테스트.
3. **학생이 시험 시작 직후 새로고침하거나 재연결** → 소켓 연결 즉시 현재 `attempt:state`를 받아 올바른 화면으로 간다(대기실에 갇히지 않음). → Task 10 테스트.
4. **학생 PC 시계가 몇 분 틀어짐** → 남은 시간은 `serverNow` 오프셋 기준이라 다른 학생과 ±1초. → Task 15 테스트.
5. **마감 직후 도착한 자동 저장** → `SUBMITTED` 이후 저장은 거부되고, 마감 전에 저장된 답은 채점에 반영. → Task 11 테스트.

---

### Task 1: 모노레포 뼈대와 개발 환경

**Files:**
- Create: `package.json`(workspaces: `shared`, `server`, `client`), `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`(postgres:16, 포트 5432, DB `exam` + `exam_test`), `shared/package.json`, `shared/src/index.ts`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/test/health.test.ts`, `client/`(Vite React TS 템플릿), `client/src/copy/ko.ts`, `README.md`
- Modify: 없음

**Interfaces:**
- Produces:
  - `shared`: `ExamStatus = 'DRAFT'|'OPEN'|'RUNNING'|'ENDED'`, `AttemptState = 'WAITING'|'PENDING_APPROVAL'|'ACTIVE'|'PAUSED'|'SUBMITTED'|'TERMINATED'|'REJECTED'`, `SubmitReason = 'STUDENT'|'TIMEOUT'|'EXAM_ENDED'`, `Severity = 'NONE'|'INFO'|'WARN'|'ALERT'`, `PasteMode = 'RECORD'|'BLOCK'`, `ProctorActionType`(SPEC F-14·F-16의 모든 type + `AUTO_PAUSE`), 상수 `VIOLATION_LIMIT = 5`, `HEARTBEAT_MS = 5000`, `AUTOSAVE_MAX_INTERVAL_MS = 5000`, 이벤트 이름 객체 `EV`(SPEC 7.2의 모든 이벤트 이름).
  - `server`: `createApp(): express.Express`, `GET /api/health → { ok: true }`.
  - 루트 스크립트: `npm run dev`(server+client 동시), `npm test`(server·client 테스트), `npm run db:up`(`docker compose up -d`).

- [ ] **Step 1: 실패하는 테스트** — `server/test/health.test.ts`: `request(createApp()).get('/api/health')` → status 200, body `{ ok: true }`.
- [ ] **Step 2: 실패 확인** — Run: `npm test -w server` / Expected: FAIL(`createApp` 없음)
- [ ] **Step 3: 뼈대 구현** — 위 파일 생성, `createApp`에 `express.json({ limit: '1mb' })`, `cookie-parser`, `/api/health`. `ko.ts`는 `export const t = { appName: '시험 무결성 플랫폼' } as const`로 시작.
- [ ] **Step 4: 통과 확인** — `npm test -w server` PASS, `npm run dev`로 `http://localhost:5173`에 Vite 기본 화면이 뜨고 `/api/health`가 프록시로 200.
- [ ] **Step 5: Commit** — `git commit -m "chore: 모노레포 뼈대"`

### Task 2: DB 스키마와 테스트 DB 도우미

**Files:**
- Create: `server/prisma/schema.prisma`, `server/src/db.ts`, `server/test/helpers/db.ts`, `server/test/schema.test.ts`

**Interfaces:**
- Produces:
  - Prisma 모델: SPEC 4장의 **모든** 모델·필드(Staff, Exam, Question, RosterEntry, Attempt, Answer, Signal, ProctorAction, SurveyResponse). 열거형은 shared 타입과 같은 값. `Exam` 삭제 시 하위 데이터 cascade.
  - `prisma: PrismaClient`(`server/src/db.ts`)
  - `resetDb(): Promise<void>` — 모든 테이블 TRUNCATE … CASCADE.
  - `makeStaff(overrides?): Promise<Staff>`, `makeExam(overrides?): Promise<Exam>`(DRAFT, 문항 MCQ 1 + ESSAY 1, 명단 3명 `20260001`~`20260003`).

- [ ] **Step 1: 실패하는 테스트** — `schema.test.ts`: `makeExam()` 후 `prisma.exam.delete` → 해당 시험의 Question·RosterEntry 개수 0.
- [ ] **Step 2: 실패 확인** — `npm run db:up && npm test -w server` / FAIL
- [ ] **Step 3: 스키마 작성, `npx prisma migrate dev --name init`, 테스트용 `DATABASE_URL`을 `exam_test`로 쓰도록 vitest `globalSetup`에서 `prisma migrate deploy` 실행. 테스트 파일은 순차 실행(`fileParallelism: false`).**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(db): Prisma 스키마"`

### Task 3: 순수 도메인 함수 — 상태 전이, 마감, 섞기, 코드 생성

**Files:**
- Create: `server/src/domain/attemptMachine.ts`, `server/src/domain/deadline.ts`, `server/src/domain/shuffle.ts`, `server/src/domain/codes.ts`, `server/test/domain/*.test.ts`

**Interfaces:**
- Produces:
  - `type AttemptEvent = 'EXAM_START' | 'READY' | 'APPROVE' | 'REJECT' | 'PAUSE' | 'RESUME' | 'SUBMIT' | 'TIMEOUT' | 'EXAM_END' | 'TERMINATE'`
  - `nextState(current: AttemptState, event: AttemptEvent, ctx: { ready: boolean; examRunning: boolean }): AttemptState` — 허용되지 않은 전이는 `InvalidTransitionError`(code `INVALID_TRANSITION`).
  - `attemptDeadline(endsAt: Date, extraSeconds: number): Date`, `remainingMs(deadline: Date, now: Date): number`(음수면 0).
  - `buildOrders(questions: {id: string; type: 'MCQ'|'ESSAY'; choices: {id: string}[] | null}[], shuffle: boolean, rng?: () => number): { questionOrder: string[]; choiceOrders: Record<string, string[]> }`
  - `generateExamCode(): string`(8자, 알파벳 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`), `generatePasscode(): string`(6자리 숫자, 앞자리 0 허용).

- [ ] **Step 1: 실패하는 테스트 (표 기반)**
  - `nextState`: SPEC 2.2 표의 모든 행. 예) `('WAITING','EXAM_START',{ready:true,examRunning:true}) → 'ACTIVE'`, `('WAITING','EXAM_START',{ready:false,…}) → 'WAITING'`, `('WAITING','READY',{ready:true,examRunning:true}) → 'ACTIVE'`, `('WAITING','READY',{ready:true,examRunning:false}) → 'WAITING'`, `('PENDING_APPROVAL','APPROVE',…) → 'WAITING'`, `('PENDING_APPROVAL','REJECT',…) → 'REJECTED'`, `('ACTIVE','PAUSE') → 'PAUSED'`, `('PAUSED','TIMEOUT') → 'SUBMITTED'`, `('WAITING','EXAM_END') → 'SUBMITTED'`, `('PENDING_APPROVAL','EXAM_END') → 'REJECTED'`, `('PAUSED','TERMINATE') → 'TERMINATED'`; `('SUBMITTED','RESUME')`, `('WAITING','PAUSE')`, `('REJECTED','APPROVE')`는 `InvalidTransitionError`.
  - `attemptDeadline(new Date('2026-12-01T01:00:00Z'), 600)` → `2026-12-01T01:10:00Z`; `remainingMs`는 지난 마감에 0.
  - `buildOrders`: `shuffle=false`면 입력 순서 그대로, `shuffle=true` + 고정 rng(`() => 0`)는 결정적 결과, 모든 id가 빠짐없이 한 번씩, ESSAY는 `choiceOrders`에 없음.
  - `generateExamCode()` 1000회가 모두 `/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/`, `generatePasscode()`가 `/^\d{6}$/`.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 섞기는 Fisher–Yates, 코드 생성은 `crypto.randomInt`.
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(domain): 응시 상태 전이·마감·섞기·코드"`

### Task 4: 교수자 인증 (F-01)

**Files:**
- Create: `server/src/auth/staffAuth.ts`, `server/src/routes/staff.ts`, `scripts/create-staff.ts`, `server/test/staff.test.ts`
- Modify: `server/src/app.ts`(라우터 연결)

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw, hash): Promise<boolean>`(bcryptjs, cost 10)
  - `signStaffToken(staffId: string): string`, `verifyStaffToken(token: string): { staffId: string } | null`(환경변수 `JWT_SECRET`)
  - `requireStaff: RequestHandler` — 성공 시 `req.staff = { id, name, email }`, 실패 시 401 `{error:{code:'UNAUTHORIZED'}}`
  - `POST /api/staff/login {email, password}` → 200 `{ staff }` + 쿠키, 실패 401 `INVALID_CREDENTIALS`(메시지는 ko.ts가 아닌 서버 코드로만; 화면 문구는 클라이언트가 code로 매핑)
  - `POST /api/staff/logout`, `GET /api/staff/me`
  - `npm run create-staff -- --email a@b.c --name 김교수 --password ****`

- [ ] **Step 1: 실패하는 테스트** — 올바른 로그인 200 + `set-cookie`에 `staff_token`·`HttpOnly`; 틀린 비밀번호 401 `INVALID_CREDENTIALS`; 쿠키 없이 `/api/staff/me` 401; 로그인 쿠키로 `/api/staff/me` 200 `{ staff: { email } }`; 학생 Bearer 토큰만으로 `/api/staff/me` 401.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): 교수자 로그인"`

### Task 5: 시험·문항·명단·설정 API (F-02~F-05)

**Files:**
- Create: `server/src/domain/roster.ts`, `server/src/domain/questions.ts`, `server/src/routes/exams.ts`, `server/test/domain/roster.test.ts`, `server/test/exams.test.ts`

**Interfaces:**
- Produces:
  - `parseRosterCsv(csv: string): { ok: true; entries: { studentNo: string; name: string }[] } | { ok: false; errors: { line: number; code: 'DUPLICATE' | 'EMPTY' | 'FORMAT'; message: string }[] }` — BOM 제거, CRLF/LF 모두, 빈 줄 무시, 첫 줄이 `학번`으로 시작하면 헤더로 건너뜀, 값 양끝 공백 제거.
  - `questionsInputSchema`(zod): 배열, 각 항목 `{ type, prompt(1~5000자), points(int ≥1), choices?, correctChoiceId? }`. MCQ: choices 2~6개(`{id, text}`), `correctChoiceId`가 choices 중 하나. 오류는 `{ index, field, code }[]`로 반환.
  - 라우트(SPEC 7.1): `GET/POST /api/exams`, `GET/PATCH/DELETE /api/exams/:id`, `PUT /api/exams/:id/questions`, `PUT /api/exams/:id/roster { csv }`. `PATCH`는 `{ title?, instructions?, durationMin?, pasteMode?, shuffle?, lockNewEntry? }`.
  - 상태 제약: 문항·명단 수정은 `DRAFT`만(아니면 409 `NOT_DRAFT`), 설정(`pasteMode`, `shuffle`, 기본정보) 수정은 `RUNNING` 전까지(아니면 409 `ALREADY_STARTED`), **`lockNewEntry`만은 `OPEN`·`RUNNING`에서도 변경 가능**(F-06 [신규 입장 차단]), 삭제는 `DRAFT`/`ENDED`만(아니면 409).
  - 목록 응답 항목: `{ id, title, status, ownerName, rosterCount, attemptCount, createdAt }`.

- [ ] **Step 1: 실패하는 테스트**
  - roster: `'﻿학번,이름\r\n20260001,김철수\r\n20260002,이영희\r\n\r\n'` → ok, 2명; `'20260001,김\n20260001,이'` → errors `[{ line: 2, code: 'DUPLICATE' }]`; `'20260001,'` → `[{ line: 1, code: 'EMPTY' }]`.
  - exams: 생성 시 `status: 'DRAFT'`, `examCode` 8자; 다른 교수자 계정으로도 목록에 보임(D-016); MCQ 보기 1개 → 400, 오류에 `{ index: 0, field: 'choices' }`; 문항 순서 바꿔 저장 후 `GET`이 같은 순서; `OPEN` 시험에 문항 `PUT` → 409 `NOT_DRAFT`; `RUNNING` 시험 `DELETE` → 409; `RUNNING` 시험에 `PATCH { lockNewEntry: true }` → 200, `PATCH { shuffle: false }` → 409; 명단 20줄 CSV → `rosterCount: 20`.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 문항 저장은 트랜잭션으로 기존 문항 삭제 후 `position` 순으로 재생성.
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(exams): 시험·문항·명단·설정 API"`

### Task 6: 실시간 기반 — Socket.IO 인증·방·broadcast

**Files:**
- Create: `server/src/realtime/socket.ts`, `server/src/realtime/broadcast.ts`, `server/test/helpers/server.ts`, `server/test/realtime.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Produces:
  - `attachSocket(httpServer: http.Server): Server` — 연결 인증: 교수자는 쿠키 `staff_token`, 학생은 `handshake.auth.sessionToken`. 학생은 `attempt:{attemptId}`, `exam:{examId}:students` 방에 자동 입장, 연결 직후 `attempt:state` 1회 송신. 교수자는 `dashboard:join { examId }`로 `exam:{examId}:staff` 입장(ack는 계획 2에서 스냅샷으로 확장; 지금은 `{ ok: true }`).
  - `getIo(): Server`(index에서 설정한 싱글턴), `broadcast.attemptState(attempt: Attempt, exam: Exam): void`(학생 방에 `{ state, deadline, serverNow, extraSeconds, violationCount }`), `broadcast.waitingCount(examId: string): Promise<void>`(`{ ready, total }`를 학생 방과 교수자 방에), `broadcast.examStarted(exam)`, `broadcast.sessionRevoked(attemptId)`, `broadcast.toStaff(examId, event, payload)`.
  - 테스트 도우미 `startTestServer(): Promise<{ url: string; close(): Promise<void> }>`.

- [ ] **Step 1: 실패하는 테스트** — 토큰 없는 학생 소켓은 `connect_error`; 유효한 학생 토큰으로 연결하면 즉시 `attempt:state`(state `WAITING`) 수신; 교수자 쿠키로 `dashboard:join` 후 `broadcast.toStaff`가 보낸 이벤트 수신.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** (학생 토큰 검증은 Task 8의 `findAttemptByToken`이 필요하므로, 이 태스크에서 `server/src/auth/studentSession.ts`의 `generateToken()`, `hashToken(t)`, `findAttemptByToken(t)`를 먼저 만든다)
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(realtime): 소켓 인증과 방"`

### Task 7: 시험 운영 API — 입장 열기·비밀번호·시작·종료 (F-06)

**Files:**
- Create: `server/src/services/examLifecycle.ts`, `server/test/lifecycle.test.ts`
- Modify: `server/src/routes/exams.ts`

**Interfaces:**
- Consumes: Task 3 `nextState`, `generatePasscode`; Task 6 `broadcast`.
- Produces:
  - `openExam(examId): Promise<Exam>` — `DRAFT`→`OPEN`, 문항 ≥1·명단 ≥1 아니면 409 `NOT_READY_TO_OPEN`, passcode 생성.
  - `regeneratePasscode(examId): Promise<string>` — `OPEN`/`RUNNING`만.
  - `startExam(examId, now = new Date()): Promise<Exam>` — **조건부 업데이트**(`where: { id, status: 'OPEN' }`)로 원자적 전이, 0건이면 409 `ALREADY_STARTED`. `startedAt=now`, `endsAt=now+durationMin`. 준비 완료(`consentAt && envCheckedAt`) `WAITING` 응시를 `EXAM_START`로 `ACTIVE`, 각각 `broadcast.attemptState`, 그리고 `broadcast.examStarted`.
  - `endExam(examId, now = new Date()): Promise<Exam>` — `RUNNING`→`ENDED`, `endedAt=now`, 비종착 응시는 `EXAM_END` 전이(제출 처리는 Task 11의 `submitAttempt(id, 'EXAM_ENDED')` 사용 — 이 태스크에서는 상태 전이·`submittedAt`·`submitReason`만 기록하고, Task 11에서 채점 호출을 추가).
  - 라우트: `POST /api/exams/:id/open|passcode|start|end`.

- [ ] **Step 1: 실패하는 테스트** — 문항 없는 시험 open → 409 `NOT_READY_TO_OPEN`; open 후 `passcode`가 6자리; 재발급하면 값이 바뀌고 **이전 비밀번호로 `/api/student/entry` → 401, 재발급 전에 입장한 학생의 `/api/student/attempt`는 200**(F-06 AC, G2; Task 8 완료 전까지 `it.todo`로 두고 Task 8에서 활성화); **`Promise.all([start, start])` → 하나는 200, 하나는 409 `ALREADY_STARTED`, `endsAt`은 한 번만 설정**(Review Focus 1); start 시 준비 완료 WAITING은 ACTIVE, 미준비는 WAITING 유지; end 후 ACTIVE 응시가 `SUBMITTED`/`EXAM_ENDED`, PENDING_APPROVAL은 `REJECTED`.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(lifecycle): 입장 열기·시작·종료"`

### Task 8: 학생 입장·본인 확인·세션·승인 (F-07, F-10 일부, F-14 API)

**Files:**
- Create: `server/src/routes/student.ts`, `server/src/routes/attempts.ts`, `server/src/services/entry.ts`, `server/test/entry.test.ts`

**Interfaces:**
- Consumes: Task 3 `buildOrders`, `nextState`; Task 6 `generateToken`, `hashToken`, `findAttemptByToken`, `broadcast`.
- Produces:
  - `GET /api/public/exams/:examCode` → `{ title, status }`
  - `POST /api/student/entry { examCode, studentNo, passcode }` → `{ name }`. 실패 401 `ENTRY_FAILED`(사유 구분 없음), `DRAFT`/`ENDED`는 403 `EXAM_NOT_ENTERABLE`. 실패만 카운트하는 레이트 리밋(IP당 1분 10회, 초과 429 `TOO_MANY_ATTEMPTS`).
  - `POST /api/student/confirm { examCode, studentNo, passcode, sessionToken? }` →
    - 응시 없음 + `OPEN` → 응시 생성(`WAITING`, `buildOrders` 결과 저장) → `{ sessionToken, attempt }`
    - 응시 없음 + `RUNNING` + `lockNewEntry=false` → `PENDING_APPROVAL`, `isLate=true`, `broadcast.toStaff(examId,'approval:pending',{attemptId,kind:'LATE'})`
    - 응시 없음 + `RUNNING` + `lockNewEntry=true` → 403 `ENTRY_CLOSED`
    - 응시 있음 + 같은 토큰 → `{ sessionToken, attempt }`(이어하기)
    - 응시 있음 + 다른/없는 토큰 → `pendingTokenHash` 저장, `{ status: 'DUPLICATE_PENDING', pendingToken }`, `approval:pending {kind:'DUPLICATE'}`
  - `GET /api/student/attempt` → `{ state, deadline, serverNow, extraSeconds, violationCount, needs: { consent: boolean, env: boolean } }`
  - `POST /api/attempts/:id/actions { type, reason, payload }` — 이 태스크에서는 `APPROVE_ENTRY`·`REJECT_ENTRY`·`APPROVE_SESSION`·`REJECT_SESSION`만 처리(그 외 400 `UNSUPPORTED_ACTION`, 계획 2에서 확장). `reason` 비어 있으면 400. 모두 `ProctorAction` 기록 + `approval:resolved`.
    - `APPROVE_SESSION`: `sessionTokenHash ← pendingTokenHash`, `pendingTokenHash=null`, 기존 소켓에 `session:revoked` 후 강제 연결 종료. 대기 중 클라이언트는 `pendingToken`으로 `/api/student/confirm`을 다시 호출해 세션을 받는다(폴링 2초).
  - 학생 소켓 인증은 `pendingToken`을 받지 않는다.

- [ ] **Step 1: 실패하는 테스트** — 명단 밖 학번 401 `ENTRY_FAILED`; 틀린 비밀번호도 같은 401; 1분 11번째 실패 429; OPEN에서 confirm → WAITING + 토큰; 같은 토큰으로 confirm → 같은 attemptId; 다른 토큰 → `DUPLICATE_PENDING`; `APPROVE_SESSION` 후 기존 토큰으로 `/api/student/attempt` 401, pendingToken으로 confirm → 200 같은 attemptId; RUNNING 중 confirm → PENDING_APPROVAL, `APPROVE_ENTRY` 후 WAITING; `lockNewEntry` 켜짐 → 403 `ENTRY_CLOSED`; 사유 없는 승인 400; `/api/student/attempt` 응답에 `correctChoiceId` 문자열이 없음.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(entry): 학생 입장·세션·승인"`

### Task 9: 동의·환경 점검·준비 완료 (F-08, F-09, F-10)

**Files:**
- Create: `server/test/readiness.test.ts`
- Modify: `server/src/routes/student.ts`, `server/src/services/entry.ts`

**Interfaces:**
- Produces:
  - `POST /api/student/consent { agree: boolean }` — true면 `consentAt=now`, `consentDeclined=false`; false면 `consentDeclined=true`. 교수자 방에 `attempt:updated`(계획 2가 페이로드를 확정; 지금은 `{ attemptId }`).
  - `POST /api/student/env { browser: 'chrome'|'edge', isExtended: boolean, fullscreen: true }` — 동의 전이면 409 `CONSENT_REQUIRED`. `envBrowser`, `envIsExtended`, `envCheckedAt` 저장. `isExtended=true`면 `Signal { type: 'MULTI_MONITOR', severity: 'WARN' }` 저장.
  - 준비 완료가 된 순간: 시험이 `RUNNING`이고 상태가 `WAITING`이면 `READY` 전이로 `ACTIVE` + `broadcast.attemptState`. 그 외엔 `broadcast.waitingCount(examId)`.

- [ ] **Step 1: 실패하는 테스트** — 동의 없이 env → 409; 동의 거부 → `consentDeclined=true`; env에 `isExtended:true` → MULTI_MONITOR 신호 1건; OPEN에서 준비 완료 → `waiting:count`의 `ready`가 1 증가(소켓으로 수신); RUNNING 중 승인된 지각생이 준비 완료 → ACTIVE.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(entry): 동의·환경 점검·준비 완료"`

### Task 10: 재연결 시 현재 상태 동기화

**Files:**
- Modify: `server/src/realtime/socket.ts`
- Test: `server/test/realtime.test.ts`

**Interfaces:**
- Consumes: Task 6, Task 7.
- Produces: 학생 소켓 연결 시 송신하는 `attempt:state`가 DB 최신 상태(시작 직후면 `ACTIVE`와 `deadline`)를 담는다. 상태가 `WAITING`이면 `waiting:count`도 함께 송신.

- [ ] **Step 1: 실패하는 테스트 (Review Focus 3)** — 학생 소켓 연결 → 연결 끊기 → `startExam` → 다시 연결 → 첫 `attempt:state.state === 'ACTIVE'`이고 `deadline`이 `endsAt`과 같음.
- [ ] **Step 2: 실패 확인** — FAIL(또는 이미 통과하면 테스트만 유지)
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(realtime): 재연결 상태 동기화"`

### Task 11: 응시·자동 저장·제출·마감 처리 (F-11 서버)

**Files:**
- Create: `server/src/domain/grading.ts`, `server/src/services/submission.ts`, `server/src/jobs/deadlineTicker.ts`, `server/test/domain/grading.test.ts`, `server/test/taking.test.ts`
- Modify: `server/src/realtime/socket.ts`(`answer:save`), `server/src/routes/student.ts`, `server/src/services/examLifecycle.ts`(`endExam`이 `submitAttempt` 사용), `server/src/index.ts`(티커 시작)

**Interfaces:**
- Produces:
  - `gradeMcq(q: { points: number; correctChoiceId: string }, choiceId: string | null): number`
  - `GET /api/student/exam`(상태 `ACTIVE`만, 아니면 403 `NOT_ACTIVE`) → `{ questions: { id, type, prompt, points, choices?: {id,text}[] }[] (questionOrder·choiceOrders 순), answers: { questionId, choiceId?, text?, rev, savedAt }[] }`
  - 소켓 `answer:save { questionId, choiceId?, text?, rev }` → ack `{ ok: true, savedAt }` 또는 `{ ok: false, code: 'NOT_ACTIVE' | 'STALE_REV' | 'TOO_LONG' | 'INVALID' }`. `PAUSED`·종착 상태는 `NOT_ACTIVE`. 학생 마감이 지났으면 `NOT_ACTIVE`.
  - `submitAttempt(attemptId: string, reason: SubmitReason, now = new Date()): Promise<Attempt>` — 상태 전이(`SUBMIT`/`TIMEOUT`/`EXAM_END`), `submittedAt`, `submitReason`, MCQ 답안의 `awardedPoints = gradeMcq(...)`, `broadcast.attemptState`. 이미 종착이면 그대로 반환(멱등).
  - `POST /api/student/submit` → `submitAttempt(id, 'STUDENT')`
  - `tickDeadlines(now: Date): Promise<number>` — 마감이 지난 `ACTIVE`/`PAUSED`를 `TIMEOUT`으로 제출, 처리 수 반환. 또 모든 응시가 종착이고 `now > endsAt`인 `RUNNING` 시험을 `ENDED`로. `index.ts`에서 1초 `setInterval`.

- [ ] **Step 1: 실패하는 테스트**
  - grading: 정답 → points, 오답·null → 0.
  - taking: `ACTIVE` 아닌 응시의 `/api/student/exam` 403; 응답에 `correctChoiceId` 없음; shuffle 켜진 시험에서 두 학생의 `questionOrder`가 저장값대로 반환; `rev: 2` 저장 후 `rev: 1` → `STALE_REV`이고 값 유지; 5001자 → `TOO_LONG`; `PAUSED` 상태 저장 → `NOT_ACTIVE`; 제출 시 MCQ 정답 문항 `awardedPoints`=배점; **마감 1초 전 저장 → 성공, `tickDeadlines(마감+1초)` 후 저장 → `NOT_ACTIVE`, 제출된 답은 마감 전 값**(Review Focus 5); `submitAttempt` 두 번 호출해도 `submittedAt` 불변.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(taking): 응시·자동 저장·제출·마감"`

### Task 12: 채점·결과·설문 API (F-17, F-18)

**Files:**
- Create: `server/src/routes/results.ts`, `server/test/results.test.ts`, `server/test/survey.test.ts`
- Modify: `server/src/routes/student.ts`

**Interfaces:**
- Produces:
  - `GET /api/exams/:id/results` → `{ questions: {id, type, points, position}[], rows: { attemptId, studentNo, name, state, mcqScore, essayScore: number | null, total: number | null, signalCounts: { INFO: number; WARN: number; ALERT: number }, actionCount: number, answers: { answerId, questionId, choiceId?, text?, awardedPoints }[] }[] }` — 서술형이 하나라도 미채점이면 `essayScore`·`total`은 null.
  - `PUT /api/answers/:id/grade { points }` — 서술형만, `0 ≤ points ≤ question.points` 정수, 아니면 400.
  - `POST /api/student/survey { difficulty?: 1..5, comment?: string(≤1000) }` — 상태가 `SUBMITTED`/`TERMINATED`만(아니면 409), `surveyDone=true`면 409 `ALREADY_SUBMITTED`. `SurveyResponse`에는 `examId, difficulty, comment`만 저장. 둘 다 비어 있으면 응답은 만들지 않고 `surveyDone`만 true(건너뛰기).
  - `GET /api/exams/:id/survey` → `{ count, distribution: [n1..n5], average: number | null, comments: string[] }` — comments는 요청마다 무작위 순서.

- [ ] **Step 1: 실패하는 테스트** — 설문 요약을 `buildSurveySummary(rows, shuffle: <T>(xs: T[]) => T[])`로 분리하고 역순 함수를 주입하면 `comments`가 역순(F-18 AC, G4); 서술형 미채점 시 total null, 채점 후 total = MCQ + 서술형; 배점 초과 400; MCQ 답안 grade 요청 400; 설문 두 번째 제출 409; `SurveyResponse` 행의 컬럼 목록에 attempt·student·시각 관련 컬럼이 없음(Prisma DMMF로 검사); 응답 3개(난이도 2,4,4) → distribution `[0,1,0,2,0]`, average `3.33`(소수 둘째 자리).
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(results): 채점·결과·설문 API"`

### Task 13: 클라이언트 공통 — API·소켓·문구·라우팅

**Files:**
- Create: `client/src/api.ts`, `client/src/socket.ts`, `client/src/copy/ko.ts`(확장), `client/src/router.tsx`, `client/src/copy/ko.test.ts`
- Modify: `client/src/main.tsx`, `client/vite.config.ts`(`/api`·`/socket.io` 프록시)

**Interfaces:**
- Produces:
  - `api<T>(method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path: string, body?: unknown, opts?: { token?: string }): Promise<T>` — 오류 시 `ApiError { status, code }` throw.
  - `connectStudentSocket(token: string): Socket`, `connectStaffSocket(): Socket`
  - `t`: 모든 화면 문구, `errorText(code: string): string`(서버 오류 코드 → 한국어 문구)
  - 라우트: `/staff/login`, `/staff/exams`, `/staff/exams/:id/edit`, `/staff/exams/:id/run`, `/staff/exams/:id/results`, `/staff/exams/:id/survey`, `/e/:examCode`(학생 흐름 하나의 컨테이너)
- [ ] **Step 1: 실패하는 테스트** — `ko.test.ts`: `JSON.stringify(t)`에 금지어 4개가 없음; `errorText`가 Task 4~12의 모든 오류 코드에 대해 빈 문자열이 아님(코드 목록은 `shared`에 `ERROR_CODES` 배열로 추가).
- [ ] **Step 2: 실패 확인** — `npm test -w client` / FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(client): API·소켓·문구 기반"`

### Task 14: 교수자 화면 (S-01, S-02, S-03, 운영 화면, S-06, S-07)

**Files:**
- Create: `client/src/pages/staff/LoginPage.tsx`, `ExamListPage.tsx`, `ExamEditPage.tsx`(탭: 기본정보·문항·명단·설정), `ExamRunPage.tsx`, `ResultsPage.tsx`, `SurveyPage.tsx`, `client/src/pages/staff/*.test.tsx`

**Interfaces:**
- Consumes: Task 13.
- Produces: `ExamRunPage`는 계획 2에서 대시보드로 확장할 자리. 이번 범위: 상태, 남은 시간, [입장 열기]·비밀번호 크게 보기(전체 화면 오버레이)·[재발급]·[시험 시작]·[시험 종료](확인 대화상자)·[신규 입장 차단] 토글, 입장 현황 `ready/total`(`waiting:count`), 승인 요청 목록(지각·중복, [승인]/[거절] + 사유 빠른 선택 "현장 확인 완료").
- [ ] **Step 1: 실패하는 테스트 (React Testing Library, api 모킹)** — 문항 편집에서 MCQ 보기 1개로 저장하면 서버 오류(`index 0, choices`)가 그 문항 아래 표시; 명단 CSV 오류가 "2번째 줄" 문구로 표시; 문항 없는 시험은 [입장 열기] 비활성 + 이유 표시; 시험 목록에서 `RUNNING` 시험의 [삭제] 버튼 비활성(F-02 AC, G5); 결과 화면에서 서술형 점수 입력란에 배점 초과 입력 시 저장 버튼 비활성.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 스타일은 단순한 CSS 모듈, 외부 UI 라이브러리 없이.
- [ ] **Step 4: 통과 확인** — PASS, `npm run dev`에서 로그인→시험 생성→문항·명단 입력→입장 열기까지 수동 확인
- [ ] **Step 5: Commit** — `git commit -m "feat(client): 교수자 화면"`

### Task 15: 학생 화면 (P-01~P-06, P-08, P-09)

**Files:**
- Create: `client/src/pages/student/StudentFlow.tsx`(상태 기반 화면 전환), `EntryStep.tsx`, `ConfirmStep.tsx`, `ConsentStep.tsx`, `EnvCheckStep.tsx`, `WaitingRoom.tsx`, `PendingApproval.tsx`, `ExamTaking.tsx`, `SubmittedSurvey.tsx`, `Notice.tsx`, `client/src/student/session.ts`, `client/src/student/serverClock.ts`, `client/src/student/useAutosave.ts`, `client/src/student/browserCheck.ts`, 각 `*.test.ts(x)`

**Interfaces:**
- Consumes: Task 13, 서버 Task 8~12.
- Produces:
  - `session.get(examCode): string | null`, `session.set(examCode, token)`, `session.clear(examCode)` (키 `exam:{examCode}:token`)
  - `createServerClock(serverNow: number, receivedAt = Date.now()): { now(): number }` — 오프셋 = `serverNow - receivedAt`.
  - `useAutosave(socket, questionId, value, rev)` — 변경 후 1초 디바운스 + 미저장분 5초 강제 전송, 미저장 값은 `localStorage` `exam:{examCode}:draft:{questionId}`에 보관, 재연결 시 재전송, ack의 `savedAt` 반환. `compositionend` 전에는 디바운스 타이머만 재설정.
  - `detectBrowser(brands: {brand: string}[] | undefined): 'chrome' | 'edge' | 'unsupported'`
  - 화면 전환 규칙: `attempt:state`와 `needs`로 결정 — needs.consent → ConsentStep, needs.env → EnvCheckStep, WAITING → WaitingRoom, PENDING_APPROVAL → PendingApproval, ACTIVE → ExamTaking, PAUSED → ExamTaking 위 잠금 안내(상세 오버레이는 계획 2), SUBMITTED/TERMINATED → SubmittedSurvey(`surveyDone`이면 완료 안내), REJECTED·`session:revoked`·ENTRY_CLOSED → Notice.
  - ExamTaking: 문항 목록(답안 여부), 자유 이동, 남은 시간(`createServerClock`), "저장됨 HH:mm:ss", 상단 "기록 중" 바(위반 카운터 자리는 계획 2), [제출](미응답 수 확인 대화상자).
- [ ] **Step 1: 실패하는 테스트**
  - `createServerClock`: 학생 시계가 +5분 틀려도(`receivedAt`을 5분 뒤로) `now()`가 서버 기준 값(Review Focus 4).
  - `useAutosave`(fake timers): 입력 후 1초에 전송 1회; 계속 입력해도 5초 안에 최소 1회 전송; 소켓 끊긴 동안 입력 → 재연결 시 최신 값 1회 전송; `compositionstart`~`end` 사이에는 전송 안 함, `end` 후 1초에 전송.
  - `detectBrowser`: `[{brand:'Google Chrome'}]`→chrome, `[{brand:'Microsoft Edge'}]`→edge, `undefined`→unsupported(Firefox), `[{brand:'Whale'}]`→unsupported.
  - `StudentFlow`: `attempt:state` ACTIVE 수신 시 ExamTaking 렌더, `session:revoked` 수신 시 Notice + 토큰 삭제.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** — 전체화면 진입은 EnvCheckStep의 버튼 클릭 핸들러에서 `document.documentElement.requestFullscreen()`; `screen.isExtended`는 없으면 false.
- [ ] **Step 4: 통과 확인** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(client): 학생 응시 흐름"`

### Task 16: 핵심 흐름 E2E와 데모 데이터 (F-19 일부)

**Files:**
- Create: `scripts/demo-reset.ts`, `e2e/playwright.config.ts`, `e2e/core-flow.spec.ts`, `docs/DEMO.md`

**Interfaces:**
- Consumes: 전체.
- Produces:
  - `npm run demo:reset` — 데모 교수자 `demo@exam.local` / 비밀번호는 환경변수 `DEMO_STAFF_PASSWORD`, 데모 시험(객관식 5 + 서술형 2, 명단 `20269001`~`20269020` 이름 "학생01"~"학생20", 제한 30분, `OPEN`, 비밀번호는 환경변수 `DEMO_PASSCODE`(기본 `246810`)). 기존 데모 데이터는 삭제 후 재생성.
  - `docs/DEMO.md`: 평가자 접속 안내(교수자 로그인, 학생 입장 URL·학번·비밀번호, 두 브라우저 사용법). 운영 비밀번호 값은 문서에 적지 않고 제출용 안내에만 별도 기재.
- [ ] **Step 1: E2E 작성** — 교수자 로그인 → 데모 시험 운영 화면 → 학생 컨텍스트 2개가 입장·본인 확인·동의·환경 점검(테스트에서는 `navigator.userAgentData`를 Chrome으로 주입, `requestFullscreen`은 Playwright에서 허용) → 대기실 `2/20` 확인 → 교수자 [시험 시작] → 두 학생 ExamTaking 2초 내 표시 → **두 학생 화면의 남은 시간 차이 ≤ 1초**(F-06 AC, G3) → 학생1 답안 입력 후 새로고침해도 답 유지 → 학생1 제출·설문 제출 → 교수자 [시험 종료] → 학생2 제출 완료 화면 → (제한 1분짜리 별도 시험) 마감 시각 경과 후 **1초 안에** 제출 완료 화면(F-11 AC, G3) → 결과 화면에서 서술형 채점 → 총점 표시 → 설문 화면 응답 수 1.
- [ ] **Step 2: 실행해 실패 지점 확인 후 수정** — Run: `npx playwright test` / Expected: 최종 PASS
- [ ] **Step 3: Commit** — `git commit -m "test(e2e): 핵심 시험 흐름과 데모 데이터"`

### Task 17a: 뼈대 초기 배포 (Task 2 직후 수행)

**Files:**
- Create: `railway.json`(빌드 `npm ci && npm run build`, 시작 `npx prisma migrate deploy -w server && node server/dist/index.js`)
- Modify: `README.md`(배포 절차 초안)

**Interfaces:**
- Produces: 배포 URL(HTTPS)에서 `GET /api/health` 200. PRD 7.1 "1주차 초기 배포"(G1).

- [ ] **Step 1:** Railway 프로젝트에 웹 서비스 + PostgreSQL 추가(계정·결제 정보는 사용자가 직접), 환경변수 `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production` 설정
- [ ] **Step 2:** 배포 후 `curl https://<배포 URL>/api/health` → `{"ok":true}`, 마이그레이션 로그에 오류 없음
- [ ] **Step 3: Commit** — `git commit -m "chore(deploy): 뼈대 초기 배포"`

### Task 17b: 전체 배포 (Railway)

**Files:**
- Create: `railway.json` 또는 `nixpacks.toml`(빌드: `npm ci && npm run build`, 시작: `npx prisma migrate deploy -w server && node server/dist/index.js`), `server/src/static.ts`
- Modify: `server/src/app.ts`(운영에서 `client/dist` 정적 제공 + SPA 폴백, `trust proxy` 설정으로 레이트 리밋 IP 정확화), `README.md`(배포 절차), `docs/STUDY.md`(배포 절 초안)

**Interfaces:**
- Produces: 배포 URL(HTTPS). 환경변수 `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`, `DEMO_STAFF_PASSWORD`, `DEMO_PASSCODE`.
- [ ] **Step 1: 실패하는 테스트** — `NODE_ENV=production`에서 `GET /staff/login`(존재하지 않는 서버 경로)이 `index.html`을 반환하고, `GET /api/unknown`은 404 JSON.
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현과 배포** — 17a의 Railway 서비스에 정적 제공·`trust proxy`·환경변수 `DEMO_STAFF_PASSWORD`, `DEMO_PASSCODE` 추가 후 재배포, 배포 서버 콘솔에서 `npm run demo:reset`.
- [ ] **Step 4: 배포 검증** — 배포 URL에서 `GET /api/health` 200, 실제 휴대폰/다른 PC 1대 + 내 PC로 Task 16 시나리오를 수동 진행(교수자 1, 학생 1) → 전 단계 통과. `PLAYWRIGHT_BASE_URL=<배포 URL> npx playwright test` 1회 통과.
- [ ] **Step 5: Commit** — `git commit -m "chore(deploy): Railway 초기 배포"`

---

## 계획 2에서 검증하는 SPEC 완료 조건 (G8)
- F-08 "대시보드 해당 학생에 '동의 거부'가 보인다", F-09 "대시보드 해당 학생에 '다중 모니터' 신호가 보인다": 계획 1은 데이터 저장(`consentDeclined`, `MULTI_MONITOR` 신호)까지 검증하고, 화면 표시는 계획 2의 대시보드 작업에서 검증한다.

## 실행 순서 (하네스 배정, ADR-010)
| 묶음 | 작업 | 담당 |
|---|---|---|
| A (순차) | 1 → 2 → 17a | Coordinator 직접 |
| B (병렬, worktree) | 3 · 4🔒 · 13 | Operator(3: Haiku, 4·13: Sonnet), 4는 Opus 보안 리뷰 |
| C (순차) | 5 → 6🔒 → 7 → 8🔒 → 9 → 10 → 11🔒 → 12🔒 | Operator(Sonnet), 🔒는 Opus 보안 리뷰 |
| D (병렬, worktree) | 14 · 15🔒(자동 저장 훅) | Operator(Sonnet) |
| E (순차) | 16 → 17b🔒 | Operator(Sonnet), 17b 배포 설정은 Opus 보안 리뷰 |

## 이후 계획 (이 계획에 포함하지 않음)
- **계획 2: 감지 + 감독 대시보드** — SPEC 5장(신호 수집, 위반 카운트·자동 잠금, 카드 색·ACK, 네트워크 장애 묶음, 계획 0 채택 항목), F-12, F-13(스냅샷·변경분, 학생 카드, 정렬·검색), F-15, F-16(나머지 조치), F-20. 계획 0 결과를 반영해 작성한다.
- **계획 3: 부하 테스트·검증·마무리** — SPEC 9장 측정 절차(부하 테스트 스크립트, 실시간성 측정, 답안 보존 테스트, 우회 시나리오 테스트), 데모 최종화.
