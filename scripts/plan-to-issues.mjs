// 계획서(Task 섹션)를 GitHub 이슈(Operator 작업 지시서, .github/ISSUE_TEMPLATE/task.md 양식)로 만든다.
// 사용: node scripts/plan-to-issues.mjs <계획서.md> <plan번호> <마일스톤 제목> [--dry-run]
// 이미 같은 제목의 이슈가 있으면 건너뛴다(중복 생성 방지).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [planPath, planNo, milestone, flag] = process.argv.slice(2);
const dry = flag === '--dry-run';
const GH = process.env.GH_BIN || 'gh';
const text = readFileSync(planPath, 'utf8').replace(/\r\n/g, '\n');

// 배정 표: 계획 1의 "실행 순서" 표에서 작업별 묶음·모델·critical 여부를 읽는다
const assign = {};
for (const line of text.split('\n')) {
  const m = line.match(/^\|\s*([A-E])\s*\(([^)]*)\)\s*\|\s*([^|]+)\|\s*([^|]+)\|/);
  if (!m) continue;
  const [, group, mode, tasks, who] = m;
  for (const t of tasks.split(/[→·]/).map((s) => s.trim()).filter(Boolean)) {
    const id = t.replace(/🔒|\(.*?\)/g, '').trim();
    const haiku = new RegExp(`\\b${id}\\s*:\\s*Haiku`, 'i').test(who);
    assign[id] = { group, mode: mode.trim(), critical: t.includes('🔒'), model: haiku ? 'haiku' : 'sonnet', coordinator: /Coordinator/.test(who) };
  }
}

// 마지막 작업 뒤의 "## ..." 절(실행 순서 등)이 섞이지 않도록 작업 섹션을 다음 "## " 제목에서 자른다
const sections = text.split(/\n(?=### Task )/).filter((s) => s.startsWith('### Task ')).map((s) => s.split(/\n## /)[0]);
const specLine = (text.match(/\*\*Spec:\*\*\s*(.+)/) || [])[1] || '';

function block(sec, header) {
  const m = sec.match(new RegExp(`\\*\\*${header}:\\*\\*\\n([\\s\\S]*?)(?=\\n\\*\\*[A-Za-z]+:\\*\\*|\\n- \\[ \\]|$)`));
  return m ? m[1].trim() : '(계획서 참고)';
}

const existing = dry ? [] : JSON.parse(execFileSync(GH, ['issue', 'list', '--state', 'all', '--limit', '200', '--json', 'title'], { encoding: 'utf8' })).map((i) => i.title);

for (const sec of sections) {
  const head = sec.split('\n')[0];
  const [, id, name] = head.match(/^### Task (\S+?):\s*(.+)$/) || [];
  if (!id) continue;
  const a = assign[id] || { group: '-', mode: '-', critical: false, model: 'sonnet', coordinator: false };
  const title = `[계획${planNo}-Task${id}] ${name.trim()}`;
  if (existing.includes(title)) { console.log(`건너뜀(이미 있음): ${title}`); continue; }
  const steps = (sec.match(/- \[ \] \*\*Step[^\n]*(\n(?!- \[ \])[^\n]*)*/g) || []).map((s) => s.trim());
  const testStep = steps.find((s) => /실패하는 테스트|Step 1/.test(s)) || '(계획서 Step 참고)';
  const runCmds = [...sec.matchAll(/Run:\s*`([^`]+)`/g)].map((m) => m[1]);
  const body = `## 작업 ID와 목표
- 작업 ID: \`계획${planNo}-Task${id}\` (브랜치 \`task/p${planNo}-t${id.toLowerCase()}\`)
- 계획서: \`${planPath.replace(/\\/g, '/')}\` — Task ${id} (Operator 전달 시 \`task-brief\`로 이 작업만 추출)
- 목표: ${name.trim()}

## 참조 문서 (이것만 읽는다)
- 해당 기능: ${[...new Set((sec.match(/F-\d+/g) || []))].join(', ') || '(기반 작업 — 아래 문서의 관련 절)'} — \`docs/SPEC.md\` 6장의 해당 기능 절과 완료 조건
- ${specLine}
- 계획서 Task ${id}의 **Interfaces** (선행 작업의 함수·타입 이름)

## 수정 허용 파일과 범위
${block(sec, 'Files')}

## 금지 사항
- 위 목록 밖 파일 수정 금지 (필요하면 NEEDS_CONTEXT로 보고)
- 보호 문서(\`docs/PRD.md\`, \`docs/SPEC.md\`, \`docs/DECISIONS.md\`, \`CLAUDE.md\`, \`.claude/**\`, \`.github/workflows/**\`) 변경 금지 — 편집 도구·셸·스크립트 모두
- \`.env\` 읽기·생성 금지, push·PR·병합·라벨 변경 금지 (Coordinator 담당)

## 완료 조건
${steps.map((s) => s.replace(/^- \[ \] /, '- [ ] ')).join('\n')}

## 필수 테스트
${testStep.replace(/^- \[ \] /, '')}
${runCmds.length ? '```\n' + [...new Set(runCmds)].join('\n') + '\n```' : ''}

## 결과 보고 형식
\`.claude/agents/operator.md\`의 "보고 형식"을 따른다.

## 하네스 배정
- 묶음: ${a.group} (${a.mode}) · 담당: ${a.coordinator ? 'Coordinator 직접' : 'Operator'}
- Operator 모델: ${a.model} · Reviewer: ${a.critical ? 'opus (중요-리뷰)' : 'sonnet'}
`;
  const labels = ['상태:준비', `계획-${planNo}`, `모델:${a.model}`];
  if (a.critical) labels.push('중요-리뷰');
  if (/client\//.test(block(sec, 'Files'))) labels.push('영역:클라이언트');
  if (/server\/|prisma/.test(block(sec, 'Files'))) labels.push('영역:서버');
  if (/railway|docker|workflow|package\.json|e2e\//i.test(block(sec, 'Files'))) labels.push('영역:인프라');
  if (dry) { console.log(`---- ${title}\nlabels: ${labels.join(', ')}\n${body}`); continue; }
  const args = ['issue', 'create', '--title', title, '--body', body, '--milestone', milestone];
  for (const l of labels) args.push('--label', l);
  const url = execFileSync(GH, args, { encoding: 'utf8' }).trim();
  console.log(`생성: ${title} → ${url}`);
}
