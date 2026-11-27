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

`PORT`는 Railway가 자동으로 넣어 주고, Node 버전은 `package.json`의 `engines`와 `.node-version`으로 지정합니다(빌드 로그에서 24가 쓰였는지 확인하세요). 프록시 뒤에서 클라이언트 IP를 읽도록 운영(`NODE_ENV=production`)에서만 `trust proxy`가 켜집니다.
