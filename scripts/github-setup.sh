#!/usr/bin/env bash
# GitHub 저장소 초기 설정. **사용자가 직접 실행한다** (Claude Code 프롬프트에서 `! bash scripts/github-setup.sh`).
# 브랜치 보호 변경은 하네스 훅이 에이전트에게 금지하므로, 사람만 이 스크립트로 바꾼다.
# 전제: gh auth login 완료, 저장소가 이미 생성·push됨, 현재 폴더가 저장소 루트.
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "대상 저장소: $REPO"

echo "== 라벨"
label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null; echo "  $1"; }
label "status:ready"       "c5def5" "의존 작업 완료, 시작 가능"
label "status:in-progress" "fbca04" "Operator 작업 중 (중복 할당 금지)"
label "status:review"      "0e8a16" "PR 리뷰·CI 대기"
label "status:blocked"     "b60205" "재시도 한도 초과 또는 사용자 판단 대기"
label "status:done"        "5319e7" "병합 완료"
label "plan-0"             "ededed" "계획 0: 감지 실험"
label "plan-1"             "ededed" "계획 1: 핵심 시험 흐름"
label "area:server"        "1d76db" "서버"
label "area:client"        "1d76db" "클라이언트"
label "area:infra"         "1d76db" "빌드·배포·CI"
label "critical-review"    "d93f0b" "Opus 보안 리뷰 필수, CI review-gate 적용"
label "model:haiku"        "bfdadc" "Operator 모델"
label "model:sonnet"       "bfdadc" "Operator 모델"
label "docs-approved"      "000000" "보호 문서 변경 승인 (사용자만 부착)"

echo "== 마일스톤"
ms() { gh api "repos/$REPO/milestones" -f title="$1" -f due_on="$2" -f description="$3" >/dev/null 2>&1 && echo "  $1" || echo "  $1 (이미 있음)"; }
ms "계획 0: 감지 실험"     "2026-11-29T23:59:59Z" "docs/superpowers/plans/2026-11-25-plan-0-detection-lab.md"
ms "계획 1: 핵심 시험 흐름" "2026-12-04T23:59:59Z" "docs/superpowers/plans/2026-11-25-plan-1-core-exam-flow.md"

echo "== main 브랜치 보호 (ruleset)"
gh api -X POST "repos/$REPO/rulesets" --input - <<'JSON' >/dev/null
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "protected-files" },
          { "context": "review-gate" },
          { "context": "test" } ] } }
  ]
}
JSON
echo "  protect-main 적용 (우회 허용 대상 없음 = 저장소 소유자도 우회 불가)"
echo "완료. 확인: gh api repos/$REPO/rulesets"
