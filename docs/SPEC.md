# 개발 스펙 — 강의실 시험 무결성 플랫폼

- 문서 버전: v1.4 (2026-11-25)
- 기준 문서: `docs/PRD.md` v1.3 (승인됨)
- 상태: **v1.4 승인됨 (2026-11-25)** — v1.4는 승인된 SPEC·계획 불일치 보완(G6, G7)만 포함
- 이 문서는 **구현의 기준**이다. 구현 중 스펙과 다르게 해야 할 일이 생기면 먼저 이 문서를 고치고(버전 올림), 그 이유를 `docs/DECISIONS.md`에 남긴 뒤 구현한다.
- 표기: `F-xx` 기능, `AC` 완료 조건(Acceptance Criteria), `P-xx` 학생 화면, `S-xx` 교수자 화면

### 변경 이력
| 버전 | 날짜 | 내용 |
|---|---|---|
| v1.0 | 2026-11-23 | 최초 작성 |
| v1.4.1 | 2026-11-27 | 배포 플랫폼 표기를 Railway에서 Render 무료로 변경(1장, D-028·ADR-013). 기능·완료 조건 변경 없음 |
| v1.4 | 2026-11-25 | 중복 접속 승인 후 새 브라우저의 확인 방식 명시(2.3), 다중 모니터 신호 발생 주체를 서버로 정정(5.1) |
| v1.3 | 2026-11-25 | 좌석 배치·좌석 입력 제거, 대시보드를 학생 카드(학번·이름) 목록으로 변경(D-021) |
| v1.2 | 2026-11-25 | 위반 5회 자동 잠금 추가(5.7), 신호 끊김·누락을 위반에서 제외하고 `WARN`으로 하향(D-019, D-020) |
| v1.1 | 2026-11-23 | 모든 교수자 계정의 시험 공유 접근(D-016), 실험 후보 "커서 이탈 시 화면 가림" 추가(5.6, 8장, D-018) |

---

## 1. 시스템 구성

```
[브라우저: 학생 / 교수자]
   │  HTTPS (REST /api/*)  +  WebSocket (Socket.IO)
   ▼
[서버: Node.js + TypeScript + Express + Socket.IO]  ── 빌드된 React 정적 파일도 같은 서버가 제공(같은 도메인)
   │  Prisma
   ▼
[DB: PostgreSQL]
```

| 구성 | 선택 | 비고 |
|---|---|---|
| 프런트엔드 | React 18 + Vite + TypeScript, React Router | 화면 문구는 `client/src/copy/ko.ts` 한 파일에서 관리 |
| 서버 | Node.js 24 LTS + TypeScript, Express, Socket.IO 4 | 입력 검증 zod |
| DB | PostgreSQL 16, Prisma ORM | |
| 공유 타입 | `shared/` 패키지 (이벤트 이름, 페이로드 타입, 상수) | 클라이언트와 서버가 같은 정의 사용 |
| 테스트 | Vitest(단위·통합), supertest(API), Playwright(핵심 흐름 E2E) | |
| 배포 | Render 무료: 웹 서비스 1개 + PostgreSQL 1개(D-028, ADR-013) | 같은 도메인으로 서빙 → CORS·쿠키 문제 회피. 무료 서비스는 유휴 시 잠들고 무료 DB는 30일 뒤 만료 |
| 시간대 | 저장은 UTC, 화면 표시는 Asia/Seoul | |

폴더 구조:
```
/client   React 앱
/server   API + Socket.IO + Prisma
/shared   공유 타입·상수
/scripts  시드, 데모 초기화, 부하 테스트
/experiments  0단계 감지 실험 페이지(제품 코드와 분리)
/docs
```

## 2. 핵심 개념과 상태

### 2.1 시험(Exam) 상태
| 상태 | 의미 | 전이 |
|---|---|---|
| `DRAFT` | 편집 중. 학생 입장 불가 | → `OPEN` ([입장 열기]) |
| `OPEN` | 대기실 개방. 시험 비밀번호 발급됨 | → `RUNNING` ([시험 시작]) |
| `RUNNING` | 응시 중 | → `ENDED` ([시험 종료] 또는 모든 응시가 끝남) |
| `ENDED` | 종료. 채점·결과·설문 열람 | — |

- 문항·명단 수정은 `DRAFT`에서만 가능하다. 무결성 설정은 `RUNNING` 전까지 수정 가능하다.
- `endsAt = startedAt + durationMin` (전원 공통 종료 시각).

### 2.2 응시(Attempt) 상태 전이표

응시(Attempt)는 "한 학생의 한 시험 응시"다. 학생이 본인 확인을 마치면 생성된다.

| 현재 상태 | 이벤트 | 다음 상태 | 비고 |
|---|---|---|---|
| (없음) | 본인 확인 완료, 시험 `OPEN` | `WAITING` | |
| (없음) | 본인 확인 완료, 시험 `RUNNING`, 신규 입장 차단 꺼짐 | `PENDING_APPROVAL` | `isLate = true` |
| (없음) | 본인 확인 완료, 시험 `RUNNING`, 신규 입장 차단 켜짐 | 생성 안 함 | "입장이 마감되었습니다" |
| `WAITING` | 시험 시작 & 준비 완료 | `ACTIVE` | 준비 완료 = 동의 + 환경 점검 |
| `WAITING` | 시험 시작 후 준비 완료 | `ACTIVE` | 대기실에 먼저 들어온 학생은 지각 아님 |
| `PENDING_APPROVAL` | 감독관 승인 | `WAITING` → 준비 완료 시 `ACTIVE` | |
| `PENDING_APPROVAL` | 감독관 거절 | `REJECTED` | 종착 |
| `ACTIVE` | 감독관 일시정지 또는 위반 5회 자동 잠금(5.7) | `PAUSED` | **시간은 계속 흐름**. 답안 입력·저장 불가 |
| `PAUSED` | 감독관 재개 | `ACTIVE` | |
| `ACTIVE`/`PAUSED`/`WAITING` | 학생 제출 / 마감 시각 도달 / 시험 종료 | `SUBMITTED` | `submitReason`: `STUDENT`·`TIMEOUT`·`EXAM_ENDED` |
| `ACTIVE`/`PAUSED` | 감독관 종료 | `TERMINATED` | 그때까지의 답안으로 채점 |
| `SUBMITTED`/`TERMINATED`/`REJECTED` | — | — | 종착. 답안 수정 불가 |

- 학생별 마감 = `exam.endsAt + attempt.extraSeconds`.
- 서버는 1초 주기로 마감이 지난 `ACTIVE`/`PAUSED` 응시를 `SUBMITTED(TIMEOUT)`으로 바꾼다.
- 시험 `ENDED` 시 남은 모든 비종착 응시는 `SUBMITTED(EXAM_ENDED)`가 된다 (`PENDING_APPROVAL`은 `REJECTED`).
- 모든 응시가 종착 상태이고 `now > endsAt`이면 시험은 자동으로 `ENDED`.

### 2.3 학생 세션
- 본인 확인 시 서버가 무작위 **세션 토큰**(32바이트)을 발급하고, 서버에는 해시만 저장한다. 클라이언트는 `localStorage`에 `exam:{examCode}:token`으로 보관한다.
- 같은 토큰으로 다시 들어오면(새로고침, 브라우저 재시작, 와이파이 재연결) **같은 응시를 이어서** 한다.
- 이미 응시가 있는 학번이 **다른 토큰(또는 토큰 없이)**으로 들어오면: 새 접속은 `DUPLICATE_PENDING` 대기 화면이 되고 감독관에게 승인 요청이 간다.
  - 승인 시: 기존 토큰 무효화, 기존 소켓에 `session:revoked` 전송 후 연결 종료, 새 접속이 그 응시를 이어받는다. 새 접속은 대기 중 `pendingToken`으로 `POST /api/student/confirm`을 2초마다 다시 호출하고, 승인되면 세션 토큰을 받는다(ADR-005).
  - 거절 시: 새 접속에 "입장이 거절되었습니다" 표시. 기존 응시는 영향 없음.

### 2.4 시험 비밀번호와 시험 주소
- 시험 주소: `/e/{examCode}` — `examCode`는 시험 생성 시 만드는 8자리 영숫자(비밀 아님).
- 시험 비밀번호: `OPEN` 전환 시 생성하는 **6자리 숫자**. 재발급하면 이전 비밀번호로는 새로 들어올 수 없다(이미 입장한 세션은 유지).
- 무차별 대입 방지: 같은 IP에서 입장 실패 10회/분 초과 시 1분 차단.

## 3. 화면 · 기능 · 데이터 연결표

| 화면 | 주요 기능 | 읽는/쓰는 데이터 |
|---|---|---|
| S-01 교수자 로그인 | F-01 | Staff |
| S-02 시험 목록 | F-02 | Exam |
| S-03 시험 편집 (기본정보·문항·명단·무결성 설정 탭) | F-02, F-03, F-04, F-05 | Exam, Question, RosterEntry |
| S-04 감독 대시보드 | F-06, F-13, F-14, F-15, F-16 | Exam, Attempt, Signal, ProctorAction |
| S-05 학생 상세 패널 (대시보드 안) | F-15, F-16 | Attempt, Signal, ProctorAction |
| S-06 결과·채점 | F-17 | Attempt, Answer, Question, Signal(개수), ProctorAction(개수) |
| S-07 설문 결과 | F-18 | SurveyResponse |
| P-01 입장 (학번·비밀번호) | F-07 | RosterEntry, Exam |
| P-02 본인 확인 | F-07 | RosterEntry, Attempt |
| P-03 사전 고지·동의 | F-08 | Attempt.consentAt |
| P-04 환경 점검 | F-09 | Attempt.env*, Signal |
| P-05 대기실 / 승인 대기 | F-10 | Exam, Attempt |
| P-06 응시 | F-11, F-12 | Question, Answer, Signal |
| P-07 일시정지·경고·전체화면 복귀 오버레이 | F-12, F-16 | Attempt |
| P-08 제출 완료 + 종료 설문 | F-18 | SurveyResponse, Attempt.surveyDone |
| P-09 안내(지원하지 않는 브라우저, 입장 마감, 거절, 세션 종료) | F-07, F-09 | — |

## 4. 데이터 모델

Prisma 스키마의 기준. 필드 이름은 그대로 사용한다.

| 모델 | 필드 | 비고 |
|---|---|---|
| **Staff** | id, email(unique), passwordHash, name, createdAt | 교수자 계정. 스크립트로 생성 |
| **Exam** | id, ownerId→Staff, examCode(unique, 8자), title, instructions, durationMin, status(`DRAFT`·`OPEN`·`RUNNING`·`ENDED`), passcode(nullable, 6자리), lockNewEntry(bool, 기본 false), pasteMode(`RECORD`·`BLOCK`, 기본 `RECORD`), shuffle(bool, 기본 true), startedAt, endsAt, endedAt, createdAt | |
| **Question** | id, examId, position, type(`MCQ`·`ESSAY`), prompt, points(int ≥1), choices(Json: `[{id, text}]`, MCQ만 2~6개), correctChoiceId(MCQ만) | |
| **RosterEntry** | id, examId, studentNo, name | unique(examId, studentNo) |
| **Attempt** | id, examId, rosterEntryId(unique), state, sessionTokenHash, pendingTokenHash(nullable), isLate, consentAt, consentDeclined(bool), envBrowser, envIsExtended, envCheckedAt, questionOrder(Json: questionId[]), choiceOrders(Json: {questionId: choiceId[]}), extraSeconds(int, 기본 0), lastSeq(int), lastHeartbeatAt, violationCount(int, 기본 0), pausedAt(nullable), connected(bool), submittedAt, submitReason, surveyDone(bool), unackedSeverity(`NONE`·`INFO`·`WARN`·`ALERT`), createdAt | |
| **Answer** | id, attemptId, questionId, choiceId(nullable), text(nullable, 최대 5000자), rev(int), savedAt, awardedPoints(nullable) | unique(attemptId, questionId) |
| **Signal** | id, attemptId, type, severity(`INFO`·`WARN`·`ALERT`), seq(nullable), clientAt(nullable), receivedAt, durationMs(nullable), questionId(nullable), meta(Json) | |
| **ProctorAction** | id, attemptId, staffId(nullable: 시스템 조치), type, reason, payload(Json), createdAt | |
| **SurveyResponse** | id, examId, difficulty(1~5, nullable), comment(nullable, 최대 1000자) | **Attempt와 연결하지 않음, 시각도 저장하지 않음**(익명) |

- 문항·보기 순서는 응시 생성 시 계산해 `questionOrder`·`choiceOrders`에 저장한다(`shuffle=false`면 원래 순서). 재접속해도 같은 순서.
- 보관: Signal·ProctorAction은 `exam.endedAt + 90일` 경과 시 매일 1회 삭제 작업으로 삭제. 그 밖의 데이터는 교수자가 시험을 삭제하면 함께 삭제(cascade).

## 5. 행동 감지 명세

### 5.1 1차 신호 종류

| type | 발생 주체 | 조건 | severity |
|---|---|---|---|
| `LEAVE` | 클라이언트 | 탭 숨김(`visibilitychange`→hidden) 또는 창 포커스 상실(`blur`, 1초 주기 `document.hasFocus()` 확인 포함)에서 **복귀할 때** 1건 기록. `meta.cause`: `hidden`·`blur`. `durationMs` = 복귀 시각 − 이탈 시각(`Date.now()` 차이) | <3초 `INFO`, 3~15초 `WARN`, >15초 `ALERT` |
| `LEAVE_START` | 클라이언트 | 이탈 순간 즉시 전송(대시보드에 "이탈 중" 표시용). 저장하되 타임라인에서는 `LEAVE`와 묶어 표시 | `WARN` |
| `FULLSCREEN_EXIT` | 클라이언트 | `fullscreenchange`로 전체화면 해제 | `WARN` |
| `PASTE` | 클라이언트 | 답안 입력란 `paste`. `meta: {length, blocked}` | `WARN` |
| `DROP` | 클라이언트 | 답안 입력란 `drop`. `meta: {length, blocked}` | `WARN` |
| `MULTI_MONITOR` | 서버 | 학생이 환경 점검 결과(`POST /api/student/env`)로 `isExtended: true`를 보내면 서버가 기록 | `WARN` |
| `DISCONNECT` | 서버 | 응시 중 소켓 끊김 후 10초 내 재연결 없음 | `WARN` |
| `RECONNECT` | 서버 | 끊김 후 재연결. `meta.offlineMs` | `INFO` |
| `HEARTBEAT_GAP` | 서버 | 소켓은 연결돼 있으나 하트비트 15초 이상 없음. 화면 문구: "신호 지연 (네트워크 문제 또는 브라우저 이상)" | `WARN` |
| `SEQ_GAP` | 서버 | 수신 seq가 `lastSeq + 1`보다 큼(중간 메시지 누락). `meta: {expected, got}`. 화면 문구: "신호 누락 (네트워크 문제 또는 브라우저 이상)" | `WARN` |

- 이탈 중 전송이 막히면 복귀 후 `LEAVE`를 전송한다. 서버는 `LEAVE_START` 수신 시각과 `LEAVE` 수신 시각 차이를 `meta.serverDurationMs`로 함께 저장한다(클라이언트 시계 조작 대비 교차 확인).
- 0단계 실험을 통과한 신호는 이 표에 행을 추가하는 방식으로 스펙을 개정한 뒤 구현한다.

### 5.2 클라이언트 전송 규칙
- 모든 클라이언트 메시지(`hb`, `signal`)는 응시 단위로 1씩 증가하는 `seq`를 가진다. `seq`는 `localStorage`에 보관해 새로고침 후에도 이어진다.
- 하트비트: `ACTIVE`·`PAUSED`·`WAITING` 상태에서 5초마다 `hb`.
- 연결이 끊긴 동안 생긴 신호는 메모리·`localStorage` 큐에 쌓았다가 재연결 시 순서대로 보낸다.

### 5.3 붙여넣기 모드
- `RECORD`: 붙여넣기·드롭 허용, 신호 기록(`blocked=false`).
- `BLOCK`: 답안 입력란에서 `paste`·`drop` 기본 동작 차단, 학생에게 "이 시험에서는 붙여넣기를 할 수 없습니다" 안내, 신호 기록(`blocked=true`).

### 5.4 학생 카드 색과 확인 처리
- 신호가 저장되면 그 응시의 `unackedSeverity`를 지금 값과 신호 severity 중 높은 값으로 올린다.
- 대시보드 학생 카드 색: `NONE` 초록, `INFO` 초록(점 표시), `WARN` 노랑, `ALERT` 빨강. 상태가 `PAUSED`면 회색 테두리, `SUBMITTED`·`TERMINATED`면 흐리게.
- 감독관이 [확인]을 누르면 `unackedSeverity = NONE`(조치 기록 `ACK`, 사유 불필요).

### 5.5 네트워크 장애 묶음 표시
- 같은 시험에서 **10초 안에 3명 이상 또는 응시 인원의 30% 이상**이 `DISCONNECT`·`HEARTBEAT_GAP`·`SEQ_GAP` 중 하나를 받으면 대시보드 상단에 "네트워크 장애 의심 (N명)" 배너를 띄우고, 해당 신호들은 카드 색을 올리지 않는다(`unackedSeverity` 미반영). 신호 자체는 저장한다.

### 5.6 실험 후보: 커서 이탈 시 화면 가림 (`POINTER_LEAVE`) — 0단계 실험 후 채택 여부 결정
- 동작(채택 시):
  - 커서가 시험 페이지 영역 밖으로 나가면(`document`의 `mouseleave`, 또는 `mouseout`의 `relatedTarget === null`) **즉시** 문항을 가리고 "커서를 시험 화면 안으로 다시 가져와 주세요"를 표시한다. 커서가 돌아오면 바로 다시 보인다.
  - 신호는 밖에 **1초 이상** 머문 경우에만 복귀 시 1건 기록한다. `durationMs` = 복귀 시각 − 이탈 시각.
  - severity는 `LEAVE`와 같은 기준: <3초 `INFO`, 3~15초 `WARN`, >15초 `ALERT`.
- 기대 효과: 전체화면 + 모니터 1대에서는 커서가 원래 페이지 밖으로 나갈 수 없으므로, 이 신호는 주로 **두 번째 모니터로 커서 이동**과 **브라우저 AI 사이드바에 커서를 올림**(클릭 없이 읽기만 하는 경우 포함)을 잡는다. 화면 가림은 "문제를 보면서 사이드바 AI에 입력하기"를 번거롭게 만든다.
- 알려진 한계: Alt+Tab 등 키보드 전환은 커서가 움직이지 않음(→ `LEAVE`가 담당). 두 번째 모니터를 눈으로만 읽는 경우는 잡지 못함.
- 오탐 우려(실험에서 측정): 터치패드로 커서가 가장자리로 밀림, 전체화면 상단 브라우저 안내 영역, 브라우저 기본 팝업(`<select>` 등). → 1차 구현은 브라우저 기본 팝업 요소를 쓰지 않는다.
- 채택되면 5.1 표에 `POINTER_LEAVE` 행을 추가하고 F-12 완료 조건에 반영한다(스펙 버전 올림).

### 5.7 위반 카운트와 자동 잠금
- **위반으로 세는 신호** (모두 1건당 1회):
  - `LEAVE` 중 `durationMs ≥ 3000`
  - `FULLSCREEN_EXIT`
  - `PASTE`, `DROP` (차단된 시도 포함)
  - `POINTER_LEAVE` 중 `durationMs ≥ 3000` (5.6이 채택될 경우)
- **세지 않는 신호**: 3초 미만 이탈, `LEAVE_START`, `DISCONNECT`, `RECONNECT`, `HEARTBEAT_GAP`, `SEQ_GAP`(네트워크와 구분 불가), `MULTI_MONITOR`(시험 전 점검 기록).
- 위반은 `ACTIVE` 상태에서 발생한 신호만 센다(대기·일시정지 중 제외).
- 서버가 `Attempt.violationCount`를 올리고 학생에게 `violation:counted { count, limit: 5, type }`을 보낸다. 학생 화면에 "위반 3/5: 전체화면 해제" 알림을 띄운다.
- **자동 잠금**: `violationCount`가 5의 배수(5, 10, 15…)가 되는 순간 서버가 응시를 `PAUSED`로 바꾸고 `ProctorAction { type: 'AUTO_PAUSE', staffId: null, reason: '시스템 자동 일시정지(위반 N회)' }`를 기록한다. 대시보드 카드는 빨강 + 잠금 표시.
- 잠금 해제는 감독관의 `RESUME`으로만 가능하다. 카운트는 초기화하지 않는다.
- 위반 기준 5회는 모든 시험에 고정(시험별 변경은 2차).
- 잠긴 동안에도 시간은 흐른다(D-014). 감독관 `RESUME` 화면에 "잠겨 있던 시간 n분 추가" 버튼을 함께 표시한다(n = `pausedAt`부터 지금까지를 분 단위 올림). 누르면 `RESUME`과 `ADD_TIME`이 함께 기록된다.

## 6. 기능 명세와 완료 조건

### F-01 교수자 로그인
- 이메일·비밀번호 로그인. 비밀번호는 bcrypt 해시. 세션은 httpOnly·Secure·SameSite=Lax 쿠키(JWT, 12시간).
- 교수자 계정은 `npm run create-staff -- --email --name --password` 스크립트로 만든다(회원가입 화면 없음).
- **AC**
  - [ ] 올바른 계정으로 로그인하면 S-02로 이동한다.
  - [ ] 틀린 비밀번호는 "이메일 또는 비밀번호가 올바르지 않습니다"를 표시한다.
  - [ ] 로그인하지 않고 `/staff/*`나 교수자 API에 접근하면 401 또는 로그인 화면으로 이동한다.
  - [ ] 학생 세션 토큰으로 교수자 API를 호출하면 401이다.

### F-02 시험 생성·목록·삭제
- 필드: 제목(필수, ≤100자), 안내문(≤2000자), 제한 시간(분, 1~300).
- 목록에는 제목, 상태, 만든 사람, 응시 인원/명단 인원, 생성일 표시.
- **권한**: 1차에서는 모든 교수자 계정이 모든 시험을 조회·운영할 수 있다(한 수업 단위 배포 가정, 조교도 별도 교수자 계정으로 같은 시험을 감독 — PRD 4.1). `ownerId`는 "만든 사람" 표시용이다.
- 삭제는 `DRAFT` 또는 `ENDED`에서만 가능, 확인 대화상자 필수.
- **AC**
  - [ ] 시험을 만들면 `DRAFT` 상태와 고유 `examCode`가 생긴다.
  - [ ] 다른 교수자 계정으로 로그인해도 같은 시험이 목록에 보이고 대시보드를 열 수 있다.
  - [ ] `RUNNING` 시험은 삭제 버튼이 비활성화된다.

### F-03 문항 편집
- 객관식: 지문, 보기 2~6개, 정답 1개, 배점. 서술형: 지문, 배점.
- 저장은 문항 목록 전체 교체(`PUT`). `DRAFT`에서만 가능.
- **AC**
  - [ ] 객관식 보기가 2개 미만이거나 정답이 없으면 저장되지 않고 해당 문항에 오류가 표시된다.
  - [ ] 문항 순서를 바꿔 저장하면 그 순서가 유지된다.
  - [ ] `DRAFT`가 아닌 시험의 문항 저장은 409.

### F-04 수강생 명단
- CSV 붙여넣기 또는 파일 업로드: `학번,이름` 한 줄에 한 명. 첫 줄이 헤더(`학번`)면 건너뜀.
- 같은 학번 중복, 빈 값은 오류 줄 번호와 함께 거부. `DRAFT`에서만 수정.
- **AC**
  - [ ] 20명 CSV를 올리면 20명이 명단에 보인다.
  - [ ] 중복 학번이 있으면 저장되지 않고 "3번째 줄: 중복 학번" 같은 오류가 표시된다.

### F-05 무결성 설정
- 무결성 설정: 붙여넣기 모드(`RECORD`/`BLOCK`), 문항·보기 섞기(켬/끔). 그 외 감지는 항상 켜짐.
- `RUNNING` 전까지 수정 가능.
- **AC**
  - [ ] 섞기를 끄면 모든 학생이 원래 순서로 문항·보기를 본다.

### F-06 입장 열기·비밀번호·시험 시작·종료 (교수자)
- [입장 열기]: `DRAFT`→`OPEN`. 문항 1개 이상, 명단 1명 이상이 아니면 불가.
- 비밀번호 크게 보기(칠판에 옮겨 적기용), [재발급].
- [신규 입장 차단] 토글(`lockNewEntry`).
- [시험 시작]: `OPEN`→`RUNNING`, `startedAt`·`endsAt` 설정, 모든 학생에게 `exam:started`.
- [시험 종료]: 확인 대화상자 후 `RUNNING`→`ENDED`.
- **AC**
  - [ ] 문항이 없는 시험은 [입장 열기]가 비활성화되고 이유가 표시된다.
  - [ ] [시험 시작]을 누르면 준비 완료된 대기 학생 전원의 화면이 2초 안에 P-06으로 바뀌고, 모두 같은 남은 시간을 본다(±1초).
  - [ ] 비밀번호를 재발급하면 이전 비밀번호로 새 입장이 실패하고, 이미 입장한 학생은 영향이 없다.
  - [ ] [시험 종료] 후 응시 중이던 학생은 제출 완료 화면으로 바뀐다.

### F-07 학생 입장·본인 확인·세션
- P-01: 학번, 비밀번호 입력. 서버 검증 순서: 시험 상태(`OPEN`/`RUNNING`) → 비밀번호 → 명단 학번.
- 실패 문구는 구분하지 않는다: "학번 또는 시험 비밀번호가 올바르지 않습니다." (단, 시험이 `DRAFT`/`ENDED`면 "지금은 입장할 수 없는 시험입니다.")
- P-02: "○○○(학번) 님이 맞습니까?" [맞습니다] / [아닙니다]. [맞습니다]에서 응시 생성(2.2), 세션 토큰 발급(2.3).
- 2.3의 재접속·중복 접속 규칙 적용.
- **AC**
  - [ ] 명단에 없는 학번은 입장할 수 없다.
  - [ ] 입장한 학생이 새로고침하면 같은 화면·같은 답안으로 이어진다.
  - [ ] 같은 학번으로 다른 브라우저에서 들어오면 그 브라우저는 승인 대기 화면이 되고, 대시보드에 승인 요청이 뜬다. 승인하면 기존 브라우저는 "다른 기기에서 접속하여 이 화면은 종료되었습니다"를 표시하고 새 브라우저가 이어서 응시한다.
  - [ ] 같은 IP에서 1분 안에 11번째 실패 시도는 429로 거부된다.

### F-08 사전 고지·동의
- P-03에 고지 내용 표시: 수집 항목(학번·이름, 화면 이탈·전체화면 해제·붙여넣기 등 행동 기록, 답안, 감독관 조치 기록), 이용 목적, 보관 기간(행동·조치 기록 시험 종료 후 90일), "이 서비스는 AI 사용 여부를 판정하지 않으며, 기록은 감독관의 확인 자료로만 쓰입니다", 붙여넣기 모드 안내, **"위반(3초 이상 화면 이탈, 전체화면 해제, 붙여넣기 시도)이 5회가 되면 화면이 잠기며 감독관만 해제할 수 있습니다"**.
- [동의하고 계속] / [동의하지 않음]. 동의하지 않으면 "동의하지 않으면 응시할 수 없습니다. 감독관에게 문의하세요."와 [다시 보기] 버튼, `consentDeclined=true`가 대시보드에 표시.
- **AC**
  - [ ] 동의하지 않으면 다음 단계로 갈 수 없고, 대시보드 해당 학생에 "동의 거부"가 보인다.
  - [ ] 고지 문구는 `copy/ko.ts`에만 존재한다.

### F-09 환경 점검
- 브라우저: `navigator.userAgentData.brands`에 `Google Chrome` 또는 `Microsoft Edge`가 있으면 통과. 없으면 P-09 "이 시험은 Chrome 또는 Edge에서만 응시할 수 있습니다." (진행 불가)
- 전체화면: [전체화면으로 전환] 버튼으로 진입해야 통과.
- 다중 모니터: `screen.isExtended`가 true면 경고 문구 표시 + `MULTI_MONITOR` 신호. **진행은 막지 않음**(감독관 판단).
- **AC**
  - [ ] Firefox로 접속하면 진행 불가 안내가 표시된다.
  - [ ] 전체화면에 들어가지 않으면 [다음]이 비활성화된다.
  - [ ] 모니터 2대 연결 상태에서 점검하면 대시보드 해당 학생에 "다중 모니터" 신호가 보인다.

### F-10 대기실·지각 승인
- P-05: "교수님이 시험을 시작하면 자동으로 시작됩니다 (현재 N/M명 입장)". N = 준비 완료 인원, M = 명단 인원. 실시간 갱신.
- 지각생(`PENDING_APPROVAL`): "감독관 승인을 기다리고 있습니다" 표시. 승인되면 F-08·F-09를 거쳐 바로 응시. 남은 시간은 공통 마감 기준.
- **AC**
  - [ ] 학생이 대기실에 들어오면 다른 대기 학생 화면과 대시보드의 N이 2초 안에 바뀐다.
  - [ ] 시험 시작 후 입장한 학생은 승인 전까지 문항을 볼 수 없다(문항 API 403).
  - [ ] 승인된 지각생의 남은 시간은 다른 학생과 같다(±1초).
  - [ ] 신규 입장 차단이 켜져 있으면 시작 후 입장 시도는 "입장이 마감되었습니다"가 표시된다.

### F-11 응시·자동 저장·제출
- 문항 목록(번호, 답안 여부 표시)과 문항 화면. 자유 이동.
- 남은 시간 표시는 서버가 보낸 `deadline`과 `serverNow`로 계산한 오프셋 기준.
- 자동 저장: 답안 변경 후 1초 디바운스 + 최소 5초마다 미저장분 전송(`answer:save`). 서버 응답(ack)의 `savedAt`을 "저장됨 14:03:21"로 표시. 미저장 답안은 `localStorage`에도 보관.
- 서버는 같은 문항에 대해 `rev`가 저장된 값보다 작으면 무시(오래된 저장 덮어쓰기 방지).
- 상단 고정 표시: "기록 중 · 이 시험은 화면 이탈과 붙여넣기 등을 기록합니다"와 위반 카운터 **"위반 n/5"**.
- [제출]: 미응답 문항 수를 보여주는 확인 대화상자 후 제출. 마감 시 자동 제출.
- 문항 내용은 상태가 `ACTIVE`일 때만 API로 내려준다. 학생에게 `correctChoiceId`는 절대 내려주지 않는다.
- **AC**
  - [ ] 서술형 입력 후 6초 안에 "저장됨" 시각이 갱신된다.
  - [ ] 네트워크를 끊고 입력한 뒤 다시 연결하면 그 입력이 서버에 저장된다.
  - [ ] 새로고침 후 답안이 복구된다(성공 기준 4).
  - [ ] 마감 시각이 지나면 1초 안에 제출 완료 화면으로 바뀐다.
  - [ ] 학생 응답 JSON 어디에도 정답 정보가 없다(테스트로 확인).

### F-12 응시 중 감지와 화면 보호
- 5.1의 신호 수집·전송.
- 전체화면이 아니면 문항을 가리고 P-07 "전체화면으로 돌아가기" 오버레이 표시(버튼 클릭으로 재진입).
- `PAUSED` 상태면 문항을 가리고 "감독관이 응시를 일시정지했습니다" 표시.
- **AC**
  - [ ] 다른 탭으로 갔다가 5초 후 돌아오면 대시보드에 `LEAVE`(약 5초, `WARN`)가 2초 안에 표시된다.
  - [ ] Alt+Tab으로 다른 앱으로 갔다가 돌아오면 `LEAVE`(`cause=blur`)가 기록된다.
  - [ ] ESC로 전체화면을 해제하면 문항이 가려지고 `FULLSCREEN_EXIT`가 기록된다.
  - [ ] `BLOCK` 모드에서 붙여넣기를 하면 입력되지 않고 `PASTE(blocked=true)`가 기록된다.
  - [ ] 개발자 도구에서 소켓 전송을 막아 하트비트가 15초 이상 끊기면 `HEARTBEAT_GAP`(`WARN`)이 기록되고, 위반 카운터는 늘지 않는다.
  - [ ] 3초 이상 이탈을 5회 하면 5번째 복귀 직후 문항이 가려지고 입력이 막히며, 대시보드 카드가 빨강 + 잠금으로 바뀐다.
  - [ ] 위반이 늘 때마다 학생 화면 카운터와 알림이 갱신된다("위반 n/5").
  - [ ] 2초짜리 이탈과 네트워크 끊김은 카운터를 올리지 않는다.

### F-13 감독 대시보드 (S-04)
- 상단: 시험 상태, 남은 시간, 비밀번호(크게 보기), [시험 시작]/[시험 종료], [신규 입장 차단], 입장 현황 N/M, 네트워크 장애 배너.
- 학생 카드 목록: 카드마다 이름, 학번, 상태 배지(미입장·대기·응시·일시정지·잠김·제출·종료·연결 끊김·이탈 중), 위반 n/5, 5.4의 색, 최근 신호 요약. 명단의 모든 학생을 표시(미입장 포함).
- 정렬: **학번순**(기본) / **확인 필요순**(`unackedSeverity` 높은 순 → 최근 신호 순). 이름·학번 검색창.
- 준비 미완료(동의·환경 점검 전) 학생 표시, 승인 요청 목록(지각·중복 접속).
- 연결 시 `dashboard:snapshot`으로 전체 상태를 받고, 이후 변경분 이벤트로 갱신(7.2). 감독관이 새로고침해도 같은 상태가 보인다.
- 같은 시험의 대시보드를 여러 교수자 계정이 동시에 열 수 있다(F-02 권한).
- **AC**
  - [ ] 20명이 응시 중일 때 학생 카드 20개가 이름·학번·상태와 함께 보인다.
  - [ ] "확인 필요순"에서 새 `WARN` 신호가 생긴 학생 카드가 2초 안에 맨 위로 올라온다.
  - [ ] 감독관 대시보드를 두 브라우저에서 열면 두 화면 모두 같은 신호를 2초 안에 받는다.
  - [ ] 대시보드를 새로고침하면 직전과 같은 카드 색·상태가 복원된다.
  - [ ] 학생 3명의 네트워크를 동시에 끊으면 "네트워크 장애 의심 (3명)" 배너가 뜨고 해당 카드는 노랑으로 바뀌지 않는다.

### F-14 승인 처리
- 지각 입장 요청, 중복 접속 요청 각각 [승인]/[거절]. 사유 입력(기본값 제공: "현장 확인 완료").
- **AC**
  - [ ] 승인·거절 모두 `ProctorAction`(`APPROVE_ENTRY`·`REJECT_ENTRY`·`APPROVE_SESSION`·`REJECT_SESSION`)으로 기록된다.

### F-15 학생 상세 패널 (S-05)
- 학생 카드 클릭 시 열림: 학생 정보, 상태, 남은 시간(추가 시간 포함), 신호 타임라인(시각, 종류, 지속 시간, 문항 번호, severity), 조치 기록.
- 타임라인 문구는 관찰 사실만 쓴다. 예: "다른 탭/앱으로 이동 (12초)", "전체화면 해제", "붙여넣기 340자 (차단됨)", "연결 끊김".
- **AC**
  - [ ] 타임라인이 시간순이며, 새 신호가 열린 패널에 실시간으로 추가된다.
  - [ ] 화면에 "부정행위", "AI 사용", "적발" 같은 판정 표현이 없다.

### F-16 감독관 조치
| type | 동작 | 사유 |
|---|---|---|
| `WARN` | 학생 화면에 메시지 표시(학생이 [확인]을 눌러야 닫힘) | 메시지가 곧 사유(필수) |
| `PAUSE` | `ACTIVE`→`PAUSED`, 학생 화면 잠금. 시간은 계속 흐름 | 필수 |
| `RESUME` | `PAUSED`→`ACTIVE`. 자동 잠금 해제도 이것으로만 가능. "잠겨 있던 시간 n분 추가" 버튼 함께 표시(5.7) | 필수 |
| `TERMINATE` | →`TERMINATED`, 확인 대화상자 | 필수 |
| `ADD_TIME` | `extraSeconds += 분×60` (1~60분) | 필수 |
| `ACK` | `unackedSeverity=NONE` | 불필요 |
| `AUTO_PAUSE` | 시스템이 기록(5.7). 감독관이 실행하는 조치 아님 | 시스템 문구 |
- 사유 입력란에는 빠른 선택 버튼 제공(예: "현장 확인 결과 문제 없음", "본인 요청", "현장 확인 후 경고").
- 모든 조치는 `ProctorAction`(staffId, type, reason, payload, createdAt)으로 저장되고 학생 상세 패널에 표시된다.
- **AC**
  - [ ] 각 조치를 1회씩 실행하면 실행자·시각·사유가 모두 기록된다(성공 기준 6).
  - [ ] `WARN` 메시지가 2초 안에 학생 화면에 뜬다.
  - [ ] `PAUSE` 중 학생은 문항을 볼 수 없고 답안 저장이 거부된다. `RESUME` 후 이어서 응시한다.
  - [ ] `ADD_TIME` 10분 후 그 학생의 남은 시간만 10분 늘어난다.
  - [ ] 사유 없이 `PAUSE`를 요청하면 400.
  - [ ] 자동 잠금된 학생을 [재개] + "잠겨 있던 시간 추가"로 풀면 `RESUME`과 `ADD_TIME`이 모두 기록되고 그 학생의 마감이 늘어난다.

### F-17 채점·결과 (S-06)
- 객관식: 제출 시 자동 채점(정답이면 배점, 아니면 0).
- 서술형: 학생별 답안을 보고 0~배점 점수 입력.
- 결과 표: 학번, 이름, 상태, 객관식 점수, 서술형 점수(미채점 표시), 총점, 신호 수(severity별), 조치 수. 행 클릭 시 신호 타임라인·조치 기록.
- 학생에게는 결과를 보여주지 않는다(PRD 5.1).
- **AC**
  - [ ] 객관식 정답을 고른 학생의 객관식 점수가 배점과 같다.
  - [ ] 서술형 점수에 배점을 넘는 값을 넣으면 거부된다.
  - [ ] 모든 서술형이 채점되면 총점이 표시된다.

### F-18 종료 설문 (P-08, S-07)
- 제출(`SUBMITTED`·`TERMINATED`) 후 표시: 체감 난이도 5점(1 매우 쉬움 ~ 5 매우 어려움), 교수님께 하고 싶은 말(≤1000자). 둘 다 선택 입력, [건너뛰기] 가능.
- 안내 문구: "응답은 익명으로 저장되며 교수님은 누가 작성했는지 볼 수 없습니다. 다만 인원이 적어 의견 내용으로 작성자가 짐작될 수 있습니다."
- 저장 시 `SurveyResponse`는 응시와 연결하지 않고, `Attempt.surveyDone=true`만 표시(중복 응답 방지).
- S-07: 응답 수, 난이도 분포(1~5 막대), 평균, 의견 목록(무작위 순서).
- **AC**
  - [ ] 한 학생은 설문을 한 번만 낼 수 있다.
  - [ ] DB의 `SurveyResponse`에 학번·응시 ID·시각이 없다.
  - [ ] 의견 목록 순서가 제출 순서와 다르다(새로고침마다 섞임).

### F-19 데모 데이터와 평가용 접속
- `npm run demo:reset`: 데모 교수자 계정, 데모 시험(객관식 5 + 서술형 2, 명단 20명 `20269001`~`20269020`, `OPEN` 상태, 고정 비밀번호)을 초기화.
- `docs/DEMO.md`: 평가자용 접속 안내(교수자 로그인 정보, 학생 입장 방법, 두 브라우저로 교수자·학생 화면을 함께 보는 방법).
- **AC**
  - [ ] 안내문만 보고 교수자 화면과 학생 화면에 모두 접속해 시험을 시작·응시·제출할 수 있다(성공 기준 7).

### F-20 데이터 보관 작업
- 서버 시작 시와 매일 1회: `endedAt + 90일`이 지난 시험의 Signal·ProctorAction 삭제.
- **AC**
  - [ ] `endedAt`을 91일 전으로 바꾼 테스트 시험의 신호가 작업 실행 후 삭제된다(단위 테스트).

## 7. API·실시간 이벤트

### 7.1 REST API
모든 응답은 JSON. 오류는 `{ error: { code, message } }`. 교수자 API는 로그인 쿠키, 학생 API는 `Authorization: Bearer {sessionToken}`.

| 메서드 | 경로 | 권한 | 기능 |
|---|---|---|---|
| POST | `/api/staff/login` | — | F-01 |
| POST | `/api/staff/logout` | 교수자 | F-01 |
| GET | `/api/staff/me` | 교수자 | F-01 |
| GET/POST | `/api/exams` | 교수자 | F-02 목록·생성 |
| GET/PATCH/DELETE | `/api/exams/:id` | 교수자 | F-02, F-05 |
| PUT | `/api/exams/:id/questions` | 교수자 | F-03 |
| PUT | `/api/exams/:id/roster` | 교수자 | F-04 (`{ csv: string }`) |
| POST | `/api/exams/:id/open` | 교수자 | F-06 |
| POST | `/api/exams/:id/passcode` | 교수자 | F-06 재발급 |
| POST | `/api/exams/:id/start` | 교수자 | F-06 |
| POST | `/api/exams/:id/end` | 교수자 | F-06 |
| GET | `/api/attempts/:id/timeline` | 교수자 | F-15 |
| POST | `/api/attempts/:id/actions` | 교수자 | F-14, F-16 (`{ type, reason, payload }`) |
| GET | `/api/exams/:id/results` | 교수자 | F-17 |
| PUT | `/api/answers/:id/grade` | 교수자 | F-17 (`{ points }`) |
| GET | `/api/exams/:id/survey` | 교수자 | F-18 |
| GET | `/api/public/exams/:examCode` | — | 시험 제목·상태 (P-01 표시용) |
| POST | `/api/student/entry` | — | F-07 (`{ examCode, studentNo, passcode }` → `{ name }`) |
| POST | `/api/student/confirm` | — | F-07 (`{ examCode, studentNo, passcode, sessionToken? }` → `{ sessionToken, attempt }` 또는 `{ status: 'DUPLICATE_PENDING', pendingToken }`) |
| GET | `/api/student/attempt` | 학생 | 현재 응시 상태·남은 시간 |
| POST | `/api/student/consent` | 학생 | F-08 (`{ agree: boolean }`) |
| POST | `/api/student/env` | 학생 | F-09 (`{ browser, isExtended, fullscreen }`) |
| GET | `/api/student/exam` | 학생(`ACTIVE`) | 문항(섞인 순서, 정답 제외)·저장된 답안 |
| POST | `/api/student/submit` | 학생 | F-11 |
| POST | `/api/student/survey` | 학생(종착 상태) | F-18 |

### 7.2 Socket.IO 이벤트
연결 시 `auth`에 교수자는 쿠키, 학생은 `{ sessionToken }`. 서버는 교수자를 `exam:{examId}:staff` 방에, 학생을 `attempt:{attemptId}` 방과 `exam:{examId}:students` 방에 넣는다.

| 방향 | 이벤트 | 페이로드 | 기능 |
|---|---|---|---|
| 학생→서버 | `hb` | `{ seq }` | 5.2 |
| 학생→서버 | `signal` | `{ seq, type, clientAt, durationMs?, questionId?, meta }` | 5.1 |
| 학생→서버 | `answer:save` | `{ questionId, choiceId?, text?, rev }` → ack `{ ok, savedAt }` | F-11 |
| 서버→학생 | `attempt:state` | `{ state, deadline, serverNow, extraSeconds, violationCount }` | 상태 변경마다 |
| 서버→학생 | `exam:started` | `{ endsAt, serverNow }` | F-06 |
| 서버→학생 | `waiting:count` | `{ ready, total }` | F-10 |
| 서버→학생 | `proctor:warning` | `{ message }` | F-16 |
| 서버→학생 | `violation:counted` | `{ count, limit, type }` | 5.7 |
| 서버→학생 | `session:revoked` | `{}` | F-07 |
| 교수자→서버 | `dashboard:join` | `{ examId }` → ack `dashboard:snapshot` | F-13 |
| 서버→교수자 | `dashboard:snapshot` | `{ exam, attempts[], pendingApprovals[], networkIncident? }` | F-13 |
| 서버→교수자 | `attempt:updated` | 학생 카드에 필요한 응시 요약 | F-13 |
| 서버→교수자 | `signal:new` | `{ attemptId, signal }` | F-13, F-15 |
| 서버→교수자 | `approval:pending` / `approval:resolved` | `{ attemptId, kind: 'LATE'·'DUPLICATE' }` | F-14 |
| 서버→교수자 | `network:incident` | `{ count, attemptIds, since }` 또는 `null`(해제) | 5.5 |

- 상태의 원본은 서버(DB)다. 교수자 화면은 스냅샷 + 변경분으로만 상태를 만든다.

## 8. 0단계 감지 실험 명세
- 위치: `/experiments/detection-lab/` (제품 코드와 분리된 단일 HTML+JS 페이지). 모든 브라우저 이벤트(`visibilitychange`, `blur`/`focus`, `hasFocus` 주기 확인, `fullscreenchange`, `resize`(inner/outer 크기), `mouseleave`, `keydown`(수정키), `screen.isExtended`, `MutationObserver`, `selectionchange`, `copy`, `input` 이벤트와 당시 `hasFocus`)를 시각과 함께 화면에 기록하고 JSON으로 내보낸다.
- 실험 브라우저: Chrome, Edge 최신 안정 버전. 버전 번호를 기록한다.
- 시나리오(각 10회): 다른 탭, Alt+Tab, 화면 분할, 두 번째 모니터 창 이동, Chrome Gemini/Claude 확장 사이드바 열기·사용, Edge Copilot 사이드바 열기·사용, 전체화면 중 사이드바 시도, AI 확장의 페이지 읽기, 에이전트형 조작(가능한 경우), **커서를 두 번째 모니터로 이동, 커서를 AI 사이드바 위에 올리고 읽기만 하기**(5.6 `POINTER_LEAVE` 검증, 실험 페이지에 화면 가림 동작 포함).
- 일상 행동(오탐) 시나리오(각 10회): 권한 창, OS 알림, 업데이트 창, 노트북 덮개·절전 복귀, 한/영 전환 및 한글 입력, **터치패드로 서술형 입력 중 커서가 가장자리로 밀림, 전체화면 상단에 커서가 닿음**(5.6 오탐 측정).
- 채택 기준: 해당 행동에서 신호가 **10회 중 9회 이상** 발생하고, 일상 행동 시나리오에서 같은 신호가 **10회 중 1회 이하**로 발생.
- 결과: `docs/STUDY.md`에 "행동 × 브라우저 × 발생 신호 × 횟수" 표와 채택/제외 판단. 채택 항목은 SPEC 5.1에 행 추가(버전 올림).

## 9. 성공 기준 측정 절차 (PRD 6장과 대응)

| PRD 기준 | 절차 | 도구 |
|---|---|---|
| 1 외부 배포 | 배포 URL에서 F-19 데모로 PRD 4.2 시나리오 9단계 체크리스트 실행 | 수동 + 체크리스트(`docs/STUDY.md` 부록) |
| 2 동시 응시 | `scripts/load-test.ts`: 가상 학생 20명(socket.io-client)이 입장→대기→시작→10초마다 답안 저장·2분마다 신호 전송→제출, 교수자 소켓 2개 연결. 제출 20/20, 서버 5xx 0, 교수자 소켓 수신 누락 0 확인 | 스크립트 |
| 3 실시간성 | 부하 테스트 중 신호 100건의 서버 수신 시각과 교수자 소켓 수신 시각(같은 프로세스에서 측정)을 비교, 95% ≤ 2초 | 스크립트 |
| 4 답안 보존 | 브라우저 네트워크 차단·새로고침 10회 수동 테스트 + Playwright 자동화 1개 | Playwright |
| 5 감지 검증 | 우회 시나리오 테스트(Chrome·Edge × 시나리오 × 10회), 결과는 STUDY | 수동 |
| 6 공정성 | `copy/ko.ts`에서 금지어("부정행위", "AI 사용", "적발", "커닝") 검색 테스트 + 조치 기록 통합 테스트 | Vitest |
| 7 평가용 접속 | `docs/DEMO.md`만 보고 처음 쓰는 사람이 접속·진행 | 지인 1명 테스트 |

## 10. 2차 기능 연결 지점 (참고)
2차 기능을 추가할 때 다음을 확장한다. 1차 구현은 이 확장을 막지 않도록만 한다.
- 화면 공유 캡처: 새 신호 `SCREEN_SHARE_STOPPED`, 새 모델 `Capture`, 파일 저장소(R2).
- 작성 과정 기록: 새 모델 `AnswerEvent`(answerId, at, delta).
- 문제 풀: `Question.poolId`, 응시 생성 시 추출.
- 자동 종료: `Exam.autoTerminate`, 5.7의 위반 카운트 재사용.
- 위반 기준 횟수 시험별 설정: `Exam.violationLimit`.
- 좌석 배치도(강의실 배치 격자에서 학생이 자기 자리 클릭): 강의실마다 배치가 달라 1차 제외(D-021).
