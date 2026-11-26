/**
 * 학생별 마감 시각 = 시험 종료 시각 + 응시별 추가 시간 (SPEC 2.2).
 * 원본 Date는 바꾸지 않고 새 Date를 돌려준다.
 */
export function attemptDeadline(endsAt: Date, extraSeconds: number): Date {
  return new Date(endsAt.getTime() + extraSeconds * 1000);
}

/** 마감까지 남은 밀리초. 이미 지났으면 0 */
export function remainingMs(deadline: Date, now: Date): number {
  return Math.max(0, deadline.getTime() - now.getTime());
}
