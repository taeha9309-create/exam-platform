import {
  LEAVE_VIOLATION_MS,
  NETWORK_INCIDENT_MIN_COUNT,
  NETWORK_INCIDENT_MIN_RATIO_COUNT,
  NETWORK_INCIDENT_RATIO,
  NETWORK_INCIDENT_WINDOW_MS,
  VIOLATION_LIMIT,
  type AttemptState,
  type Severity,
  type SignalSeverity,
  type SignalType,
} from '@exam/shared';

/** 이탈 15초 초과는 ALERT (SPEC 5.4) */
const LEAVE_ALERT_MS = 15000;

const SEVERITY_RANK: Record<Severity, number> = { NONE: 0, INFO: 1, WARN: 2, ALERT: 3 };

/** 신호 자체의 위험도 (SPEC 5.4). 순수 함수 */
export function signalSeverity(type: SignalType, durationMs?: number | null): SignalSeverity {
  switch (type) {
    case 'LEAVE': {
      const ms = durationMs ?? 0;
      if (ms > LEAVE_ALERT_MS) return 'ALERT';
      if (ms >= LEAVE_VIOLATION_MS) return 'WARN';
      return 'INFO';
    }
    case 'RECONNECT':
    case 'SIDEBAR_SUSPECT':
      return 'INFO';
    default:
      return 'WARN';
  }
}

/** 위반 횟수에 포함되는 신호인가 (SPEC 5.4, 5.7). ACTIVE 상태에서만 센다 */
export function countsAsViolation(
  type: SignalType,
  durationMs: number | null | undefined,
  state: AttemptState,
): boolean {
  if (state !== 'ACTIVE') return false;
  switch (type) {
    case 'LEAVE':
      return (durationMs ?? 0) >= LEAVE_VIOLATION_MS;
    case 'FULLSCREEN_EXIT':
    case 'PASTE':
    case 'DROP':
      return true;
    default:
      return false;
  }
}

/** 미확인 위험도 = 현재 값과 새 신호 중 높은 쪽 */
export function maxSeverity(current: Severity, incoming: SignalSeverity): Severity {
  return SEVERITY_RANK[incoming] > SEVERITY_RANK[current] ? incoming : current;
}

/** 네트워크 장애 의심 집계 대상 신호 (SPEC 5.5) */
export function isNetworkSignal(type: SignalType): boolean {
  return type === 'DISCONNECT' || type === 'HEARTBEAT_GAP' || type === 'SEQ_GAP';
}

/** 위반 누적이 5의 양의 배수가 되는 순간 자동 잠금 (SPEC 5.7) */
export function shouldAutoPause(newViolationCount: number): boolean {
  return newViolationCount > 0 && newViolationCount % VIOLATION_LIMIT === 0;
}

/**
 * 네트워크 장애 의심 판정 (SPEC 5.5). now 기준 최근 10초(경계 포함) 이벤트에서
 * 서로 다른 응시 수가 3명 이상이거나, 2명 이상이면서 전체 응시의 30% 이상이면 결과를 돌려준다.
 * 1명만으로는 장애가 아니다 (D-030).
 * 같은 응시의 반복 이벤트는 1명으로 센다.
 */
export function detectNetworkIncident(
  events: { attemptId: string; at: number }[],
  totalAttempts: number,
  now: number,
): { count: number; attemptIds: string[]; since: number } | null {
  const from = now - NETWORK_INCIDENT_WINDOW_MS;
  const ids = new Set<string>();
  let since = Infinity;
  for (const e of events) {
    if (e.at < from) continue;
    ids.add(e.attemptId);
    if (e.at < since) since = e.at;
  }
  const count = ids.size;
  if (count === 0) return null;
  const byCount = count >= NETWORK_INCIDENT_MIN_COUNT;
  const byRatio =
    count >= NETWORK_INCIDENT_MIN_RATIO_COUNT &&
    totalAttempts > 0 &&
    count / totalAttempts >= NETWORK_INCIDENT_RATIO;
  if (!byCount && !byRatio) return null;
  return { count, attemptIds: [...ids], since };
}
