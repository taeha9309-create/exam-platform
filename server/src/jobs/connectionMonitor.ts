import { DISCONNECT_GRACE_MS, HEARTBEAT_GAP_MS } from '@exam/shared';
import { prisma } from '../db';
import { detectNetworkIncident } from '../domain/signals';
import { broadcast } from '../realtime/broadcast';
import { loadNetworkInputs, NETWORK_WATCH_STATES, type NetworkIncident } from '../services/dashboard';
import { recordServerSignal } from '../services/signals';

/**
 * 연결 감시와 네트워크 장애 묶음(SPEC 5.5, F-13).
 *
 * - 소켓 연결·끊김은 socket.ts가 studentSocketConnected/Disconnected로 알린다(프로세스 메모리의 연결 장부).
 * - 끊긴 뒤 DISCONNECT_GRACE_MS 안에 돌아오면 DISCONNECT 없이 RECONNECT만, 넘기면 DISCONNECT 1건(돌아오면 RECONNECT도).
 * - 연결돼 있는데 하트비트가 HEARTBEAT_GAP_MS 넘게 없으면 HEARTBEAT_GAP(갭 하나에 1건, 하트비트가 돌아오면 다음 갭을 다시 기록).
 * - 한 점검에서 같은 시험의 DISCONNECT·HEARTBEAT_GAP이 함께 나오면 장애 묶음 판정(detectNetworkIncident)에 넣고,
 *   묶음에 든 응시의 신호는 저장하되 unackedSeverity를 올리지 않는다. 묶음의 현재 값은 DB의 최근 신호로 계산하므로
 *   스냅샷(dashboard.ts)과 같은 값이고, 값이 바뀔 때만(해제는 null) network:incident를 보낸다.
 * - 서버 재시작 직후에는 장부가 비어 있다. 장부에 없는 진행 중 응시는 "처음 본 시각"부터 유예를 센다(첫 점검에서 곧바로 DISCONNECT 하지 않음).
 *
 * 동시성: 신호 저장은 recordServerSignal(응시 행 FOR UPDATE 뒤 시각 결정)을 그대로 쓴다. 이 모듈은 시험 행을 잠그지 않는다.
 * 알림은 recordServerSignal이 커밋 뒤에 보낸다.
 */

export const CONNECTION_CHECK_INTERVAL_MS = 1000;

interface Entry {
  sockets: number;
  /** 소켓이 0개가 된(또는 장부에 처음 들어온) 시각(ms). 연결 중이면 null */
  offlineSince: number | null;
  /** 장부에 처음 들어온 시각이 서버 재시작 후 "처음 본 시각"인가(실제 끊김 시각이 아니다). RECONNECT를 남기지 않는다. */
  assumed: boolean;
  disconnectRecorded: boolean;
  /** 마지막으로 연결된(소켓 수가 0→1이 된) 시각 */
  connectedAt: number;
  /** 이미 HEARTBEAT_GAP을 남긴 갭의 기준 시각(없으면 null). 기준이 바뀌면(하트비트 수신·재연결) 새 갭이다. */
  gapRecordedFor: number | null;
}

let active: { clock: () => number; book: Map<string, Entry>; lastIncident: Map<string, NetworkIncident> } | null = null;

/** 학생 소켓 하나가 연결됐다. 감시가 돌고 있지 않으면 무시한다. 끊김 뒤 돌아온 것이면 RECONNECT를 남긴다. */
export async function studentSocketConnected(attemptId: string): Promise<void> {
  const a = active;
  if (!a) return;
  const nowMs = a.clock();
  const e = a.book.get(attemptId);
  if (!e) {
    a.book.set(attemptId, { sockets: 1, offlineSince: null, assumed: false, disconnectRecorded: false, connectedAt: nowMs, gapRecordedFor: null });
    return;
  }
  e.sockets += 1;
  if (e.sockets > 1) return;
  const offlineMs = e.offlineSince === null ? 0 : Math.max(0, nowMs - e.offlineSince);
  const report = !e.assumed || e.disconnectRecorded;
  e.offlineSince = null;
  e.assumed = false;
  e.disconnectRecorded = false;
  e.connectedAt = nowMs;
  e.gapRecordedFor = null;
  if (report) await recordServerSignal(attemptId, 'RECONNECT', { offlineMs }, () => new Date(a.clock()));
}

/** 학생 소켓 하나가 끊겼다. 응시의 소켓이 모두 없어지면 그때부터 유예를 센다. */
export function studentSocketDisconnected(attemptId: string): void {
  const a = active;
  const e = a?.book.get(attemptId);
  if (!a || !e || e.sockets === 0) return;
  e.sockets -= 1;
  if (e.sockets === 0) {
    e.offlineSince = a.clock();
    e.assumed = false;
    e.disconnectRecorded = false;
  }
}

export interface CheckDeps {
  log: (...args: unknown[]) => void;
}

const sameIncident = (a: NetworkIncident | undefined, b: NetworkIncident | null): boolean =>
  !a || !b ? !a && !b : a.count === b.count && a.since === b.since && a.attemptIds.length === b.attemptIds.length && a.attemptIds.every((id) => b.attemptIds.includes(id));

/**
 * 점검 1회. 응시별 오류는 로그만 남기고 나머지를 계속한다.
 * @param nowMs 가짜 시계를 받을 수 있게 숫자로 받는다.
 */
export async function checkConnections(nowMs: number, deps: Partial<CheckDeps> = {}): Promise<void> {
  const a = active;
  if (!a) return;
  const { log = (...args: unknown[]) => console.error(...args) } = deps;
  const lastIncident = a.lastIncident; // 마지막으로 보낸 장애 묶음(시험별). 값이 바뀔 때만 보낸다.
  const now = new Date(nowMs);

  const rows = await prisma.attempt.findMany({
    where: { state: { in: NETWORK_WATCH_STATES }, exam: { status: 'RUNNING' } },
    select: { id: true, examId: true, lastHeartbeatAt: true },
  });
  const alive = new Set(rows.map((r) => r.id));
  // 종료·제출된 응시는 감시하지 않는다. 소켓이 남아 있는 항목은 둔다(대기실에서 연결한 학생이 시작 뒤에 장부에 없어 끊긴 것으로 보이면 안 된다).
  for (const [id, e] of a.book) if (!alive.has(id) && e.sockets === 0) a.book.delete(id);

  type Due = { attemptId: string; examId: string; type: 'DISCONNECT' | 'HEARTBEAT_GAP'; meta: object; commit: () => void };
  const due: Due[] = [];
  for (const r of rows) {
    let e = a.book.get(r.id);
    if (!e) {
      // 장부에 없다 = 이 프로세스가 처음 본다(서버 재시작 직후 등). 지금부터 유예를 센다.
      e = { sockets: 0, offlineSince: nowMs, assumed: true, disconnectRecorded: false, connectedAt: nowMs, gapRecordedFor: null };
      a.book.set(r.id, e);
    }
    const entry = e;
    if (entry.sockets === 0) {
      if (entry.offlineSince !== null && !entry.disconnectRecorded && nowMs - entry.offlineSince >= DISCONNECT_GRACE_MS) {
        const offlineMs = nowMs - entry.offlineSince;
        due.push({ attemptId: r.id, examId: r.examId, type: 'DISCONNECT', meta: { offlineMs }, commit: () => (entry.disconnectRecorded = true) });
      }
      continue;
    }
    const reference = Math.max(r.lastHeartbeatAt?.getTime() ?? 0, entry.connectedAt);
    if (nowMs - reference >= HEARTBEAT_GAP_MS && entry.gapRecordedFor !== reference) {
      due.push({ attemptId: r.id, examId: r.examId, type: 'HEARTBEAT_GAP', meta: { gapMs: nowMs - reference }, commit: () => (entry.gapRecordedFor = reference) });
    }
  }

  // 같은 시험의 이번 점검 분량과 최근 신호를 합쳐 장애 묶음을 먼저 판정한다(묶음에 든 응시는 severity를 올리지 않는다).
  const inputs = await loadNetworkInputs(now);
  const suppress = new Set<string>();
  for (const examId of new Set(due.map((d) => d.examId))) {
    const input = inputs.get(examId);
    if (!input) continue;
    const events = [...input.events, ...due.filter((d) => d.examId === examId).map((d) => ({ attemptId: d.attemptId, at: nowMs }))];
    const incident = detectNetworkIncident(events, input.total, nowMs);
    for (const id of incident?.attemptIds ?? []) suppress.add(id);
  }

  for (const d of due) {
    try {
      await recordServerSignal(d.attemptId, d.type, d.meta, () => new Date(a.clock()), { suppressSeverity: suppress.has(d.attemptId) });
      d.commit();
    } catch (err) {
      log('연결 감시 신호 저장 실패(다음 점검에 다시 시도)', d.attemptId, err instanceof Error ? err.message : 'unknown');
    }
  }

  // 커밋 뒤의 DB 값으로 장애 묶음을 다시 계산해 바뀐 시험에만 보낸다(해제 = null).
  try {
    const after = await loadNetworkInputs(now);
    for (const [examId, input] of after) {
      const incident = detectNetworkIncident(input.events, input.total, nowMs);
      if (sameIncident(lastIncident.get(examId), incident)) continue;
      if (incident) lastIncident.set(examId, incident);
      else lastIncident.delete(examId);
      broadcast.networkIncident(examId, incident);
    }
    for (const examId of [...lastIncident.keys()]) {
      if (after.has(examId)) continue; // 시험이 끝났거나 감시 대상이 없어졌다: 해제
      lastIncident.delete(examId);
      broadcast.networkIncident(examId, null);
    }
  } catch (err) {
    log('네트워크 장애 묶음 전송 실패(다음 점검에 다시 시도)', err instanceof Error ? err.message : 'unknown');
  }
}

export interface MonitorOptions {
  intervalMs?: number;
  now?: () => Date;
  log?: (...args: unknown[]) => void;
  /** 테스트용: 점검 함수를 바꿔 끼운다. */
  check?: (nowMs: number) => Promise<void>;
}

/**
 * 연결 감시를 시작한다. 이전 점검이 끝나지 않았으면 이번 틱은 건너뛰고(겹침 없음), 예외는 로그만 남긴다.
 * 타이머는 unref되어 프로세스 종료를 막지 않는다. stop()은 타이머를 멈추고 진행 중 점검을 기다린 뒤 장부를 비운다.
 */
export function startConnectionMonitor(options: MonitorOptions = {}): { stop(): Promise<void> } {
  const { intervalMs = CONNECTION_CHECK_INTERVAL_MS, now = () => new Date(), log = (...args: unknown[]) => console.error(...args) } = options;
  const mine = { clock: () => now().getTime(), book: new Map<string, Entry>(), lastIncident: new Map<string, NetworkIncident>() };
  active = mine;
  const check = options.check ?? ((nowMs: number) => checkConnections(nowMs, { log }));
  let running: Promise<void> | null = null;
  let stopped = false;

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = (async () => {
      try {
        await check(mine.clock());
      } catch (err) {
        log('연결 감시 오류', err instanceof Error ? err.message : 'unknown');
      }
    })().finally(() => {
      running = null;
    });
  }, intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      if (active === mine) active = null;
      mine.book.clear();
    },
  };
}
