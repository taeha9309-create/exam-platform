# 시험 무결성 플랫폼 (exam-platform)

강의실에서 노트북으로 치르는 시험에서 **브라우저 이탈과 브라우저 안의 AI 사용 흔적**을 실시간으로 감지해 감독관에게 알리고,
감독관이 확인·조치한 과정을 기록으로 남기는 웹 시험 플랫폼. 대학 기말 프로젝트(1인, 스펙 주도 개발).
시스템은 "AI를 썼다"고 **판정하지 않고** 관찰된 행동만 기록한다.

## 문서
| 문서 | 내용 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 문제 정의, 해결 방법, 기능 범위, 성공 기준 |
| [docs/SPEC.md](docs/SPEC.md) | 기능별 동작·완료 조건, 데이터 모델, API·실시간 이벤트 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 결정 기록(D-xxx)과 기술 결정(ADR-xxx) |
| [docs/superpowers/plans/](docs/superpowers/plans/) | 구현 계획(계획 0: 감지 실험, 계획 1: 핵심 시험 흐름) |
| [docs/harness/VERIFICATION.md](docs/harness/VERIFICATION.md) | 개발 하네스 안전장치 검증과 한계 |
| [CLAUDE.md](CLAUDE.md) | AI 에이전트 작업 규칙(역할, 모델 라우팅, 병합 정책) |

## 구성
```
shared/   클라이언트·서버 공용 타입·상수 (@exam/shared)
server/   Node.js + Express (+ Socket.IO, Prisma — 이후 작업에서 추가)
client/   React + Vite
experiments/detection-lab/   감지 실험 페이지 (제품 코드와 분리된 버리는 코드)
scripts/  운영 보조 스크립트
```
기술 스택: React · Node.js(TypeScript) · Express · Socket.IO · PostgreSQL · Prisma. 선택 이유는 `docs/DECISIONS.md`의 ADR 참고.

## 개발 환경
필요한 것: Node.js 24 이상, Docker(로컬 PostgreSQL).

```bash
npm install            # 모든 작업 공간 설치
cp .env.example .env   # 로컬 개발용 값 (커밋하지 않음)
npm run db:up          # PostgreSQL 시작 (데이터베이스 exam, exam_test)
npm run dev            # 서버(3000) + 화면(5173) 동시 실행 → http://localhost:5173
```

### 데이터베이스
- 로컬 PostgreSQL은 `localhost`에서만 접속됩니다(`127.0.0.1:5432`). 데이터베이스는 **`exam`(개발)** 과 **`exam_test`(통합 테스트)** 두 개입니다.
- 테스트(`npm test`)는 시작할 때 `exam_test`에 마이그레이션을 자동 적용하고, 각 테스트 전에 테이블을 비웁니다. **이름이 `_test`로 끝나지 않는 DB는 거부**하므로 개발 DB가 지워질 일은 없습니다.
- 테스트는 `.env`를 읽지 않습니다. 다른 테스트 DB(예: 다른 작업과 동시에 테스트할 때)를 쓰려면 셸에서 지정하세요: `TEST_DATABASE_URL=postgresql://exam:exam@localhost:5432/이름_test npm test -w @exam/server` (DB는 미리 만들어 두고, 이름은 `_test`로 끝나야 합니다).
- 개발 DB에 스키마 적용: `npm run db:deploy -w @exam/server` (스키마를 바꾸는 개발 중에는 `npm run db:migrate -w @exam/server`).
- DB를 통째로 초기화하려면 `npm run db:down -- -v` 후 `npm run db:up`. (`exam_test`를 만드는 초기 SQL은 볼륨을 **처음 만들 때만** 실행되므로, `exam_test`가 없다는 오류가 나면 이 방법을 쓰세요.)
- npm이 보안 설정으로 패키지의 설치 스크립트를 막기 때문에 Prisma 클라이언트는 자동 생성되지 않습니다. `npm test`·`npm run typecheck`·`npm run build`가 실행 전에 `prisma generate`를 자동으로 호출합니다(직접 하려면 `npm run db:generate -w @exam/server`).

| 명령 | 설명 |
|---|---|
| `npm test` | 모든 작업 공간의 테스트 |
| `npm run typecheck` | 모든 작업 공간의 타입 검사 |
| `npm run build` | 화면(`client/dist`)과 서버(`server/dist`) 빌드 |
| `npm run db:down` | PostgreSQL 종료 |
| `npm run demo:reset` | 평가자 시연용 데모 교수자·시험·명단 재생성(`DEMO_STAFF_PASSWORD` 필요, 자세한 내용은 [docs/DEMO.md](docs/DEMO.md)) |
| `npm run e2e` | 핵심 흐름 E2E(Playwright, 수동 실행, 방법은 docs/DEMO.md 3장) |

개발 중에는 화면 개발 서버가 `/api`, `/socket.io` 요청을 서버(3000)로 넘긴다. 운영에서는 서버가 빌드된 화면을 같은 주소로 제공한다. 이 프록시는 Host를 5173으로 유지해(`changeOrigin: false`) 서버의 Origin 검사를 통과한다. 다른 출처로 화면을 열 때만 `.env`의 `ALLOWED_ORIGINS`를 설정한다.

## 브랜치와 병합
`main`은 보호되어 있다. 작업 브랜치(`task/...`)에서 PR을 만들고, 필수 검사(`protected-files`, `review-gate`, `test`)를 통과한 뒤 **사용자가 직접 병합**한다.

## 배포 (Railway)
**설정 파일(`railway.json`)을 쓰지 않습니다.** Railway가 이 방식을 폐지해서 2026-12-01부터 파일을 읽지 않고 새 서비스는 아예 쓸 수 없기 때문입니다. 대신 서비스 설정(대시보드)과 이 저장소의 표준 스크립트(`npm run build`, `npm start`)를 씁니다. 운영에서는 서버 하나가 **화면·API·실시간 통신을 같은 주소**로 제공합니다.

1. [railway.com](https://railway.com)에 GitHub 계정으로 가입하고 결제 수단을 등록합니다(사용량 과금, 이 규모에서는 월 5달러 안팎 예상).
2. **New Project → Deploy from GitHub repo → exam-platform**
3. 같은 프로젝트에서 **+ New → Database → PostgreSQL** 추가 (서비스 이름이 `Postgres`인지 확인)
4. 앱 서비스 **Variables**:
   | 변수 | 값 |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Postgres 서비스의 값을 참조) |
   | `JWT_SECRET` | 직접 만든 긴 무작위 문자열(32자 이상, 공개 금지): `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `NODE_ENV` | `production` |
5. 앱 서비스 **Settings**:
   | 항목 | 값 |
   |---|---|
   | Build Command | `npm run build` |
   | Start Command | `npm start` |
   | Pre-deploy Command | `npm run db:deploy -w @exam/server` — 새 버전이 뜨기 전에 DB 마이그레이션을 적용하고, **실패하면 배포를 중단**합니다 |
   | Healthcheck Path (보이면) | `/api/health` |
6. **Settings → Networking → Generate Domain**으로 주소를 만듭니다.
7. 확인: `https://<도메인>/api/health` → `{"ok":true}`, `https://<도메인>/` → 화면

`PORT`는 Railway가 자동으로 넣어 주고, Node 버전은 `package.json`의 `engines`와 `.node-version`으로 지정합니다(빌드 로그에서 24가 쓰였는지 확인하세요). 프록시 뒤에서 클라이언트 IP를 읽도록 운영(`NODE_ENV=production`)에서만 `trust proxy`(프록시 1겹)가 켜집니다.

### 운영 환경변수 정리: `DEMO_*`는 서비스에 넣지 않습니다
`DEMO_STAFF_PASSWORD`, `DEMO_PASSCODE`는 **앱 서비스 Variables에 넣지 않습니다.** 서버 코드(`server/src`)는 이 값을 읽지 않고, `scripts/demo-reset.ts`가 **실행할 때만** 읽습니다(데모 데이터는 아래 절차대로 사용자 PC에서 만듭니다). 교수자 비밀번호·시험 입장 비밀번호가 서비스 변수에 계속 남아 있을 이유가 없습니다. 앱 서비스에 필요한 변수는 위 표의 3개(`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`)뿐입니다. (`PORT`는 Railway가 넣고, `ALLOWED_ORIGINS`는 개발 전용이라 운영에서는 설정하지 않습니다.)

### 배포 서버에 데모 데이터 넣기
Railway 서비스의 콘솔을 쓰지 않고, **내 PC 터미널에서 Railway Postgres의 외부 접속 주소로** `demo:reset`을 실행합니다.

1. Railway의 Postgres 서비스 → **Variables**에서 **외부(public) 접속 URL**을 찾습니다(보통 `DATABASE_PUBLIC_URL`, 정확한 이름은 화면에서 확인). `DATABASE_URL`은 내부 주소라 내 PC에서 접속되지 않을 수 있습니다.
2. 내 PC 터미널(Git Bash)에서 실행합니다. 값은 `<…>` 자리에 직접 채웁니다.
   ```bash
   read -rs -p "외부 DB URL: " DATABASE_URL; export DATABASE_URL; echo   # 입력이 화면·기록에 남지 않음
   read -rs -p "교수자 비밀번호(8자 이상): " DEMO_STAFF_PASSWORD; export DEMO_STAFF_PASSWORD; echo
   NODE_ENV=production DEMO_PASSCODE=<6자리 숫자> npm run demo:reset
   unset DATABASE_URL DEMO_STAFF_PASSWORD                                  # 끝나면 반드시 지움
   ```
3. 출력되는 **시험 코드**로 학생 입장 주소(`https://<도메인>/e/<시험 코드>`)를 만듭니다. 다시 실행할 때마다 코드가 바뀝니다.

주의:
- 이 PC의 `.env` 파일이 다른 DB를 가리킬 수 있습니다. 명령은 `.env`를 읽지만(`--env-file-if-exists`), Node는 **이미 설정된 환경변수를 파일 값보다 우선**합니다(임시 파일로 확인함). 그래도 위처럼 `DATABASE_URL`을 먼저 설정했는지, **운영 DB가 맞는지** 실행 전에 다시 확인하세요. 잘못된 DB면 그 DB의 데모 데이터를 지웁니다.
- `DEMO_PASSCODE`도 비밀 값이므로 명령줄에 적으면 셸 기록에 남습니다. 화면 공유를 끄고 실행하고, 끝난 뒤 기록에서 해당 줄을 확인하세요.
- 대안: Railway CLI의 `railway run`으로 프로젝트 변수를 주입해 실행할 수도 있습니다. 단 내부 주소(`*.railway.internal`)는 내 PC에서 접속되지 않으므로 외부 URL을 쓰도록 맞춰야 합니다(이 방식은 이 저장소에서 검증하지 않았습니다).
- 데모 데이터의 내용·삭제 범위는 [docs/DEMO.md](docs/DEMO.md) 2장을 봅니다.

### 배포 후 검증 체크리스트
위에서부터 순서대로 확인합니다. 기기는 **내 PC 1대 + 휴대폰(데이터 통신) 또는 다른 PC 1대**를 씁니다.

| 순서 | 확인 | 이상하면 확인할 것 |
|---|---|---|
| 1 | `https://<도메인>/api/health`가 200, `{"ok":true}` | Deployments 로그(시작 로그에 "서버를 시작할 수 없습니다"가 있는지: `JWT_SECRET` 길이·`DATABASE_URL`), Healthcheck Path |
| 2 | `https://<도메인>/` 화면이 뜨고 `/staff/login`을 **새로고침해도** 화면이 나옴 | 빌드 로그(`npm run build` 성공 여부), `client/dist`가 만들어졌는지 |
| 3 | 교수자 로그인 성공(`demo@exam.local`). 개발자 도구 Application → Cookies에서 쿠키가 **Secure·HttpOnly** | 403 `FORBIDDEN_ORIGIN`이면 Origin 검사가 프록시의 Host·`X-Forwarded-Proto`와 맞지 않는 것(`NODE_ENV=production`인지, `https`로 접속했는지) |
| 4 | **소켓 연결**: 교수자 [진행] 화면을 연 채 다른 기기에서 학생 입장 → 입장 현황이 **새로고침 없이** 바뀜 | 개발자 도구 Network의 `socket.io` 요청 상태(웹소켓 101 또는 폴링 200 여부), 403이면 소켓 Origin 검사 |
| 5 | **로그인 IP 제한**: 내 PC에서 같은 이메일로 5회 틀리면 429 → **휴대폰 데이터(다른 네트워크)에서는 같은 이메일 로그인이 막히지 않음** | 다른 네트워크도 막히면 모두 프록시 IP로 보이는 것(`trust proxy` 미적용). 내 PC가 막히지 않으면 요청마다 IP가 달라 보이는 것 |
| 6 | 학생 한 판: 입장 → 동의 → 환경 점검 → 대기실 → (교수자 시작) → 답 입력·자동 저장 → 제출 → 설문 | 단계별 오류 문구와 서버 로그, 시나리오는 [docs/DEMO.md](docs/DEMO.md) 1장 |
| 7 | 교수자 [시험 종료] → 결과·설문 보기 → 끝나면 `demo:reset`으로 되돌림 | 되돌리지 않으면 평가자가 쓸 시험이 종료 상태로 남습니다 |

5번은 한 번 막히면 15분 동안 그 IP·이메일 조합이 막힙니다. **시연 직전에는 하지 마세요.** 막혔다면 휴대폰 데이터 등 다른 네트워크를 쓰거나 15분을 기다립니다(서버 재시작으로 풀리는지는 미확인).

### 운영 안내 (평가자·시연자에게 전달)
- **교수자는 시험 전에 미리 로그인해 두세요.** 로그인 시도는 IP 기준으로 제한됩니다(IP당 1분 20회, IP+이메일당 15분 5회 실패). 로그인이 **429로 막히면 다른 네트워크(휴대폰 데이터)** 를 쓰세요.
- **학생도 미리 입장하세요.** 같은 와이파이처럼 공용 IP를 쓰는 환경에서는 입장 시도 제한이 함께 계산됩니다. 시험 시작 직전에 한꺼번에 입장하지 말고 대기실에서 기다리게 합니다. (같은 내용이 [docs/DEMO.md](docs/DEMO.md)에도 있습니다.)

### 배포 URL 대상 E2E
```bash
PLAYWRIGHT_BASE_URL=https://<도메인> DEMO_STAFF_PASSWORD=<교수자 비밀번호> DEMO_PASSCODE=<6자리 숫자> npm run e2e
```
**배포 서버의 데이터를 바꿉니다**(데모 시험 시작·종료, 학생01 응시·설문 생성, `[데모] 1분 마감 시험` 추가). 미리 `demo:reset`이 되어 있어야 하며, **시연 직전에는 실행하지 말고** 실행했다면 끝난 뒤 `demo:reset`으로 되돌립니다. 자세한 내용은 [docs/DEMO.md](docs/DEMO.md) 3장.

### 흔한 문제
| 증상 | 확인할 것 |
|---|---|
| 빌드가 실패하거나 Node 버전 오류 | 빌드 로그에서 Node 24가 쓰였는지. `package.json`의 `engines`(`>=24`)와 `.node-version`(24) |
| Pre-deploy 실패로 배포가 멈춤 | 의도된 동작입니다(마이그레이션 실패 시 새 버전을 올리지 않음). Pre-deploy 로그의 오류, `DATABASE_URL`이 `${{Postgres.DATABASE_URL}}`인지, Postgres 서비스 이름이 `Postgres`인지 |
| 배포는 됐는데 헬스체크 실패 | 시작 로그의 "서버를 시작할 수 없습니다" 줄(`JWT_SECRET` 없음·32자 미만 등), Start Command가 `npm start`인지, Healthcheck Path가 `/api/health`인지 |
| 웹소켓이 안 붙음(입장 현황이 갱신되지 않음) | Network의 `socket.io` 요청이 403인지(소켓 Origin 검사: `https`로 접속했는지, 도메인이 맞는지). Railway 프록시가 웹소켓을 통과시키는지는 배포 뒤 확인할 항목(미확인) |
| 로그인이 403 `FORBIDDEN_ORIGIN` | `NODE_ENV=production`인지, 주소창이 배포 도메인(https)과 같은지 |
| 모든 사용자가 한꺼번에 429 | `trust proxy`가 적용되지 않아 모두 같은 IP로 계산되는 경우. `NODE_ENV=production`인지 확인 |

### 비용과 정리
- 사용량 과금이므로 시연·평가가 끝나면 앱 서비스와 Postgres 서비스를 **중지하거나 삭제**합니다(서비스 Settings 하단 또는 프로젝트 설정에서 삭제. 메뉴 이름과 과금 정책 세부는 Railway 화면·문서로 확인하세요. 이 문서는 확인하지 않았습니다).
- **백업이 없습니다.** Postgres를 삭제하면 데이터는 복구되지 않습니다. 필요한 결과(채점·설문)는 삭제 전에 화면에서 따로 보관하세요. 데모 데이터는 `demo:reset`으로 언제든 다시 만들 수 있습니다.
