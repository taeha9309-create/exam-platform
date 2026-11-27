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

## 배포 (Render 무료)
배포 플랫폼은 **Render(무료 요금제)** 입니다. 서버 하나가 **화면·API·실시간 통신을 같은 주소**(`https://<이름>.onrender.com`)로 제공합니다. 설정 파일(`render.yaml` 등)은 쓰지 않고 대시보드 설정과 이 저장소의 표준 스크립트(`npm run build`, `npm start`)를 씁니다.

### 무료 요금제의 제약 (비용 대신 치르는 것)
Render 공식 문서 기준으로 정리했습니다. 정확한 내용은 배포 시점의 Render 화면·문서로 다시 확인하세요.

| 제약 | 내용 | 대책 |
|---|---|---|
| 서비스 잠듦 | 15분간 인바운드 트래픽(HTTP 요청, 기존 웹소켓 메시지 포함)이 없으면 잠들고, 다음 요청·새 웹소켓 연결 때 약 1분에 걸쳐 다시 깨어납니다 | 시연·평가 **몇 분 전에 주소를 한 번 열어 깨웁니다.** 외부 핑으로 깨워 두는 방식은 효과·약관을 확인하지 못했습니다(미확인, 권하지 않음) |
| 무료 Postgres 30일 만료 | 만든 지 30일 뒤 만료되어 접속할 수 없고, 14일 유예 후 삭제됩니다. 1GB, **백업 없음** | DB는 제출·평가 시점에 맞춰 만듭니다(권장: 12/7 전후). 만료 전에 새 DB를 만들어 아래 절차로 옮깁니다 |
| 파일시스템 휘발성 | 재시작·재배포 때 파일이 사라집니다 | 이 서비스는 데이터를 DB에만 저장합니다 |
| 커스텀 도메인 없음 | `onrender.com` 주소만 씁니다 | 제출 문서에 이 주소를 적습니다 |
| Pre-deploy Command 불가 | 유료 서비스 전용입니다 | 마이그레이션을 Start Command 앞에 붙입니다(아래) |
| 카드 등록 필요 여부 | **미확인** | 가입 화면에서 확인 |

### 배포 절차 (순서 중요)
1. [render.com](https://render.com)에 GitHub 계정으로 가입합니다.
2. **먼저 Postgres를 만듭니다**: **New → PostgreSQL**, 플랜 Free. 리전은 웹 서비스와 **같게** 고르고, 한국 사용자라면 가까운 리전(예: Singapore, 정확한 목록은 화면에서 확인)을 씁니다. 만든 뒤 DB 화면에서 **Internal Database URL**을 복사해 둡니다(같은 리전·같은 계정 안에서만 쓰는 내부 주소).
3. **New → Web Service**: GitHub의 exam-platform 저장소를 연결하고 Runtime은 Node, Instance Type은 Free로 둡니다.
4. 서비스 설정:
   | 항목 | 값 |
   |---|---|
   | Build Command | `npm ci && npm run build` |
   | Start Command | `npm run db:deploy -w @exam/server && npm start` |
   | Health Check Path | `/api/health` (생성 화면의 Advanced. 2xx·3xx면 정상이고, 실패하면 배포가 롤아웃되지 않음) |
5. 앱 서비스 **Environment** 변수:
   | 변수 | 값 |
   |---|---|
   | `DATABASE_URL` | 2단계의 **Internal Database URL** |
   | `JWT_SECRET` | 직접 만든 긴 무작위 문자열(32자 이상, 공개 금지): `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY_HOPS` (선택) | 프록시 홉 수(기본 1, 1~3). 아래 "로그인 IP 제한 확인"에서 필요할 때만 조정. 이 변수는 별도 작업으로 추가 중이라 **이 문서를 쓴 시점에는 코드에서 확인하지 못했습니다.** 코드에 반영된 뒤에만 유효합니다 |
6. 확인: `https://<이름>.onrender.com/api/health` → `{"ok":true}`, `https://<이름>.onrender.com/` → 화면. 처음 접속이 느리면 약 1분 기다립니다.

설명:
- **마이그레이션은 Start Command 앞에 붙습니다.** 적용할 마이그레이션이 없으면 바로 끝나므로 서비스가 깨어날 때마다 돌아도 안전합니다. **마이그레이션이 실패하면 서비스가 시작되지 않습니다**(`&&`). 로그에서 원인을 확인하세요.
- `PORT`(기본 10000)는 Render가 주입하고 서버가 읽습니다. `httpServer.listen(port)`는 호스트를 지정하지 않아 Node 기본값(모든 인터페이스)에 바인딩됩니다(코드로 확인함). Render의 0.0.0.0 바인딩 요구를 충족하는지는 배포 로그의 "서버 시작" 줄과 헬스체크로 확인합니다.
- Node 버전은 저장소 루트의 `.node-version`(24)으로 지정합니다. Render의 24 지원 여부는 **미확인**이므로 빌드 로그에서 쓰인 버전을 확인하세요(`package.json`의 `engines`는 `>=24`).
- 운영(`NODE_ENV=production`)에서는 `trust proxy`(프록시 1겹)가 켜져 프록시 뒤에서 클라이언트 IP를 읽습니다. Render 프록시의 실제 홉 수는 **공식 문서에서 확인하지 못했습니다(미확인)**. 아래 검증으로 확인합니다.
- `ALLOWED_ORIGINS`는 개발 전용이라 운영에서는 설정하지 않습니다.

### 운영 환경변수 정리: `DEMO_*`는 서비스에 넣지 않습니다
`DEMO_STAFF_PASSWORD`, `DEMO_PASSCODE`는 **앱 서비스 환경변수에 넣지 않습니다.** 서버 코드(`server/src`)는 이 값을 읽지 않고, `scripts/demo-reset.ts`가 **실행할 때만** 읽습니다(데모 데이터는 아래 절차대로 사용자 PC에서 만듭니다). 비밀번호가 서비스에 계속 남아 있을 이유가 없습니다. 앱 서비스에 필요한 변수는 `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`뿐입니다(`PORT`는 Render가 넣음).

### 배포 서버에 데모 데이터 넣기
내 PC 터미널에서 Render Postgres의 **External Database URL**로 `demo:reset`을 실행합니다.

1. Render의 DB 화면에서 **External Database URL**을 찾습니다(Internal URL은 내 PC에서 접속되지 않음). 무료 DB가 외부 접속을 허용하는지, IP 허용 목록 기본값이 어떤지는 **미확인**입니다. 접속이 안 되면 DB 화면의 접근 설정을 확인하세요.
2. 내 PC 터미널(Git Bash)에서 실행합니다. 값은 `<…>` 자리에 직접 채웁니다.
   ```bash
   read -rs -p "외부 DB URL: " DATABASE_URL; export DATABASE_URL; echo   # 입력이 화면·기록에 남지 않음
   read -rs -p "교수자 비밀번호(8자 이상): " DEMO_STAFF_PASSWORD; export DEMO_STAFF_PASSWORD; echo
   NODE_ENV=production DEMO_PASSCODE=<6자리 숫자> npm run demo:reset
   unset DATABASE_URL DEMO_STAFF_PASSWORD                                  # 끝나면 반드시 지움
   ```
3. 출력되는 **시험 코드**로 학생 입장 주소(`https://<이름>.onrender.com/e/<시험 코드>`)를 만듭니다. 다시 실행할 때마다 코드가 바뀝니다.

주의:
- 이 PC의 `.env` 파일이 다른 DB를 가리킬 수 있습니다. 명령은 그 파일을 읽지만(`--env-file-if-exists`), Node는 **이미 설정된 환경변수를 파일 값보다 우선**합니다(임시 파일로 확인함). 그래도 위처럼 `DATABASE_URL`을 먼저 설정했는지, **대상 DB가 맞는지** 실행 전에 다시 확인하세요. 잘못된 DB면 그 DB의 데모 데이터를 지웁니다.
- `DEMO_PASSCODE`도 비밀 값이므로 명령줄에 적으면 셸 기록에 남습니다. 화면 공유를 끄고 실행하고, 끝난 뒤 기록에서 해당 줄을 확인하세요.
- 데모 데이터의 내용·삭제 범위는 [docs/DEMO.md](docs/DEMO.md) 2장을 봅니다.

### DB 30일 만료 대비 (새 DB로 옮기기)
무료 DB는 만든 지 30일 뒤 만료되고 백업이 없으므로, 시연·평가 기간이 30일을 넘길 것 같으면 만료 전에 옮깁니다.
1. 새 무료 Postgres를 같은 리전에 만듭니다.
2. 앱 서비스의 `DATABASE_URL`을 새 DB의 Internal URL로 바꾸고 재배포합니다(Start Command의 마이그레이션이 새 DB의 테이블을 만듭니다).
3. 위 "배포 서버에 데모 데이터 넣기"를 새 DB의 External URL로 다시 실행합니다.
4. 이전 DB의 채점·설문 결과는 옮기지 않습니다(필요하면 만료 전에 화면에서 따로 보관). 시험 코드는 새로 바뀌므로 제출 안내의 입장 주소를 갱신합니다.

### 배포 후 검증 체크리스트
위에서부터 순서대로 확인합니다. 기기는 **내 PC 1대 + 휴대폰(데이터 통신) 또는 다른 PC 1대**를 씁니다. 서비스가 잠들어 있으면 첫 요청이 약 1분 걸립니다.

| 순서 | 확인 | 이상하면 확인할 것 |
|---|---|---|
| 1 | `https://<이름>.onrender.com/api/health`가 200, `{"ok":true}` | Logs(시작 로그의 "서버를 시작할 수 없습니다": `JWT_SECRET` 길이·`DATABASE_URL`), 마이그레이션 실패 여부, Health Check Path |
| 2 | `/` 화면이 뜨고 `/staff/login`을 **새로고침해도** 화면이 나옴 | 빌드 로그(`npm ci && npm run build` 성공 여부), `client/dist` 생성 여부 |
| 3 | 교수자 로그인 성공(`demo@exam.local`). 개발자 도구 Application → Cookies에서 쿠키가 **Secure·HttpOnly** | 403 `FORBIDDEN_ORIGIN`이면 Origin 검사가 프록시의 Host·`X-Forwarded-Proto`와 맞지 않는 것(`NODE_ENV=production`, `https` 접속 여부) |
| 4 | **소켓 연결**: 교수자 [진행] 화면을 연 채 다른 기기에서 학생 입장 → 입장 현황이 **새로고침 없이** 바뀜 | Network의 `socket.io` 요청 상태(웹소켓 101 또는 폴링 200), 403이면 소켓 Origin 검사 |
| 5 | **로그인 IP 제한**: 아래 "로그인 IP 제한 확인" | 아래 참고 |
| 6 | 학생 한 판: 입장 → 동의 → 환경 점검 → 대기실 → (교수자 시작) → 답 입력·자동 저장 → 제출 → 설문 | 단계별 오류 문구와 서버 로그, 시나리오는 [docs/DEMO.md](docs/DEMO.md) 1장 |
| 7 | 교수자 [시험 종료] → 결과·설문 보기 → 끝나면 `demo:reset`으로 되돌림 | 되돌리지 않으면 평가자가 쓸 시험이 종료 상태로 남습니다 |

#### 로그인 IP 제한 확인 (프록시 홉 수)
커뮤니티 보고에 따르면 Render 프록시는 클라이언트가 보낸 `X-Forwarded-For`를 지우지 않고 **뒤에 덧붙입니다.** 프록시 홉 수는 공식 문서에서 확인하지 못했습니다(미확인). 서버는 운영에서 `trust proxy` 1을 씁니다. 틀리면 두 가지 문제가 생깁니다.
- **모두 한 IP로 묶임**(홉 수가 실제보다 적음): 내 PC에서 같은 이메일로 5회 틀린 뒤 **휴대폰 데이터에서도 막히면** 이 경우입니다.
- **헤더 위조로 한도 우회**(홉 수가 실제보다 많음): 같은 PC에서 `X-Forwarded-For`를 바꿔 가며 시도해도 막혀야 합니다.

위조 검증(데모 계정 이메일과 일부러 틀린 비밀번호를 쓰므로 비밀 값이 필요 없습니다):
```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<이름>.onrender.com/api/staff/login \
    -H "Content-Type: application/json" -H "X-Forwarded-For: 1.2.3.$i" \
    -d '{"email":"demo@exam.local","password":"wrong-password-<임의>"}'
done
```
- 위조 값을 바꿔도 **6번째에 429가 나와야** 안전합니다(IP+이메일당 15분 5회 실패 한도). 6번 모두 401이면 위조한 값이 IP로 쓰이는 것이므로 홉 수를 확인합니다. 로그인 경로·응답 코드는 배포 전에 로컬 서버에서 같은 명령으로 먼저 시험해 보세요(이 문서는 Render에서 실행해 보지 않았습니다).
- 휴대폰 데이터에서는 막히지 않아야 합니다. 막히면 `TRUST_PROXY_HOPS=2`로 올려 재배포한 뒤 다시 확인합니다(**변수가 코드에 반영된 경우에만**).
- 한 번 막히면 15분 동안 그 IP·이메일 조합이 막힙니다. **시연 직전에는 하지 마세요.** 서버 재시작으로 풀리는지는 미확인입니다.

### 운영 안내 (평가자·시연자에게 전달)
- **처음 접속이 느리면 1분 정도 기다리세요**(무료 서비스가 잠들어 있다가 깨어납니다). 시연 몇 분 전에 주소를 한 번 열어 깨워 두세요.
- **교수자는 시험 전에 미리 로그인해 두세요.** 로그인 시도는 IP 기준으로 제한됩니다(IP당 1분 20회, IP+이메일당 15분 5회 실패). 로그인이 **429로 막히면 다른 네트워크(휴대폰 데이터)** 를 쓰세요.
- **학생도 미리 입장하세요.** 같은 와이파이처럼 공용 IP를 쓰는 환경에서는 입장 시도 제한이 함께 계산됩니다. 시험 시작 직전에 한꺼번에 입장하지 말고 대기실에서 기다리게 합니다. (같은 내용이 [docs/DEMO.md](docs/DEMO.md)에도 있습니다.)

### 배포 URL 대상 E2E
```bash
PLAYWRIGHT_BASE_URL=https://<이름>.onrender.com DEMO_STAFF_PASSWORD=<교수자 비밀번호> DEMO_PASSCODE=<6자리 숫자> npm run e2e
```
**배포 서버의 데이터를 바꿉니다**(데모 시험 시작·종료, 학생01 응시·설문 생성, `[데모] 1분 마감 시험` 추가). 미리 `demo:reset`이 되어 있어야 하며, **시연 직전에는 실행하지 말고** 실행했다면 끝난 뒤 `demo:reset`으로 되돌립니다. 자세한 내용은 [docs/DEMO.md](docs/DEMO.md) 3장.

### 흔한 문제
| 증상 | 확인할 것 |
|---|---|
| 빌드가 실패하거나 Node 버전 오류 | 빌드 로그에서 쓰인 Node 버전(24 지원 여부 미확인). `.node-version`(24), `package.json`의 `engines`(`>=24`). 필요하면 `NODE_VERSION` 환경변수로 지정 |
| 서비스가 시작되지 않음 | Logs의 마이그레이션 오류(`DATABASE_URL`이 Internal URL인지, DB와 같은 리전인지), "서버를 시작할 수 없습니다" 줄(`JWT_SECRET` 없음·32자 미만) |
| 헬스체크 실패로 배포가 롤아웃되지 않음 | Health Check Path가 `/api/health`인지, Start Command가 위 값인지 |
| 첫 접속이 매우 느림·웹소켓이 바로 안 붙음 | 잠든 서비스가 깨어나는 중입니다(약 1분). 주소를 먼저 열어 깨운 뒤 다시 시도 |
| 웹소켓이 계속 안 붙음(입장 현황 갱신 안 됨) | Network의 `socket.io` 요청이 403인지(소켓 Origin 검사: `https`·도메인 확인). Render 웹 서비스는 웹소켓을 지원하는 것으로 알려져 있으나 실제 동작은 배포 뒤 확인(미확인) |
| 로그인이 403 `FORBIDDEN_ORIGIN` | `NODE_ENV=production`인지, 주소창이 배포 주소(https)와 같은지 |
| 모든 사용자가 한꺼번에 429 | 프록시 IP로 묶이는 경우. 위 "로그인 IP 제한 확인" |
| 어느 날 DB 접속 불가 | 무료 DB 30일 만료. "DB 30일 만료 대비" 절차 |

### 정리
- 무료라 비용은 0이지만 위 "무료 요금제의 제약"이 비용 대신의 제한입니다.
- 시연·평가가 끝나면 서비스와 DB를 삭제하거나 중지합니다. 메뉴 이름(서비스 Settings의 Suspend·Delete 등)은 **미확인**이므로 Render 화면에서 확인하세요.
- **백업이 없습니다.** DB를 삭제하거나 만료되면 데이터는 복구되지 않습니다. 필요한 결과(채점·설문)는 미리 화면에서 보관하세요. 데모 데이터는 `demo:reset`으로 언제든 다시 만들 수 있습니다.
