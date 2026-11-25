// 대화형 세션 비용 모니터링(강제 한도 아님). 헤드리스 강제 한도는 `claude -p --max-budget-usd`.
let raw = '';
for await (const c of process.stdin) raw += c;
try {
  const s = JSON.parse(raw);
  const cost = Number(s?.cost?.total_cost_usd ?? 0).toFixed(2);
  const min = Math.round(Number(s?.cost?.total_duration_ms ?? 0) / 60000);
  process.stdout.write(`${s?.model?.display_name ?? '?'} | 세션 비용 $${cost} | ${min}분`);
} catch {
  process.stdout.write('statusline: 입력 없음');
}
