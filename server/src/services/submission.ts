import type { SubmitReason } from '@prisma/client';
import { Prisma, type Attempt, type Exam } from '@prisma/client';
import { nextState, type AttemptEvent } from '../domain/attemptMachine';
import { gradeMcq } from '../domain/grading';
import { AppError } from '../errors';
import { broadcast } from '../realtime/broadcast';
import { prisma } from '../db';
import { hasControlChars, hasLoneSurrogate } from '../validation';
import { lockExam, notify, runExamTx } from './examLifecycle';

/**
 * 답안 저장(F-11)과 제출·채점.
 *
 * 잠금 순서: 시험 행 → 응시 행. 답안 저장은 응시 행만 잠근다(같은 시험의 학생들이 서로를 기다리지 않게).
 * 제출·시험 종료는 응시 행을 잠그므로, 저장과 제출은 같은 응시 행에서 직렬화된다.
 * 저장은 시험 행을 잠그지 않으므로 순서가 뒤집히는 일(교착)이 없다.
 */

type Tx = Prisma.TransactionClient;

export const MAX_ANSWER_LENGTH = 5000;
/** Answer.rev는 PostgreSQL INT(32비트)다. */
const MAX_REV = 2_147_483_647;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAVE_KEYS = new Set(['questionId', 'choiceId', 'text', 'rev']);
const TERMINAL = new Set(['SUBMITTED', 'TERMINATED', 'REJECTED']);

export type SaveCode = 'NOT_ACTIVE' | 'STALE_REV' | 'TOO_LONG' | 'INVALID';
export type SaveResult = { ok: true; savedAt: Date } | { ok: false; code: SaveCode; revoked?: true };

type ParsedSave = { questionId: string; rev: number } & ({ choiceId: string; text?: undefined } | { text: string; choiceId?: undefined });

/** 글자 수(code point). PostgreSQL VarChar(5000)도 글자 수로 센다. UTF-16 길이로 세면 이모지에서 오탐이 난다. */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}

function parseSave(payload: unknown): ParsedSave | { code: 'INVALID' | 'TOO_LONG' } {
  const INVALID = { code: 'INVALID' as const };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return INVALID;
  const proto = Object.getPrototypeOf(payload) as unknown;
  if (proto !== Object.prototype && proto !== null) return INVALID;
  const p = payload as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!SAVE_KEYS.has(key)) return INVALID;

  const { questionId, choiceId, text, rev } = p;
  if (typeof questionId !== 'string' || !ID_PATTERN.test(questionId)) return INVALID;
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0 || rev > MAX_REV) return INVALID;

  // choiceId와 text 중 정확히 하나만(둘 다 없거나 둘 다 있으면 INVALID). null은 "있는 것"으로 보지 않고 거부한다.
  if (choiceId !== undefined && text !== undefined) return INVALID;
  if (choiceId !== undefined) {
    if (typeof choiceId !== 'string' || !ID_PATTERN.test(choiceId)) return INVALID;
    return { questionId, rev, choiceId };
  }
  if (typeof text !== 'string') return INVALID;
  if (hasControlChars(text, true) || hasLoneSurrogate(text)) return INVALID;
  if (codePointLength(text) > MAX_ANSWER_LENGTH) return { code: 'TOO_LONG' };
  return { questionId, rev, text };
}

/**
 * 답안 저장. 응시 행을 잠근 안에서 토큰·상태·마감을 다시 확인하므로, 같은 응시의 제출·타임아웃·종료와 직렬화된다.
 * @param tokenHash 소켓이 인증할 때의 세션 토큰 해시. DB의 현재 해시와 다르면(세션 폐기·재발급) 거부한다.
 * @param now 서버 시계(클라이언트가 보낸 시각은 쓰지 않는다)
 */
export async function saveAnswer(attemptId: string, tokenHash: string, payload: unknown, now: Date): Promise<SaveResult> {
  const parsed = parseSave(payload);
  if ('code' in parsed) return { ok: false, code: parsed.code };

  return runExamTx(async (tx): Promise<SaveResult> => {
    const rows = await tx.$queryRaw<{ state: string; sessionTokenHash: string; examId: string; extraSeconds: number }[]>`
      SELECT "state", "sessionTokenHash", "examId", "extraSeconds" FROM "Attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
    const attempt = rows[0];
    if (!attempt || attempt.sessionTokenHash !== tokenHash) return { ok: false, code: 'NOT_ACTIVE', revoked: true };
    if (attempt.state !== 'ACTIVE') return { ok: false, code: 'NOT_ACTIVE' };

    const exam = await tx.exam.findUniqueOrThrow({ where: { id: attempt.examId }, select: { status: true, endsAt: true } });
    if (exam.status !== 'RUNNING' || !exam.endsAt) return { ok: false, code: 'NOT_ACTIVE' };
    if (now.getTime() >= exam.endsAt.getTime() + attempt.extraSeconds * 1000) return { ok: false, code: 'NOT_ACTIVE' };

    const question = await tx.question.findFirst({ where: { id: parsed.questionId, examId: attempt.examId } });
    if (!question) return { ok: false, code: 'INVALID' };
    if (question.type === 'MCQ') {
      if (parsed.choiceId === undefined) return { ok: false, code: 'INVALID' };
      const choices = Array.isArray(question.choices) ? (question.choices as { id?: unknown }[]) : [];
      if (!choices.some((c) => c.id === parsed.choiceId)) return { ok: false, code: 'INVALID' };
    } else if (parsed.text === undefined) {
      return { ok: false, code: 'INVALID' };
    }
    const data = question.type === 'MCQ' ? { choiceId: parsed.choiceId!, text: null } : { choiceId: null, text: parsed.text! };

    const where = { attemptId_questionId: { attemptId, questionId: parsed.questionId } };
    const existing = await tx.answer.findUnique({ where });
    if (!existing) {
      const created = await tx.answer.create({ data: { attemptId, questionId: parsed.questionId, rev: parsed.rev, savedAt: now, ...data } });
      return { ok: true, savedAt: created.savedAt };
    }
    if (parsed.rev === existing.rev) {
      // 같은 rev의 재전송(ack 유실)은 멱등 성공. 내용이 다르면 rev가 올라가지 않은 변경이므로 거부한다.
      return existing.choiceId === data.choiceId && existing.text === data.text ? { ok: true, savedAt: existing.savedAt } : { ok: false, code: 'STALE_REV' };
    }
    // 조건부 쓰기: 행 잠금 안이지만 where에 rev 조건을 한 번 더 둔다.
    const updated = await tx.answer.updateMany({ where: { attemptId, questionId: parsed.questionId, rev: { lt: parsed.rev } }, data: { ...data, rev: parsed.rev, savedAt: now } });
    return updated.count === 1 ? { ok: true, savedAt: now } : { ok: false, code: 'STALE_REV' };
  });
}

const EVENT_FOR: Record<SubmitReason, AttemptEvent> = { STUDENT: 'SUBMIT', TIMEOUT: 'TIMEOUT', EXAM_ENDED: 'EXAM_END' };

/**
 * 응시 하나의 객관식 답안을 채점한다(Answer.awardedPoints = gradeMcq). 서술형은 건드리지 않는다.
 * 제출(submitInTx)과 감독관 강제 종료(TERMINATE)가 같은 규칙을 쓰도록 분리했다. 응시 행을 잠근 트랜잭션 안에서 호출한다.
 */
export async function gradeMcqAnswers(tx: Tx, attemptId: string): Promise<void> {
  const answers = await tx.answer.findMany({ where: { attemptId }, include: { question: true } });
  for (const answer of answers) {
    if (answer.question.type !== 'MCQ' || answer.question.correctChoiceId === null) continue;
    const points = gradeMcq({ points: answer.question.points, correctChoiceId: answer.question.correctChoiceId }, answer.choiceId);
    await tx.answer.update({ where: { id: answer.id }, data: { awardedPoints: points } });
  }
}

/**
 * 트랜잭션 안에서 응시 하나를 제출 처리한다(상태 전이 + submittedAt·submitReason + 객관식 채점).
 * 응시 행을 잠근 뒤 다시 읽으므로 같은 응시의 저장·다른 제출과 직렬화된다. 이미 종착이면 아무것도 바꾸지 않는다(멱등).
 * TIMEOUT은 잠근 뒤에도 마감이 지났을 때만 적용한다(추가 시간이 그 사이 부여된 경우를 지킨다).
 * 호출자는 시험 행 잠금을 먼저 잡아야 한다(잠금 순서: 시험 → 응시).
 *
 * 채점 규칙: 객관식 Answer의 awardedPoints = gradeMcq. 행이 없는 미답 문항은 행을 만들지 않고 0점으로 본다.
 * 서술형은 자동 채점하지 않는다(awardedPoints 유지 = null).
 */
export async function submitInTx(tx: Tx, attemptId: string, reason: SubmitReason, now: Date): Promise<{ attempt: Attempt & { exam: Exam }; changed: boolean }> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
  if (!locked[0]) throw new AppError(404, 'NOT_FOUND', '응시를 찾을 수 없습니다.');
  const current = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId }, include: { exam: true } });
  if (TERMINAL.has(current.state)) return { attempt: current, changed: false };
  if (reason === 'TIMEOUT') {
    const endsAt = current.exam.endsAt;
    if (!endsAt || now.getTime() < endsAt.getTime() + current.extraSeconds * 1000) return { attempt: current, changed: false };
  }

  const next = nextState(current.state, EVENT_FOR[reason], { ready: current.consentAt !== null && current.envCheckedAt !== null, examRunning: current.exam.status === 'RUNNING' });
  await gradeMcqAnswers(tx, attemptId);
  const attempt = await tx.attempt.update({
    where: { id: attemptId },
    data: { state: next, submittedAt: now, submitReason: reason },
    include: { exam: true },
  });
  return { attempt, changed: true };
}

/** 응시 제출(학생 제출·마감·시험 종료). 이미 종착이면 그대로 돌려준다(멱등). 커밋 뒤 알림은 실패해도 상태를 되돌리지 않는다. */
export async function submitAttempt(attemptId: string, reason: SubmitReason, now: Date = new Date()): Promise<Attempt> {
  const found = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { examId: true } });
  if (!found) throw new AppError(404, 'NOT_FOUND', '응시를 찾을 수 없습니다.');
  const { attempt, changed } = await runExamTx(async (tx) => {
    await lockExam(tx, found.examId);
    return submitInTx(tx, attemptId, reason, now);
  });
  if (changed) notify(() => broadcast.attemptState(attempt, attempt.exam));
  if (changed) void broadcast.attemptUpdated(attempt.id);
  return attempt;
}
