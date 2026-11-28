import { EV, VIOLATION_LIMIT, type ClientSignalType, type Severity, type SignalDto, type SignalType } from '@exam/shared';
import { Prisma, type Signal } from '@prisma/client';
import { prisma } from '../db';
import { nextState } from '../domain/attemptMachine';
import { countsAsViolation, maxSeverity, shouldAutoPause, signalSeverity } from '../domain/signals';
import { attemptRoom, broadcast, getIo } from '../realtime/broadcast';
import { hasLoneSurrogate } from '../validation';
import { notify, runExamTx } from './examLifecycle';

/**
 * 행동 신호 수신·위반 카운트·자동 잠금(SPEC 5.1~5.7).
 *
 * 동시성: 신호 하나는 "그 응시 행만" SELECT ... FOR UPDATE로 잠근 트랜잭션 안에서 처리한다.
 * 같은 응시에 신호 6건이 동시에 와도 위반 카운트 읽기-증가-쓰기가 직렬화되어 카운트가 유실되지 않고,
 * 5의 배수가 되는 신호는 정확히 한 건이라 AUTO_PAUSE도 한 건만 기록된다.
 * 이 서비스는 시험 행을 잠그지 않는다. 시험 행 → 응시 행 순서로 잠그는 다른 경로(제출·시험 종료·입장 처리·감독관 조치)와는
 * "응시 행 하나만 잡고 다른 잠금을 더 요청하지 않는" 쪽이므로 대기 순환이 생길 수 없다(교착 없음).
 * 시각(now)은 응시 행 잠금을 얻은 뒤에 정한다: 잠금 전에 정하면 잠금을 늦게 얻은 쪽이 더 이른 시각을 갖게 되어 기록 순서가 뒤집힌다.
 */

type Tx = Prisma.TransactionClient;

export const SIGNAL_META_MAX_BYTES = 2048;
export const SIGNAL_DURATION_MAX_MS = 3_600_000;
/** seq는 PostgreSQL INT(32비트)다. */
const MAX_SEQ = 2_147_483_647;
/** clientAt 상한(2100-01-01). Date·PostgreSQL이 다룰 수 있는 범위 안으로 제한한다. */
const MAX_CLIENT_AT = 4_102_444_800_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_TYPES: ReadonlySet<string> = new Set<ClientSignalType>(['LEAVE', 'LEAVE_START', 'FULLSCREEN_EXIT', 'PASTE', 'DROP']);
const SIGNAL_KEYS = new Set(['seq', 'type', 'clientAt', 'durationMs', 'questionId', 'meta']);
const HEARTBEAT_KEYS = new Set(['seq']);
const TERMINAL = new Set(['SUBMITTED', 'TERMINATED', 'REJECTED']);
/** 신호를 저장하는 응시 상태. 입장 승인 대기(PENDING_APPROVAL)와 종착 상태는 받지 않는다. */
const ACCEPTING = new Set(['WAITING', 'ACTIVE', 'PAUSED']);

export type SignalCode = 'INVALID' | 'NOT_ACTIVE';
export type SignalResult = { ok: true } | { ok: false; code: SignalCode; revoked?: true };
export type ServerSignalType = Extract<SignalType, 'MULTI_MONITOR' | 'DISCONNECT' | 'RECONNECT' | 'HEARTBEAT_GAP' | 'SEQ_GAP'>;
/** 시각은 값이나 함수로 받는다. 함수면 응시 행 잠금을 얻은 뒤에 호출한다. */
export type NowArg = Date | (() => Date);

interface ParsedSignal {
  seq: number;
  type: ClientSignalType;
  clientAt: Date | null;
  durationMs: number | null;
  questionId: string | null;
  meta: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** meta 안의 모든 키·문자열이 PostgreSQL jsonb에 저장 가능한지(NUL·짝 없는 서로게이트 금지), 깊이·크기가 한도 안인지 확인한다. */
function metaStorable(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') return !value.includes('\u0000') && !hasLoneSurrogate(value);
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => metaStorable(v, depth + 1));
  if (isPlainObject(value)) return Object.entries(value).every(([k, v]) => metaStorable(k, depth + 1) && metaStorable(v, depth + 1));
  return false;
}

function parseSeq(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_SEQ ? v : null;
}

/** 엄격 검증: 알 수 없는 키·서버 전용 type·범위를 벗어난 값은 모두 INVALID. 순수 함수(DB 없음). */
export function parseClientSignal(payload: unknown): ParsedSignal | null {
  if (!isPlainObject(payload)) return null;
  for (const key of Object.keys(payload)) if (!SIGNAL_KEYS.has(key)) return null;
  const { type, clientAt, durationMs, questionId, meta } = payload;
  const seq = parseSeq(payload.seq);
  if (seq === null) return null;
  if (typeof type !== 'string' || !CLIENT_TYPES.has(type)) return null;

  let clientAtDate: Date | null = null;
  if (clientAt !== undefined && clientAt !== null) {
    if (typeof clientAt !== 'number' || !Number.isSafeInteger(clientAt) || clientAt < 0 || clientAt > MAX_CLIENT_AT) return null;
    clientAtDate = new Date(clientAt);
  }
  let duration: number | null = null;
  if (durationMs !== undefined && durationMs !== null) {
    if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > SIGNAL_DURATION_MAX_MS) return null;
    duration = durationMs;
  }
  if (type === 'LEAVE' && duration === null) return null; // 이탈 시간이 없는 LEAVE는 판정할 수 없다
  let qid: string | null = null;
  if (questionId !== undefined && questionId !== null) {
    if (typeof questionId !== 'string' || !ID_PATTERN.test(questionId)) return null;
    qid = questionId;
  }
  let metaObj: Record<string, unknown> = {};
  if (meta !== undefined) {
    if (!isPlainObject(meta) || !metaStorable(meta)) return null;
    if (Buffer.byteLength(JSON.stringify(meta), 'utf8') > SIGNAL_META_MAX_BYTES) return null;
    metaObj = meta;
  }
  return { seq, type: type as ClientSignalType, clientAt: clientAtDate, durationMs: duration, questionId: qid, meta: metaObj };
}

interface LockedAttempt {
  id: string;
  examId: string;
  state: string;
  sessionTokenHash: string;
  lastSeq: number;
  violationCount: number;
  unackedSeverity: Severity;
}

async function lockAttempt(tx: Tx, attemptId: string): Promise<LockedAttempt | undefined> {
  const rows = await tx.$queryRaw<LockedAttempt[]>`
    SELECT "id", "examId", "state", "sessionTokenHash", "lastSeq", "violationCount", "unackedSeverity"
    FROM "Attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
  return rows[0];
}

export function toSignalDto(s: Signal): SignalDto {
  return {
    id: s.id,
    type: s.type,
    severity: s.severity,
    clientAt: s.clientAt ? s.clientAt.getTime() : null,
    receivedAt: s.receivedAt.getTime(),
    durationMs: s.durationMs,
    questionId: s.questionId,
    meta: (isPlainObject(s.meta) ? s.meta : {}) as Record<string, unknown>,
  };
}

/** 커밋 뒤에 보낼 알림. 트랜잭션 안에서는 만들기만 한다. */
interface Outcome {
  examId: string;
  signals: Signal[];
  violation?: { count: number; type: SignalType };
  autoPaused?: boolean;
}

/** 서버 전용 신호(응시 행 잠금을 이미 잡은 트랜잭션 안). seq가 없고 위반으로 세지 않는다. */
async function insertServerSignal(tx: Tx, cur: LockedAttempt, type: ServerSignalType, meta: object, now: Date): Promise<Signal> {
  const severity = signalSeverity(type);
  const signal = await tx.signal.create({ data: { attemptId: cur.id, type, severity, meta: meta as Prisma.InputJsonObject, receivedAt: now } });
  const raised = maxSeverity(cur.unackedSeverity, severity);
  if (raised !== cur.unackedSeverity) {
    await tx.attempt.update({ where: { id: cur.id }, data: { unackedSeverity: raised } });
    cur.unackedSeverity = raised;
  }
  return signal;
}

/**
 * 이미 응시 행을 잠근 다른 서비스(입장·환경 점검)가 같은 트랜잭션에서 서버 신호를 남길 때 쓴다.
 * 호출자가 시험 행 → 응시 행 순서를 지켜야 한다. 알림은 호출자가 커밋 뒤에 보낸다.
 */
export async function recordServerSignalInTx(tx: Tx, attemptId: string, type: ServerSignalType, meta: object, now: Date): Promise<Signal | null> {
  const cur = await lockAttempt(tx, attemptId);
  if (!cur || TERMINAL.has(cur.state)) return null;
  return insertServerSignal(tx, cur, type, meta, now);
}

async function notifySignals(outcome: Outcome, attemptId: string): Promise<void> {
  notify(() => {
    for (const signal of outcome.signals) broadcast.toStaff(outcome.examId, EV.SIGNAL_NEW, { attemptId, signal: toSignalDto(signal) });
  });
  notify(() => {
    if (outcome.violation) getIo().to(attemptRoom(attemptId)).emit(EV.VIOLATION_COUNTED, { count: outcome.violation.count, limit: VIOLATION_LIMIT, type: outcome.violation.type });
  });
  if (outcome.autoPaused) {
    notify(() => void emitStudentState(attemptId));
  }
  await broadcast.attemptUpdated(attemptId);
}

/** 자동 잠금 직후 학생에게 상태를 보낸다(잠금 사유 locked: true 포함). 커밋 뒤의 최신 행을 읽어 보낸다. */
async function emitStudentState(attemptId: string): Promise<void> {
  try {
    const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
    if (attempt) broadcast.attemptState(attempt, attempt.exam, attempt.state === 'PAUSED' ? true : false);
  } catch (err) {
    console.error('attempt:state 전송 실패', err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * 학생 신호 저장. 응시 행 잠금 안에서 토큰 해시·상태·seq를 다시 확인한다.
 * - 중복·낮은 seq: 저장하지 않고 ok(클라이언트는 ack 실패 때 같은 seq를 재전송하므로 ok가 아니면 큐가 영원히 막힌다).
 * - seq가 lastSeq+1보다 크면 SEQ_GAP 서버 신호(WARN, 위반 아님) 1건을 함께 남긴다.
 * - WAITING·PAUSED의 신호도 저장한다(위반으로 세지 않을 뿐). 종착 상태·승인 대기만 NOT_ACTIVE.
 * - 토큰 해시 불일치(세션 폐기)는 NOT_ACTIVE + revoked(호출자가 연결을 끊는다).
 * @param now 값 또는 함수. 함수면 잠금을 얻은 뒤 호출한다.
 */
export async function recordClientSignal(attemptId: string, tokenHash: string, payload: unknown, now: NowArg): Promise<SignalResult> {
  const parsed = parseClientSignal(payload);
  if (!parsed) return { ok: false, code: 'INVALID' };

  const result = await runExamTx(async (tx): Promise<{ res: SignalResult; outcome?: Outcome }> => {
    const cur = await lockAttempt(tx, attemptId);
    if (!cur || cur.sessionTokenHash !== tokenHash) return { res: { ok: false, code: 'NOT_ACTIVE', revoked: true } };
    if (!ACCEPTING.has(cur.state)) return { res: { ok: false, code: 'NOT_ACTIVE' } };
    const at = typeof now === 'function' ? now() : now; // 잠금 뒤에 정한 시각

    if (parsed.seq <= cur.lastSeq) return { res: { ok: true } }; // 중복·오래된 seq: 무시

    if (parsed.questionId !== null) {
      const q = await tx.question.findFirst({ where: { id: parsed.questionId, examId: cur.examId }, select: { id: true } });
      if (!q) return { res: { ok: false, code: 'INVALID' } };
    }

    const outcome: Outcome = { examId: cur.examId, signals: [] };
    if (parsed.seq > cur.lastSeq + 1) {
      outcome.signals.push(await insertServerSignal(tx, cur, 'SEQ_GAP', { expected: cur.lastSeq + 1, got: parsed.seq }, at));
    }

    const meta: Record<string, unknown> = { ...parsed.meta };
    delete meta.serverDurationMs; // 서버가 정하는 값이다. 클라이언트가 보낸 같은 이름의 값은 버린다.
    if (parsed.type === 'LEAVE') {
      const last = await tx.signal.findFirst({
        where: { attemptId, type: { in: ['LEAVE_START', 'LEAVE'] } },
        orderBy: [{ receivedAt: 'desc' }, { seq: 'desc' }],
        select: { type: true, receivedAt: true },
      });
      if (last?.type === 'LEAVE_START') meta.serverDurationMs = Math.max(0, at.getTime() - last.receivedAt.getTime());
    }

    const severity = signalSeverity(parsed.type, parsed.durationMs);
    const signal = await tx.signal.create({
      data: {
        attemptId,
        type: parsed.type,
        severity,
        seq: parsed.seq,
        clientAt: parsed.clientAt,
        receivedAt: at,
        durationMs: parsed.durationMs,
        questionId: parsed.questionId,
        meta: meta as Prisma.InputJsonObject,
      },
    });
    outcome.signals.push(signal);

    const data: Prisma.AttemptUpdateInput = { lastSeq: parsed.seq, unackedSeverity: maxSeverity(cur.unackedSeverity, severity) };
    if (countsAsViolation(parsed.type, parsed.durationMs, cur.state as 'ACTIVE')) {
      const count = cur.violationCount + 1;
      data.violationCount = count;
      outcome.violation = { count, type: parsed.type };
      if (shouldAutoPause(count)) {
        // ACTIVE만 위반으로 세므로 여기서는 항상 ACTIVE → PAUSED. 상태 전이는 도메인 규칙을 그대로 쓴다.
        data.state = nextState('ACTIVE', 'PAUSE', { ready: true, examRunning: true });
        data.pausedAt = at;
        await tx.proctorAction.create({
          data: { attemptId, staffId: null, type: 'AUTO_PAUSE', reason: `시스템 자동 일시정지(위반 ${count}회)`, createdAt: at },
        });
        outcome.autoPaused = true;
      }
    }
    await tx.attempt.update({ where: { id: attemptId }, data });
    return { res: { ok: true }, outcome };
  });

  if (result.outcome) await notifySignals(result.outcome, attemptId);
  return result.res;
}

/** 서버가 만드는 신호(MULTI_MONITOR·DISCONNECT·RECONNECT·HEARTBEAT_GAP·SEQ_GAP). seq 없음, 위반 아님. 종착 상태·없는 응시는 무시한다. */
export async function recordServerSignal(attemptId: string, type: ServerSignalType, meta: object, now: NowArg): Promise<void> {
  const out = await runExamTx(async (tx) => {
    const cur = await lockAttempt(tx, attemptId);
    if (!cur || TERMINAL.has(cur.state)) return null;
    const signal = await insertServerSignal(tx, cur, type, meta, typeof now === 'function' ? now() : now);
    return { examId: cur.examId, signals: [signal] } satisfies Outcome;
  });
  if (out) await notifySignals(out, attemptId);
}

/**
 * 하트비트. lastHeartbeatAt을 갱신하고 seq를 lastSeq에 반영한다(신호와 같은 seq 카운터를 쓴다).
 * 중복·낮은 seq는 lastSeq를 되돌리지 않고, 앞선 seq가 빠졌으면 SEQ_GAP을 남긴다.
 * tokenHash를 주면 DB의 현재 해시와 다를 때(폐기된 세션) 아무것도 갱신하지 않고 false를 돌려준다.
 */
export async function recordHeartbeat(attemptId: string, seq: number, now: NowArg, tokenHash?: string): Promise<boolean> {
  const valid = parseSeq(seq);
  if (valid === null) return true;
  const out = await runExamTx(async (tx) => {
    const cur = await lockAttempt(tx, attemptId);
    if (!cur || (tokenHash !== undefined && cur.sessionTokenHash !== tokenHash)) return { alive: false as const };
    if (!ACCEPTING.has(cur.state)) return { alive: true as const };
    const at = typeof now === 'function' ? now() : now;
    const outcome: Outcome = { examId: cur.examId, signals: [] };
    if (valid > cur.lastSeq + 1) outcome.signals.push(await insertServerSignal(tx, cur, 'SEQ_GAP', { expected: cur.lastSeq + 1, got: valid }, at));
    await tx.attempt.update({ where: { id: attemptId }, data: { lastHeartbeatAt: at, lastSeq: Math.max(cur.lastSeq, valid) } });
    return { alive: true as const, outcome };
  });
  if ('outcome' in out && out.outcome && out.outcome.signals.length > 0) await notifySignals(out.outcome, attemptId);
  return out.alive;
}

/** hb 페이로드 `{ seq }` 검증. 알 수 없는 키가 있거나 seq가 정수가 아니면 null. */
export function parseHeartbeat(payload: unknown): number | null {
  if (!isPlainObject(payload)) return null;
  for (const key of Object.keys(payload)) if (!HEARTBEAT_KEYS.has(key)) return null;
  return parseSeq(payload.seq);
}
