/**
 * 객관식 채점: 정답이면 배점, 오답·미답(null)은 0점.
 * 미답 문항은 Answer 행이 없을 수도 있으므로, 호출하는 쪽은 행이 없는 문항을 0점으로 본다(행을 만들지 않는다).
 */
export function gradeMcq(q: { points: number; correctChoiceId: string }, choiceId: string | null): number {
  if (choiceId === null || q.correctChoiceId === '') return 0;
  return choiceId === q.correctChoiceId ? q.points : 0;
}
