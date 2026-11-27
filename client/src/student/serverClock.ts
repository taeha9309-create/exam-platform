/**
 * 서버 시계. 학생 PC 시계가 틀려도 마감·남은 시간이 정확하도록, 서버가 보낸 serverNow를 받은 순간의
 * 학생 시계와의 차이(오프셋)를 기억해 두고 now()에 더한다(SPEC F-11). 마감 계산에는 이 시계만 쓴다.
 */
export function createServerClock(serverNow: number, receivedAt: number = Date.now()): { now(): number } {
  const offset = serverNow - receivedAt;
  return { now: () => Date.now() + offset };
}
