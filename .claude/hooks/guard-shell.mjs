// PreToolUse 훅: Bash·PowerShell 명령으로 보호 대상(문서·하네스 설정·비밀값·브랜치 보호)을
// 우회하는 것을 막는다. Edit 도구는 settings.json 권한 규칙이 담당하고, 이 훅은 셸 경로를 담당한다.
// 한계: 명령 문자열만 본다. 경로를 문자열로 드러내지 않는 스크립트(예: 인자로 받은 폴더 안의 파일 수정)는
// 잡지 못한다 → CI의 protected-files 검사와 사람의 병합 승인으로 보완한다(docs/harness/VERIFICATION.md).

const PROTECTED_DOCS = [
  'docs/prd.md',
  'docs/spec.md',
  'docs/decisions.md',
  'claude.md',
  '.claude/settings.json',
  '.claude/hooks/',
  '.claude/agents/',
  '.github/workflows/',
];

// 파일을 바꿀 수 있는 명령의 흔적 (bash + PowerShell)
const WRITE_HINTS = [
  />(?!=)/, /\bsed\s+-i/, /\btee\b/, /\bmv\b/, /\bcp\b/, /\brm\b/, /\btruncate\b/, /\bdd\b/,
  /\bpython\d?(\.exe)?\b/, /\bnode\b/, /\bperl\b/, /\bawk\b/, /\bruby\b/,
  /\bgit\s+(checkout|restore|mv|rm|apply|am|stash\s+pop|reset)\b/,
  /\b(set-content|add-content|out-file|copy-item|move-item|remove-item|rename-item|new-item)\b/,
  /\[io\.file\]::write/,
];

const DENY_RULES = [
  { re: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|--force-with-lease)/, why: '강제 push는 금지입니다.' },
  { re: /\bgit\s+push\b[^\n]*(\s|:)(main|master)(\s|$)/, why: 'main 브랜치 직접 push는 금지입니다. 작업 브랜치와 PR을 쓰세요.' },
  { re: /\bgh\s+pr\s+merge\b[^\n]*--admin/, why: '관리자 권한 병합(--admin)은 금지입니다.' },
  { re: /(rulesets|\/protection\b|github-setup)/, why: '브랜치 보호 설정 변경은 사람만 합니다(scripts/github-setup.sh를 사용자가 직접 실행).' },
  { re: /--no-verify\b/, why: 'git 훅 우회(--no-verify)는 금지입니다.' },
  { re: /docs-approved/, why: '"docs-approved" 라벨은 사용자만 붙입니다.' },
  { re: /(^|[\s"'`=<>\/\\(])\.env(\.(local|development|production|test)(\.local)?)?(?=$|[\s"'`;|)&])/, why: '.env 비밀값 파일 접근은 금지입니다(.env.example만 허용).' },
];

const ASK_RULES = [
  { re: /\bgh\s+pr\s+merge\b/, why: 'PR 병합은 사용자 승인이 필요합니다(CI·리뷰 결과를 확인하세요).' },
];

export function decide(command) {
  const cmd = String(command || '').replace(/\\/g, '/').toLowerCase();
  for (const r of DENY_RULES) if (r.re.test(cmd)) return { decision: 'deny', reason: r.why };
  const touchesProtected = PROTECTED_DOCS.some((p) => cmd.includes(p));
  if (touchesProtected && WRITE_HINTS.some((h) => h.test(cmd))) {
    return { decision: 'ask', reason: '보호 문서·하네스 설정을 셸로 변경하려 합니다. 사용자 승인이 필요합니다(SPEC·ADR 임의 변경 금지).' };
  }
  for (const r of ASK_RULES) if (r.re.test(cmd)) return { decision: 'ask', reason: r.why };
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');
  const result = decide(input?.tool_input?.command);
  if (!result) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: `[guard-shell] ${result.reason}`,
    },
  }));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('guard-shell.mjs')) {
  main().catch((e) => { process.stderr.write(String(e)); process.exit(2); });
}
