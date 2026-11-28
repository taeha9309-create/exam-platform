import { Prisma, type AttemptState, type ExamStatus, type PrismaClient, type ProctorActionType, type Severity, type SignalSeverity, type SignalType } from '@prisma/client';
import type { AttemptSummary } from '@exam/shared';
import { prisma } from '../db';
import { attemptDeadline } from '../realtime/broadcast';

/**
 * 감독 대시보드의 스냅샷·응시 요약(SPEC F-13, 7.2). 스냅샷 = DB 상태이므로 새로고침·두 교수자 동시 접속도 같은 화면이 된다.
 * 응답은 select 목록으로 필요한 열만 읽고 buildAttemptSummary가 필드를 하나씩 골라 담는다.
 * passcode·sessionTokenHash·정답·답안은 아예 읽지 않고, pendingTokenHash는 대기 여부 판단에만 쓰고 응답에 복사하지 않는다.
 */

/** 마지막 하트비트가 이 시간(DISCONNECT 판정 10초, 계획 2 Global Constraints) 안이면 연결된 것으로 본다. */
export const CONNECTED_WINDOW_MS = 10_000;
const TERMINAL: ReadonlySet<AttemptState> = new Set(['SUBMITTED', 'TERMINATED', 'REJECTED']);
/** entry.ts의 REJECTED_PREFIX와 같은 값(거절된 중복 접속 요청은 대기 요청이 아니다). */
const REJECTED_PREFIX = 'rejected:';

export interface SummaryAttemptRow {
  id: string;
  state: AttemptState;
  consentAt: Date | null;
  consentDeclined: boolean;
  envCheckedAt: Date | null;
  violationCount: number;
  unackedSeverity: Severity;
  extraSeconds: number;
  lastHeartbeatAt: Date | null;
  pausedAt: Date | null;
}
export interface SummaryRoster {
  studentNo: string;
  name: string;
}
export interface LastSignal {
  type: SignalType;
  severity: SignalSeverity;
  receivedAt: Date;
}
export interface SummaryContext {
  /** 시험 종료 시각(endsAt). 시작 전이면 null */
  endsAt: Date | null;
  /** 가장 최근 LEAVE_START·LEAVE 신호의 종류. 없으면 null */
  lastLeaveType: 'LEAVE_START' | 'LEAVE' | null;
  now: Date;
}

/**
 * 응시 요약을 만든다(DB와 무관한 순수 함수). attempt가 null이면 미입장(state null).
 * - locked: PAUSED이고 마지막 중지 조치가 AUTO_PAUSE일 때만(감독관 PAUSE는 false).
 * - connected: 종착 전 상태이고 마지막 하트비트가 CONNECTED_WINDOW_MS 안일 때. 하트비트 수신(계획 2 Task 5) 전에는 false다.
 * - away: 마지막 이탈 신호가 LEAVE_START(아직 LEAVE로 닫히지 않음)이고 종착 전 상태일 때.
 */
export function buildAttemptSummary(
  attempt: SummaryAttemptRow | null,
  roster: SummaryRoster,
  lastSignal: LastSignal | null,
  lastPauseAction: ProctorActionType | null,
  ctx: SummaryContext,
): AttemptSummary {
  if (!attempt) {
    return {
      attemptId: null,
      studentNo: roster.studentNo,
      name: roster.name,
      state: null,
      ready: false,
      consentDeclined: false,
      violationCount: 0,
      unackedSeverity: 'NONE',
      locked: false,
      connected: false,
      away: false,
      extraSeconds: 0,
      deadline: null,
      pausedAt: null,
      lastSignal: null,
    };
  }
  const live = !TERMINAL.has(attempt.state);
  return {
    attemptId: attempt.id,
    studentNo: roster.studentNo,
    name: roster.name,
    state: attempt.state,
    ready: attempt.consentAt !== null && attempt.envCheckedAt !== null,
    consentDeclined: attempt.consentDeclined,
    violationCount: attempt.violationCount,
    unackedSeverity: attempt.unackedSeverity,
    locked: attempt.state === 'PAUSED' && lastPauseAction === 'AUTO_PAUSE',
    connected: live && attempt.lastHeartbeatAt !== null && ctx.now.getTime() - attempt.lastHeartbeatAt.getTime() <= CONNECTED_WINDOW_MS,
    away: live && ctx.lastLeaveType === 'LEAVE_START',
    extraSeconds: attempt.extraSeconds,
    deadline: attemptDeadline(attempt, { endsAt: ctx.endsAt }),
    pausedAt: attempt.pausedAt ? attempt.pausedAt.getTime() : null,
    lastSignal: lastSignal ? { type: lastSignal.type, severity: lastSignal.severity, receivedAt: lastSignal.receivedAt.getTime() } : null,
  };
}

export type PendingApproval = { attemptId: string; kind: 'LATE' | 'DUPLICATE'; studentNo: string; name: string };

export interface DashboardSnapshot {
  exam: { id: string; title: string; status: ExamStatus; endsAt: number | null; lockNewEntry: boolean; serverNow: number; ready: number; total: number };
  attempts: AttemptSummary[];
  pendingApprovals: PendingApproval[];
  networkIncident: { count: number; attemptIds: string[]; since: number } | null;
}

const ATTEMPT_SELECT = {
  id: true,
  state: true,
  consentAt: true,
  consentDeclined: true,
  envCheckedAt: true,
  violationCount: true,
  unackedSeverity: true,
  extraSeconds: true,
  lastHeartbeatAt: true,
  pausedAt: true,
  pendingTokenHash: true, // 대기 요청 여부 판단에만 쓴다. 응답에는 복사하지 않는다.
} as const;

type Db = PrismaClient | Prisma.TransactionClient;

/** 응시별 마지막 신호·마지막 이탈 신호·마지막 중지 조치. 응시 수와 무관하게 쿼리 3개(DISTINCT ON). ids가 있으면 그 응시만. */
async function loadLatest(db: Db, examId: string, ids: string[] | null) {
  const filter = ids ? Prisma.sql`AND a."id" = ANY(${ids}::text[])` : Prisma.empty;
  // 쿼리는 일부러 하나씩 실행한다: 동시에 여러 개를 날리면 대기실·학생 연결과 겹칠 때 DB 연결 풀을 한꺼번에 점유한다.
  const signals = await db.$queryRaw<{ attemptId: string; type: SignalType; severity: SignalSeverity; receivedAt: Date }[]>`
      SELECT DISTINCT ON (s."attemptId") s."attemptId", s."type"::text AS "type", s."severity"::text AS "severity", s."receivedAt"
      FROM "Signal" s JOIN "Attempt" a ON a."id" = s."attemptId"
      WHERE a."examId" = ${examId} ${filter}
      ORDER BY s."attemptId", s."receivedAt" DESC, s."id" DESC`;
  const leaves = await db.$queryRaw<{ attemptId: string; type: 'LEAVE_START' | 'LEAVE' }[]>`
      SELECT DISTINCT ON (s."attemptId") s."attemptId", s."type"::text AS "type"
      FROM "Signal" s JOIN "Attempt" a ON a."id" = s."attemptId"
      WHERE a."examId" = ${examId} AND s."type" IN ('LEAVE_START', 'LEAVE') ${filter}
      ORDER BY s."attemptId", s."receivedAt" DESC, s."id" DESC`;
  const pauses = await db.$queryRaw<{ attemptId: string; type: ProctorActionType }[]>`
      SELECT DISTINCT ON (p."attemptId") p."attemptId", p."type"::text AS "type"
      FROM "ProctorAction" p JOIN "Attempt" a ON a."id" = p."attemptId"
      WHERE a."examId" = ${examId} AND p."type" IN ('PAUSE', 'AUTO_PAUSE') ${filter}
      ORDER BY p."attemptId", p."createdAt" DESC, p."id" DESC`;
  return {
    signal: new Map(signals.map((r) => [r.attemptId, { type: r.type, severity: r.severity, receivedAt: r.receivedAt }])),
    leave: new Map(leaves.map((r) => [r.attemptId, r.type])),
    pause: new Map(pauses.map((r) => [r.attemptId, r.type])),
  };
}

/**
 * 시험 전체 스냅샷. 쿼리는 응시 수와 무관하게 상수 개(시험 1 + 명단·응시 1 + 최신 신호·이탈·중지 3)다.
 * 시험이 없으면 null. db는 테스트에서 쿼리 수를 세려고 바꿀 수 있다.
 */
export async function loadDashboardSnapshot(examId: string, db: Db = prisma): Promise<DashboardSnapshot | null> {
  const now = new Date();
  const exam = await db.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, status: true, endsAt: true, lockNewEntry: true } });
  if (!exam) return null;
  const roster = await db.rosterEntry.findMany({ where: { examId }, orderBy: { studentNo: 'asc' }, select: { studentNo: true, name: true, attempt: { select: ATTEMPT_SELECT } } });
  const latest = await loadLatest(db, examId, null);

  const attempts: AttemptSummary[] = [];
  const pendingApprovals: PendingApproval[] = [];
  let ready = 0;
  for (const r of roster) {
    const a = r.attempt;
    attempts.push(
      buildAttemptSummary(a, r, a ? (latest.signal.get(a.id) ?? null) : null, a ? (latest.pause.get(a.id) ?? null) : null, {
        endsAt: exam.endsAt,
        lastLeaveType: a ? (latest.leave.get(a.id) ?? null) : null,
        now,
      }),
    );
    if (!a) continue;
    // broadcast.waitingCount와 같은 정의: WAITING + 동의 + 환경 점검 완료
    if (a.state === 'WAITING' && a.consentAt !== null && a.envCheckedAt !== null) ready += 1;
    if (a.state === 'PENDING_APPROVAL') pendingApprovals.push({ attemptId: a.id, kind: 'LATE', studentNo: r.studentNo, name: r.name });
    if (a.pendingTokenHash && !a.pendingTokenHash.startsWith(REJECTED_PREFIX)) {
      pendingApprovals.push({ attemptId: a.id, kind: 'DUPLICATE', studentNo: r.studentNo, name: r.name });
    }
  }
  return {
    exam: { id: exam.id, title: exam.title, status: exam.status, endsAt: exam.endsAt ? exam.endsAt.getTime() : null, lockNewEntry: exam.lockNewEntry, serverNow: now.getTime(), ready, total: roster.length },
    attempts,
    pendingApprovals,
    networkIncident: null, // 네트워크 장애 묶음 판정은 계획 2 Task 5
  };
}

/** 지정한 응시들의 요약(attempt:updated용). 쿼리 수는 응시 수와 무관하다. 없는 응시는 결과에서 빠진다. */
export async function loadAttemptSummaries(examId: string, attemptIds: string[], db: Db = prisma): Promise<AttemptSummary[]> {
  if (attemptIds.length === 0) return [];
  const now = new Date();
  const exam = await db.exam.findUnique({ where: { id: examId }, select: { endsAt: true } });
  if (!exam) return [];
  const rows = await db.attempt.findMany({ where: { examId, id: { in: attemptIds } }, select: { ...ATTEMPT_SELECT, rosterEntry: { select: { studentNo: true, name: true } } } });
  const latest = await loadLatest(db, examId, attemptIds);
  return rows.map((a) =>
    buildAttemptSummary(a, a.rosterEntry, latest.signal.get(a.id) ?? null, latest.pause.get(a.id) ?? null, {
      endsAt: exam.endsAt,
      lastLeaveType: latest.leave.get(a.id) ?? null,
      now,
    }),
  );
}
