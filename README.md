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

| 명령 | 설명 |
|---|---|
| `npm test` | 모든 작업 공간의 테스트 |
| `npm run typecheck` | 모든 작업 공간의 타입 검사 |
| `npm run build` | 화면(`client/dist`)과 서버(`server/dist`) 빌드 |
| `npm run db:down` | PostgreSQL 종료 |

개발 중에는 화면 개발 서버가 `/api`, `/socket.io` 요청을 서버(3000)로 넘긴다. 운영에서는 서버가 빌드된 화면을 같은 주소로 제공한다.

## 브랜치와 병합
`main`은 보호되어 있다. 작업 브랜치(`task/...`)에서 PR을 만들고, 필수 검사(`protected-files`, `review-gate`, `test`)를 통과한 뒤 **사용자가 직접 병합**한다.
