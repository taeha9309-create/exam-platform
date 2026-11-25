# exam-platform — 프로젝트 규칙 (하네스)

강의실 시험 무결성 플랫폼. 대학 기말 프로젝트(1인), 스펙 주도 개발(SDD) + 하네스 엔지니어링 학습.
기준 문서: `docs/PRD.md` → `docs/SPEC.md` → `docs/superpowers/plans/*.md`. 결정과 근거: `docs/DECISIONS.md`(D-xxx, ADR-xxx).
이 파일의 규칙은 Superpowers 스킬의 기본값보다 우선한다.

## 1. 역할 (ADR-010)
| 역할 | 누가 | 모델 | 하는 일 |
|---|---|---|---|
| Coordinator | 메인 세션 (`/model sonnet`) | Sonnet | 상태 읽기, 의존성 판단, 작업 지시서 작성·위임, 결과 확인, PR·병합 요청, 상태 갱신, 사용자 보고 |
| Operator | `.claude/agents/operator.md` | Sonnet (1~2개 파일·완전한 명세의 단순 작업은 `model: haiku`) | 작업 하나 구현·테스트·커밋 |
| Reviewer | `.claude/agents/reviewer.md` | Sonnet (`중요-리뷰` 작업의 보안 검토는 `model: opus`) | SPEC·ADR 준수, 품질, 보안 판정 |
| Advisor | `.claude/agents/advisor.md` | Opus | 2회 실패 시 원인 분석·선택지 제안 |

- Coordinator는 구현을 직접 하지 않는다. 예외: 계획 0의 Task 1~3, 계획 1의 Task 1·2·17a(뼈대).
- 구현·리뷰 절차는 Superpowers `subagent-driven-development`를 따른다(작업 지시서는 `task-brief`로 해당 작업만 추출). 서브에이전트를 부를 때 **모델을 항상 명시**한다.

## 2. 작업 지시서 (Operator 입력 표준)
GitHub 이슈 = 작업 지시서. 양식: `.github/ISSUE_TEMPLATE/task.md`.
필수 항목: 작업 ID·목표 / 참조 SPEC 절·ADR / 수정 허용 파일과 범위 / 금지 사항 / 완료 조건 / 필수 테스트 / 결과 보고 형식.
**컨텍스트 최소화:** Operator에게는 이슈 본문 + `task-brief` 출력 + 지시서에 적힌 SPEC 절·ADR·의존 작업의 인터페이스만 준다. 문서 전체나 대화 기록을 넘기지 않는다.

## 3. 작업 상태 (ADR-011)
- 상태의 원본은 이슈 라벨: `상태:준비` → `상태:진행중` → `상태:리뷰` → `상태:완료` (`상태:보류`는 사용자 판단 대기).
- **중복 실행 방지:** `상태:진행중` 이슈나 같은 이름의 작업 브랜치(`task/<작업ID>`)가 있으면 그 작업을 다시 맡기지 않는다.
- 진행 세부(재시도, 판정, 통합 메모)는 Superpowers 진행 기록(`.superpowers/sdd/.../progress.md`)에 남긴다.
- 작업별 실행 기록은 PR 본문의 "하네스 기록" 표에 남긴다(모델, 상향 여부, 소요 시간, 재시도, 리뷰 판정, 병렬 충돌, 토큰).

## 4. Coordinator 사이클 (수동 1회 검증 후 `/loop`로 반복)
1. 상태 읽기: 열린 이슈·라벨, 진행 기록, `git worktree list`, 열린 PR과 CI 상태(`gh pr checks`).
2. 의존성 확인: 계획서의 "실행 순서" 표 기준으로 선행 작업이 `상태:완료`인 작업만 실행 가능.
3. 실행 가능한 작업을 Operator에게 할당(동시 최대 3, 같은 파일을 건드리는 작업은 동시에 맡기지 않음, `shared/`·`server/src/app.ts` 변경은 병합 때 Coordinator만).
4. Operator 보고 확인 → 브랜치 push → PR 생성(템플릿 채움) → Reviewer 호출 → 판정을 PR 댓글로 게시.
5. 병합 조건: CI 통과 + Reviewer `APPROVED`(critical은 Opus 판정) + 보호 문서 변경 없음(있으면 사용자가 `문서변경-승인` 라벨). 조건을 만족하면 `gh pr merge --squash --delete-branch`를 요청(사용자 승인 창이 뜬다).
6. 병합 후 이슈 `상태:완료`, 진행 기록 갱신.
7. **사용자에게 작업별 설명**: 무엇을 구현했고, 왜 그 기술을 택했는지(Operator 보고의 "기술 선택과 이유" 정리).
8. 목표 확인: 현재 계획의 모든 이슈가 `상태:완료`이면 루프 종료.
9. 아니면 대기 후 반복.

## 5. 재시도와 상향 (Superpowers 기본 5회 → 3회로 단축)
- 1~2회: 같은 Operator에게 리뷰 지적·테스트 실패를 주고 수정.
- 2회 실패 후: Advisor 호출 → 추천안으로 3회째 시도(필요하면 Operator 모델 한 단계 상향, PR에 기록).
- 3회째도 실패: 이슈 `상태:보류`, 사용자에게 보고하고 그 작업은 멈춘다.

## 6. 멈춤 조건 (루프 종료·일시정지)
- 사용자 승인이 필요한 상황(SPEC·ADR 변경, 중요한 기술 결정, 보호 문서 변경, 비용 한도 근접)
- 재시도 한도 초과로 `상태:보류` 발생
- 목표 달성(계획의 모든 이슈 완료)
- 비용 한도 도달: 대화형 세션은 상태줄의 세션 비용이 사용자가 정한 한도(`사이클당 $_`, 미정)를 넘으면 멈춤 — **모니터링일 뿐 강제 한도가 아님**. 강제 한도가 필요하면 헤드리스 `claude -p --max-budget-usd`.

## 7. 절대 금지 (Coordinator·Operator·Reviewer·Advisor 공통)
- `docs/PRD.md`, `docs/SPEC.md`, `docs/DECISIONS.md`를 사용자 승인 없이 변경(편집 도구·셸·스크립트 모두). 스펙과 구현이 다르면 사용자에게 묻는다.
- 중요한 기술 결정을 임의로 확정. ADR 초안까지만 쓰고 승인받는다.
- `main` 직접 push, 강제 push, `--admin` 병합, `--no-verify`, 브랜치 보호·ruleset 변경, `문서변경-승인` 라벨 부착.
- CI 실패 또는 필수 리뷰 전 병합.
- `.env` 등 비밀값 파일 읽기·출력·커밋. 운영 비밀값은 Railway·GitHub Secrets에만 둔다(사용자가 직접 입력).
- 하네스 설정(`CLAUDE.md`, `.claude/**`, `.github/workflows/**`)을 우회 목적으로 변경.

## 8. 작업 환경
- Windows 11, Git Bash와 PowerShell. Node 24 LTS(ADR-001). 로컬 DB는 Docker(ADR-003).
- 커밋 메시지는 한국어 요약 + 관례 접두어(`feat:`, `fix:`, `docs:`, `test:`, `chore:`), 이슈 번호 참조(`#N`).
- 안전장치 검증 절차와 남은 위험: `docs/harness/VERIFICATION.md`.
