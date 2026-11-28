// 감독 대시보드 상태 훅. 스냅샷(서버 DB가 원본)으로 시작해 변경분 이벤트만 적용한다(SPEC 7.2).
// 같은 이벤트가 두 번 와도 결과가 같도록 학번(studentNo) 기준으로 덮어쓰기만 한다.
import { EV, type AttemptSummary, type Severity, type SignalDto } from '@exam/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connectStaffSocket } from '../../../socket';
import { createServerClock } from '../../../student/serverClock';

export type ApprovalKind = 'LATE' | 'DUPLICATE';
export interface PendingApproval {
  attemptId: string;
  kind: ApprovalKind;
  studentNo: string | null;
  name: string | null;
}
export interface NetworkIncident {
  count: number;
  attemptIds: string[];
  since: number;
}
export interface DashboardExam {
  id: string;
  title: string;
  status: string;
  endsAt: number | null;
  lockNewEntry: boolean;
  serverNow: number;
  ready: number;
  total: number;
}
export type SortBy = 'STUDENT_NO' | 'NEEDS_ATTENTION';

const SEVERITY_RANK: Record<Severity, number> = { NONE: 0, INFO: 1, WARN: 2, ALERT: 3 };
const isKind = (k: unknown): k is ApprovalKind => k === 'LATE' || k === 'DUPLICATE';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const KNOWN_STATES = new Set(['WAITING', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'SUBMITTED', 'TERMINATED', 'REJECTED']);
// state가 null(미입장)이거나 아는 값이 아니면 카드로 만들지 않는다(배지 문구가 비는 것을 막는다)
const isSummary = (v: unknown): v is AttemptSummary =>
  isRecord(v) && typeof v.studentNo === 'string' && typeof v.name === 'string' && (v.state === null || (typeof v.state === 'string' && KNOWN_STATES.has(v.state)));

function parseIncident(v: unknown): NetworkIncident | null {
  if (!isRecord(v) || typeof v.count !== 'number' || !Array.isArray(v.attemptIds)) return null;
  return { count: v.count, attemptIds: v.attemptIds.filter((x): x is string => typeof x === 'string'), since: typeof v.since === 'number' ? v.since : 0 };
}

function parseApprovals(items: unknown): PendingApproval[] {
  if (!Array.isArray(items)) return [];
  const out: PendingApproval[] = [];
  for (const it of items) {
    if (!isRecord(it) || typeof it.attemptId !== 'string' || !isKind(it.kind)) continue;
    out.push({
      attemptId: it.attemptId,
      kind: it.kind,
      studentNo: typeof it.studentNo === 'string' ? it.studentNo : null,
      name: typeof it.name === 'string' ? it.name : null,
    });
  }
  return out;
}

/** 정렬: 학번순(기본) 또는 확인 필요순(`unackedSeverity` 높은 순 → 최근 신호 순 → 학번) */
export function sortCards(cards: AttemptSummary[], sortBy: SortBy): AttemptSummary[] {
  const byNo = (a: AttemptSummary, b: AttemptSummary) => a.studentNo.localeCompare(b.studentNo);
  const copy = [...cards];
  if (sortBy === 'STUDENT_NO') return copy.sort(byNo);
  return copy.sort((a, b) => {
    const d = SEVERITY_RANK[b.unackedSeverity] - SEVERITY_RANK[a.unackedSeverity];
    if (d !== 0) return d;
    const t = (b.lastSignal?.receivedAt ?? -1) - (a.lastSignal?.receivedAt ?? -1);
    return t !== 0 ? t : byNo(a, b);
  });
}

export function useDashboard(examId: string) {
  const [exam, setExam] = useState<DashboardExam | null>(null);
  const [attempts, setAttempts] = useState<Map<string, AttemptSummary>>(() => new Map());
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [networkIncident, setNetworkIncident] = useState<NetworkIncident | null>(null);
  /** 응시별 최근 신호 상세(`signal:new`). 요약 문구에 시간·글자 수를 넣는 데만 쓴다. */
  const [signals, setSignals] = useState<Map<string, SignalDto>>(() => new Map());
  const [ready, setReady] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [socketDown, setSocketDown] = useState(false);
  const [joinFailed, setJoinFailed] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('STUDENT_NO');
  const [query, setQuery] = useState('');
  const [clock, setClock] = useState<{ now(): number }>(() => ({ now: () => Date.now() }));
  // 열린 상세 패널이 `signal:new`를 받기 위한 구독 목록(소켓 핸들러는 이 훅이 하나만 건다)
  const signalListeners = useRef(new Set<(attemptId: string, signal: SignalDto) => void>());
  const subscribeSignals = useCallback((fn: (attemptId: string, signal: SignalDto) => void) => {
    signalListeners.current.add(fn);
    return () => void signalListeners.current.delete(fn);
  }, []);

  useEffect(() => {
    const socket = connectStaffSocket();
    const join = () => {
      setSocketDown(false);
      // 연결(재연결 포함)마다 스냅샷을 다시 요청한다. 결과는 dashboard:snapshot 이벤트로 온다.
      socket.emit(EV.DASHBOARD_JOIN, { examId }, (res: unknown) => setJoinFailed(isRecord(res) && res.ok === false));
    };
    socket.on('connect', join);
    socket.on('disconnect', () => setSocketDown(true));
    socket.on('connect_error', () => setSocketDown(true));
    socket.on(EV.DASHBOARD_SNAPSHOT, (snap: unknown) => {
      if (!isRecord(snap)) return;
      const list = Array.isArray(snap.attempts) ? snap.attempts.filter(isSummary) : [];
      setAttempts(new Map(list.map((a) => [a.studentNo, a])));
      setSignals(new Map());
      setApprovals(parseApprovals(snap.pendingApprovals));
      setNetworkIncident(parseIncident(snap.networkIncident));
      const e = snap.exam;
      if (isRecord(e) && typeof e.id === 'string') {
        setExam(e as unknown as DashboardExam);
        // 교수자 PC 시계가 틀려도 남은 시간이 서버 기준이 되도록 오프셋을 기억한다
        if (typeof e.serverNow === 'number') setClock(createServerClock(e.serverNow));
        if (typeof e.ready === 'number') setReady(e.ready);
        if (typeof e.total === 'number') setTotal(e.total);
      }
    });
    socket.on(EV.ATTEMPT_UPDATED, (p: unknown) => {
      if (!isSummary(p)) return;
      setAttempts((cur) => new Map(cur).set(p.studentNo, p));
    });
    socket.on(EV.SIGNAL_NEW, (p: unknown) => {
      if (!isRecord(p) || typeof p.attemptId !== 'string' || !isRecord(p.signal)) return;
      const sig = p.signal as unknown as SignalDto;
      const attemptId = p.attemptId;
      for (const fn of signalListeners.current) fn(attemptId, sig);
      setSignals((cur) => {
        const prev = cur.get(attemptId);
        if (prev && prev.receivedAt > sig.receivedAt) return cur;
        return new Map(cur).set(attemptId, sig);
      });
      // 카드 상단의 "최근 신호"만 즉시 갱신한다. 위반 수·색은 서버가 보내는 attempt:updated가 원본이다.
      setAttempts((cur) => {
        const found = [...cur.values()].find((a) => a.attemptId === attemptId);
        if (!found || (found.lastSignal && found.lastSignal.receivedAt > sig.receivedAt)) return cur;
        return new Map(cur).set(found.studentNo, { ...found, lastSignal: { type: sig.type, severity: sig.severity, receivedAt: sig.receivedAt } });
      });
    });
    socket.on(EV.WAITING_COUNT, (p: unknown) => {
      if (!isRecord(p)) return;
      if (typeof p.ready === 'number') setReady(p.ready);
      if (typeof p.total === 'number') setTotal(p.total);
    });
    socket.on(EV.APPROVAL_PENDING, (p: unknown) => {
      const [item] = parseApprovals([p]);
      if (!item) return;
      setApprovals((cur) => (cur.some((x) => x.attemptId === item.attemptId) ? cur : [...cur, item]));
    });
    socket.on(EV.APPROVAL_RESOLVED, (p: unknown) => {
      const attemptId = isRecord(p) ? p.attemptId : undefined;
      setApprovals((cur) => cur.filter((x) => x.attemptId !== attemptId));
    });
    socket.on(EV.NETWORK_INCIDENT, (p: unknown) => setNetworkIncident(parseIncident(p)));
    if (socket.connected) join();
    return () => {
      socket.off();
      socket.disconnect();
    };
  }, [examId]);

  const removeApproval = useCallback((attemptId: string) => setApprovals((cur) => cur.filter((x) => x.attemptId !== attemptId)), []);

  const all = useMemo(() => [...attempts.values()], [attempts]);
  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.studentNo.toLowerCase().includes(q)) : all;
    return sortCards(filtered, sortBy);
  }, [all, query, sortBy]);

  // approval:pending 이벤트에는 학번·이름이 없으므로 카드(스냅샷)에서 채운다.
  const pendingApprovals = useMemo(
    () =>
      approvals.map((a) => {
        if (a.studentNo !== null && a.name !== null) return a;
        const card = all.find((c) => c.attemptId === a.attemptId);
        return { ...a, studentNo: a.studentNo ?? card?.studentNo ?? null, name: a.name ?? card?.name ?? null };
      }),
    [approvals, all],
  );

  return { exam, cards, allCards: all, total: total ?? exam?.total ?? null, ready, signals, subscribeSignals, clock, pendingApprovals, networkIncident, sortBy, setSortBy, query, setQuery, socketDown, joinFailed, removeApproval, hasSnapshot: exam !== null };
}

export type Dashboard = ReturnType<typeof useDashboard>;
