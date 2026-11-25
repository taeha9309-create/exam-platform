import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './guard-shell.mjs';

const d = (c) => decide(c)?.decision ?? 'allow';

test('보호 문서 읽기는 허용', () => {
  assert.equal(d('cat docs/SPEC.md'), 'allow');
  assert.equal(d('grep -n F-11 docs/SPEC.md'), 'allow');
  assert.equal(d('Get-Content docs\\SPEC.md'), 'allow');
});

test('보호 문서 셸 변경은 승인 요청(ask)', () => {
  assert.equal(d("sed -i 's/a/b/' docs/SPEC.md"), 'ask');
  assert.equal(d('echo x >> docs/DECISIONS.md'), 'ask');
  assert.equal(d('python fix.py docs/PRD.md'), 'ask');
  assert.equal(d('git checkout -- docs/SPEC.md'), 'ask');
  assert.equal(d("Set-Content docs\\SPEC.md 'x'"), 'ask');
  assert.equal(d('cp other.md docs/spec.md'), 'ask');
  assert.equal(d('node -e "require(\'fs\').writeFileSync(\'.claude/settings.json\',\'{}\')"'), 'ask');
  assert.equal(d('rm .claude/hooks/guard-shell.mjs'), 'ask');
});

test('경로를 드러내지 않는 간접 수정은 잡지 못함(알려진 한계, CI가 보완)', () => {
  assert.equal(d('python scripts/tool.py .'), 'allow');
});

test('.env 접근 거부, .env.example은 허용', () => {
  assert.equal(d('cat .env'), 'deny');
  assert.equal(d('type server/.env.local'), 'deny');
  assert.equal(d('Get-Content .env.production'), 'deny');
  assert.equal(d('cat .env.example'), 'allow');
  assert.equal(d('cp .env.example .env'), 'deny');
});

test('브랜치 보호 우회 거부', () => {
  assert.equal(d('git push origin main'), 'deny');
  assert.equal(d('git push origin HEAD:main'), 'deny');
  assert.equal(d('git push --force origin task/3'), 'deny');
  assert.equal(d('git push -f'), 'deny');
  assert.equal(d('gh pr merge 12 --squash --admin'), 'deny');
  assert.equal(d('gh api -X PUT repos/o/r/rulesets/1'), 'deny');
  assert.equal(d('gh api repos/o/r/branches/main/protection'), 'deny');
  assert.equal(d('bash scripts/github-setup.sh'), 'deny');
  assert.equal(d('git commit --no-verify -m x'), 'deny');
  assert.equal(d('gh pr edit 3 --add-label 문서변경-승인'), 'deny');
});

test('전체 경로·확장자로 실행해도 같은 규칙 적용 (PR #1에서 발견한 구멍)', () => {
  assert.equal(d('"/c/Program Files/GitHub CLI/gh.exe" pr merge 1 --squash'), 'deny');
  assert.equal(d('"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 1 --admin'), 'deny');
  assert.equal(d('GH="/c/Program Files/GitHub CLI/gh.exe"; "$GH" pr list'), 'allow');
  assert.equal(d('GH=/x/gh.exe; "$GH" pr merge 3 --squash'), 'deny');
  assert.equal(d('gh api -X PUT repos/o/r/pulls/3/merge'), 'deny');
  assert.equal(d('/usr/bin/git push origin main'), 'deny');
  assert.equal(d('"C:/Program Files/Git/cmd/git.exe" push -f'), 'deny');
});

test('작업 브랜치 push·PR 생성·상태 라벨 변경은 허용, 병합은 모든 경로 거부 (D-023)', () => {
  assert.equal(d('git push -u origin task/plan1-t3'), 'allow');
  assert.equal(d('gh pr create --base main --head task/p1-t3 --body-file b.md'), 'allow');
  assert.equal(d('gh issue edit 9 --add-label 상태:진행중'), 'allow');
  assert.equal(d('gh pr merge 12 --squash --delete-branch'), 'deny');
  assert.equal(d('gh pr merge 12 --auto --squash'), 'deny');
  assert.equal(d("gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'"), 'deny');
  assert.equal(d("gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}){clientMutationId}}'"), 'deny');
  assert.equal(d("gh api graphql -f query='mutation{addLabelsToLabelable(input:{labelableId:\"x\",labelIds:[\"y\"]}){clientMutationId}}'"), 'deny');
  assert.equal(d('gh api repos/o/r/pulls/3/merge -X PUT -f merge_method=squash'), 'deny');
});
