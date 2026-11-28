import type { AttemptSummary, ProctorActionType, SignalDto } from '@exam/shared';
import { Prisma, type Attempt, type Exam, type RosterEntry } from '@prisma/client';
import { prisma } from '../db';
import { InvalidTransitionError, nextState } from '../domain/attemptMachine';
import { AppError } from '../errors';
import { attemptDeadline, broadcast } from '../realtime/broadcast';
import { loadAttemptSummaries } from './dashboard';
import { lockExam, notify, runExamTx } from './examLifecycle';
import { gradeMcqAnswers } from './submission';

/**
 * 감독관 조치(F-16)와 학생 타임라인(F-15) 서비스.
 *
 * 잠금: 시험 행 → 응시 행(FOR UPDATE) 순서(계획 1의 규칙)다. 시험 행을 먼저 잠그는 이유는 시험 시작·종료·제출 일괄 처리(모두 시험 행을
 * 먼저 잠근다)와 같은 순서로 줄을 서야 교착이 생기지 않고, 조치 도중 시험이 종료되어 응시가 SUBMITTED가 되는 경주를 막기 때문이다.
 * 같은 응시에 대한 조치 둘(예: PAUSE 2건)은 이 잠금에서 직렬화되어 두 번째가 바뀐 상태를 보고 409가 된다.
 * 상태 전이·ProctorAction 기록은 같은 트랜잭션이고, 실시간 알림은 커밋 뒤에 보낸다(실패해도 상태 유지).
 */

type Tx = Prisma.TransactionClient;

export type ActionType = 'WARN' | 'PAUSE' | 'RESUME' | 'TERMINATE' | 'ADD_TIME' | 'ACK';
export const ACTION_TYPES: readonly ActionType[] = ['WARN', 'PAUSE', 'RESUME', 'TERMINATE', 'ADD_TIME', 'ACK'];

export interface ActionInput {
  type: ActionType;
  reason?: string;
  payload?: { minutes?: number; addPausedTime?: boolean };
}

/** 한 응시의 추가 시간 누적 상한(초). 24시간. 정수 오버플로·실수로 거대한 마감을 만드는 일을 막는다. */
export const MAX_EXTRA_SECONDS = 24 * 3600;
/** 타임라인 응답의 신호 상한. 넘으면 가장 최근 것만 준다. */
export const TIMELINE_SIGNAL_LIMIT = 500;

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', '응시를 찾을 수 없습니다.');
const INVALID_STATE = () => new AppError(409, 'INVALID_STATE', '현재 상태에서는 처리할 수 없는 요청입니다.');
const EXTRA_TIME_LIMIT = () => new AppError(409, 'EXTRA_TIME_LIMIT', '한 응시에 추가할 수 있는 시간의 한도를 넘습니다.');

/** nextState가 표에 없는 조합이라고 하면 409 INVALID_STATE로 바꾼다. */
function transition(current: Attempt['state'], event: 'PAUSE' | 'RESUME' | 'TERMINATE'): Attempt['state'] {
  try {
    return nextState(current, event, { ready: false, examRunning: true });
  } catch (err) {
    if (err instanceof InvalidTransitionError) throw INVALID_STATE();
    throw err;
  }
}

/** 시험 마감·학생 마감 계산이 쓰는 분 단위 올림. 최소 1분, 최대 60분(ADD_TIME과 같은 범위). */
function pausedMinutes(pausedAt: Date, now: Date): number {
  return Math.max(1, Math.min(60, Math.ceil((now.getTime() - pausedAt.getTime()) / 60_000)));
}

/** 대시보드와 같은 요약 빌더(services/dashboard.ts)로 응시 하나의 요약을 만든다. 비밀 값은 select에 없다. */
async function summaryOf(db: Tx | typeof prisma, examId: string, attemptId: string): Promise<AttemptSummary> {
  const [summary] = await loadAttemptSummaries(examId, [attemptId], db);
  if (!summary) throw NOT_FOUND();
  return summary;
}

/**
 * 트랜잭션 안에서 기록한 조치 1건. createdAt을 명시하는 이유: DB 기본값 now()는 "트랜잭션 시작 시각"이라
 * 같은 트랜잭션의 두 기록(RESUME, ADD_TIME)이 같은 시각이 되어 순서를 구분할 수 없다.
 */
async function record(tx: Tx, attemptId: string, staffId: string, type: ProctorActionType, reason: string, payload: Prisma.InputJsonObject, createdAt: Date): Promise<void> {
  await tx.proctorAction.create({ data: { attemptId, staffId, type, reason, payload, createdAt } });
}

/**
 * 감독관 조치 하나를 실행한다. 허용되지 않는 상태 조합·한도 초과는 아무것도 기록·변경하지 않고 409.
 * staffId는 호출자(라우트)가 인증된 계정에서 넘긴다. 사유 검증은 라우트가 한다(여기서는 이미 검증된 값으로 본다).
 */
export async function applyAction(attemptId: string, staffId: string, input: ActionInput, now: Date = new Date()): Promise<AttemptSummary> {
  const found = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { examId: true } });
  if (!found) throw NOT_FOUND();
  const reason = input.reason ?? '';

  const out = await runExamTx(async (tx) => {
    await lockExam(tx, found.examId);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
    if (!locked[0]) throw NOT_FOUND();
    // 잠근 뒤에 다시 읽는다. 잠금을 기다리는 동안 다른 조치·제출로 상태가 바뀌었을 수 있다.
    const attempt = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId }, include: { exam: true, rosterEntry: true } });
    const exam = attempt.exam;
    let data: Prisma.AttemptUpdateInput | null = null;
    let warning: string | null = null;
    let stateChanged = false;

    switch (input.type) {
      case 'ACK':
        // 어느 상태에서든 확인 처리할 수 있다(종료된 응시의 신호도 확인 가능). 학생 화면에는 영향이 없어 알림 없음.
        data = { unackedSeverity: 'NONE' };
        await record(tx, attemptId, staffId, 'ACK', reason, {}, now);
        break;

      case 'WARN':
        if (attempt.state !== 'ACTIVE' && attempt.state !== 'PAUSED' && attempt.state !== 'WAITING') throw INVALID_STATE();
        await record(tx, attemptId, staffId, 'WARN', reason, {}, now);
        warning = reason; // 메시지 = 사유(원문 그대로)
        break;

      case 'PAUSE':
        data = { state: transition(attempt.state, 'PAUSE'), pausedAt: now };
        stateChanged = true;
        await record(tx, attemptId, staffId, 'PAUSE', reason, {}, now);
        break;

      case 'RESUME': {
        const next = transition(attempt.state, 'RESUME');
        // pausedAt이 null인 PAUSED(있어서는 안 되는 데이터)는 addPausedTime을 무시하고 RESUME만 한다.
        const addMinutes = input.payload?.addPausedTime === true && attempt.pausedAt ? pausedMinutes(attempt.pausedAt, now) : null;
        if (addMinutes !== null && attempt.extraSeconds + addMinutes * 60 > MAX_EXTRA_SECONDS) throw EXTRA_TIME_LIMIT();
        data = { state: next, pausedAt: null, ...(addMinutes !== null ? { extraSeconds: { increment: addMinutes * 60 } } : {}) };
        stateChanged = true;
        await record(tx, attemptId, staffId, 'RESUME', reason, { addPausedTime: addMinutes !== null }, now);
        // RESUME 먼저, ADD_TIME 나중(같은 트랜잭션, 1ms 뒤로 두어 타임라인 순서가 고정된다).
        if (addMinutes !== null) {
          await record(tx, attemptId, staffId, 'ADD_TIME', reason, { minutes: addMinutes, fromPause: true }, new Date(now.getTime() + 1));
        }
        break;
      }

      case 'ADD_TIME': {
        if (attempt.state !== 'ACTIVE' && attempt.state !== 'PAUSED') throw INVALID_STATE();
        const minutes = input.payload?.minutes;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
          throw new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
        }
        if (attempt.extraSeconds + minutes * 60 > MAX_EXTRA_SECONDS) throw EXTRA_TIME_LIMIT();
        data = { extraSeconds: { increment: minutes * 60 } };
        stateChanged = true; // 마감(deadline)이 바뀌므로 학생에게 attempt:state로 알린다
        await record(tx, attemptId, staffId, 'ADD_TIME', reason, { minutes }, now);
        break;
      }

      case 'TERMINATE':
        data = { state: transition(attempt.state, 'TERMINATE'), submittedAt: now };
        stateChanged = true;
        // 제출과 같은 규칙으로 객관식을 채점한다(서술형은 교수자가 채점).
        await gradeMcqAnswers(tx, attemptId);
        await record(tx, attemptId, staffId, 'TERMINATE', reason, {}, now);
        break;
    }

    const updated = data ? await tx.attempt.update({ where: { id: attemptId }, data, include: { exam: true, rosterEntry: true } }) : attempt;
    return { updated, exam, summary: await summaryOf(tx, updated.examId, attemptId), warning, stateChanged };
  });

  // 커밋 뒤 알림. 각각 따로 감싸서 하나가 실패해도 나머지는 보내고, 어떤 실패도 이미 확정된 변경을 되돌리지 않는다.
  if (out.stateChanged) notify(() => broadcast.attemptState(out.updated, out.exam, out.summary.locked)); // locked: PAUSED이고 마지막 중지가 AUTO_PAUSE일 때만 true
  if (out.warning !== null) {
    const message = out.warning;
    notify(() => broadcast.proctorWarning(attemptId, message));
  }
  notify(() => void broadcast.attemptUpdated(attemptId));
  return out.summary;
}

export interface TimelineAction {
  id: string;
  type: ProctorActionType;
  reason: string;
  staffName: string | null;
  payload: object;
  createdAt: number;
}

export interface Timeline {
  attempt: AttemptSummary;
  signals: SignalDto[];
  /** 신호가 상한을 넘어 오래된 것을 잘랐는지 */
  truncated: boolean;
  actions: TimelineAction[];
}

/** 학생 상세 패널(F-15)용 타임라인. 신호는 receivedAt 오름차순, 최대 TIMELINE_SIGNAL_LIMIT개(넘으면 가장 최근 것). */
export async function getTimeline(attemptId: string): Promise<Timeline> {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true, rosterEntry: true } });
  if (!attempt) throw NOT_FOUND();
  const [recentDesc, actions, summary] = await Promise.all([
    prisma.signal.findMany({ where: { attemptId }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: TIMELINE_SIGNAL_LIMIT + 1 }),
    prisma.proctorAction.findMany({ where: { attemptId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { staff: { select: { name: true } } } }),
    summaryOf(prisma, attempt.examId, attemptId),
  ]);
  const truncated = recentDesc.length > TIMELINE_SIGNAL_LIMIT;
  const signals: SignalDto[] = recentDesc
    .slice(0, TIMELINE_SIGNAL_LIMIT)
    .reverse()
    .map((s) => ({
      id: s.id,
      type: s.type,
      severity: s.severity,
      clientAt: s.clientAt ? s.clientAt.getTime() : null,
      receivedAt: s.receivedAt.getTime(),
      durationMs: s.durationMs,
      questionId: s.questionId,
      meta: (s.meta ?? {}) as Record<string, unknown>,
    }));
  return {
    attempt: summary,
    signals,
    truncated,
    actions: actions.map((a) => ({
      id: a.id,
      type: a.type,
      reason: a.reason,
      staffName: a.staff?.name ?? null,
      payload: (a.payload ?? {}) as object,
      createdAt: a.createdAt.getTime(),
    })),
  };
}
