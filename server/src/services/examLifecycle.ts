import { Prisma, type Attempt, type Exam, type ExamStatus } from '@prisma/client';
import { prisma } from '../db';
import { generatePasscode } from '../domain/codes';
import { nextState } from '../domain/attemptMachine';
import { AppError } from '../errors';
import { broadcast, getIo } from '../realtime/broadcast';
import { submitInTx } from './submission';

/**
 * 시험 상태를 바꾸는 서비스(F-06)와, 시험 행 잠금 트랜잭션 도구.
 *
 * runExamTx·lockExam·EXAM_TX_OPTIONS는 원래 routes/exams.ts에 있었지만, 서비스가 라우트를 import하면
 * 순환 참조가 되므로 "의존 방향이 한쪽(routes → services)"이 되게 이쪽으로 옮겼다. 라우트는 여기서 가져다 쓴다.
 */

type Tx = Prisma.TransactionClient;

/**
 * 시험 행 잠금(FOR UPDATE) 트랜잭션의 대기·실행 한도. Prisma 기본값(maxWait 2초, timeout 5초)은
 * 같은 시험에 큰 쓰기(문항 100개 × 4000자)가 몰려 순서를 기다릴 때 부족해 P2028 → 500이 났다.
 * 대기 4건이 차례로 끝나는 시간(요청당 ~1~2초)을 넉넉히 덮도록 maxWait 10초, 실행 timeout 20초로 둔다.
 */
export const EXAM_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', '시험을 찾을 수 없습니다.');
const BUSY = () => new AppError(409, 'BUSY', '다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
const INVALID_TRANSITION = (message: string) => new AppError(409, 'INVALID_TRANSITION', message);

/** P2028(트랜잭션 시작·실행 시간 초과), P2034(직렬화 실패·교착)는 재시도하면 되는 일시적 충돌이다. */
function isTransientTxError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2028' || err.code === 'P2034');
}

/** 한도가 명시된 트랜잭션. 그래도 일시적 충돌이면 500 대신 409 BUSY(다시 시도 가능)로 바꾼다. */
export async function runExamTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, EXAM_TX_OPTIONS);
  } catch (err) {
    if (isTransientTxError(err)) throw BUSY();
    throw err;
  }
}

/**
 * 시험 행을 잠그고(SELECT ... FOR UPDATE) 상태를 읽는다. 상태 확인과 변경 사이에 다른 요청이
 * 끼어드는 경쟁 상태를 막는다. 반드시 트랜잭션 안에서 호출한다.
 */
export async function lockExam(tx: Tx, id: string): Promise<{ status: ExamStatus }> {
  const rows = await tx.$queryRaw<{ status: ExamStatus }[]>`SELECT "status" FROM "Exam" WHERE "id" = ${id} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw NOT_FOUND();
  return row;
}

/**
 * 커밋이 끝난 뒤에 실시간 알림을 보낸다. Socket.IO가 아직 없으면(테스트 등) 건너뛰고,
 * 알림 실패가 이미 확정된 상태 변경을 실패로 만들지 않도록 오류는 로그만 남긴다.
 */
export function notify(send: () => void): void {
  try {
    getIo();
  } catch {
    return;
  }
  try {
    send();
  } catch (err) {
    console.error('실시간 알림 전송 실패', err);
  }
}

/** 입장 열기: DRAFT → OPEN. 문항·명단이 각 1개 이상이어야 한다. */
export async function openExam(examId: string): Promise<Exam> {
  return runExamTx(async (tx) => {
    const { status } = await lockExam(tx, examId);
    if (status !== 'DRAFT') throw INVALID_TRANSITION('준비 중인 시험만 입장을 열 수 있습니다.');
    const [questions, roster] = await Promise.all([
      tx.question.count({ where: { examId } }),
      tx.rosterEntry.count({ where: { examId } }),
    ]);
    if (questions < 1 || roster < 1) {
      throw new AppError(409, 'NOT_READY_TO_OPEN', '문항과 명단이 각각 1개 이상 있어야 입장을 열 수 있습니다.');
    }
    return tx.exam.update({ where: { id: examId }, data: { status: 'OPEN', passcode: generatePasscode() } });
  });
}

/** 비밀번호 재발급(OPEN·RUNNING). 이미 입장한 학생은 세션 토큰을 쓰므로 영향이 없다. 직전 값과 같으면 다시 뽑는다. */
export async function regeneratePasscode(examId: string): Promise<string> {
  return runExamTx(async (tx) => {
    const { status } = await lockExam(tx, examId);
    if (status !== 'OPEN' && status !== 'RUNNING') {
      throw INVALID_TRANSITION('입장이 열려 있거나 진행 중인 시험만 비밀번호를 재발급할 수 있습니다.');
    }
    const current = await tx.exam.findUniqueOrThrow({ where: { id: examId }, select: { passcode: true } });
    let passcode = generatePasscode();
    while (passcode === current.passcode) passcode = generatePasscode();
    await tx.exam.update({ where: { id: examId }, data: { passcode } });
    return passcode;
  });
}

const isReady = (a: Pick<Attempt, 'consentAt' | 'envCheckedAt'>) => a.consentAt !== null && a.envCheckedAt !== null;

/**
 * 시험 시작: OPEN → RUNNING. 시험 행을 잠근 뒤, 조건부 업데이트(where status = OPEN)로 한 번 더 원자적으로 전이한다.
 * 0건이면 이미 시작된 것이므로 409 ALREADY_STARTED. 준비 완료된 WAITING 응시는 ACTIVE가 된다.
 */
export async function startExam(examId: string, now: Date = new Date()): Promise<Exam> {
  const { exam, changed } = await runExamTx(async (tx) => {
    const { status } = await lockExam(tx, examId);
    if (status === 'DRAFT' || status === 'ENDED') {
      throw INVALID_TRANSITION(status === 'DRAFT' ? '입장을 연 시험만 시작할 수 있습니다.' : '종료된 시험은 시작할 수 없습니다.');
    }
    const current = await tx.exam.findUniqueOrThrow({ where: { id: examId }, select: { durationMin: true } });
    const updated = await tx.exam.updateMany({
      where: { id: examId, status: 'OPEN' },
      data: { status: 'RUNNING', startedAt: now, endsAt: new Date(now.getTime() + current.durationMin * 60_000) },
    });
    if (updated.count === 0) throw new AppError(409, 'ALREADY_STARTED', '이미 시작된 시험입니다.');
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: examId } });

    const waiting = await tx.attempt.findMany({ where: { examId, state: 'WAITING' } });
    const changed: Attempt[] = [];
    for (const attempt of waiting) {
      const next = nextState(attempt.state, 'EXAM_START', { ready: isReady(attempt), examRunning: true });
      if (next === attempt.state) continue;
      changed.push(await tx.attempt.update({ where: { id: attempt.id }, data: { state: next } }));
    }
    return { exam, changed };
  });

  notify(() => {
    for (const attempt of changed) broadcast.attemptState(attempt, exam);
    broadcast.examStarted(exam);
  });
  return exam;
}

/**
 * 시험 종료: RUNNING → ENDED. 종착 전 응시는 submitInTx(EXAM_END)로 제출·채점한다(submission.ts와 순환 import지만 함수 호출 시점에만 쓴다).
 * PENDING_APPROVAL은 REJECTED가 되며 제출 사유는 없다.
 */
export async function endExam(examId: string, now: Date = new Date()): Promise<Exam> {
  const { exam, changed } = await runExamTx(async (tx) => {
    const { status } = await lockExam(tx, examId);
    if (status !== 'RUNNING') throw INVALID_TRANSITION('진행 중인 시험만 종료할 수 있습니다.');
    const exam = await tx.exam.update({ where: { id: examId }, data: { status: 'ENDED', endedAt: now } });

    const open = await tx.attempt.findMany({
      where: { examId, state: { in: ['WAITING', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] } },
      select: { id: true, state: true },
    });
    const changed: Attempt[] = [];
    for (const { id, state } of open) {
      if (state === 'PENDING_APPROVAL') {
        // 승인 대기 중이던 입장 요청은 거절된다(제출이 아니므로 제출 시각·사유 없음).
        const next = nextState(state, 'EXAM_END', { ready: false, examRunning: false });
        changed.push(await tx.attempt.update({ where: { id }, data: { state: next } }));
        continue;
      }
      // 나머지는 학생 제출·마감과 같은 로직(채점 포함)을 이 시험 잠금 트랜잭션 안에서 쓴다. 종료 중에는 저장이 끼어들 수 없다.
      const result = await submitInTx(tx, id, 'EXAM_ENDED', now);
      if (result.changed) changed.push(result.attempt);
    }
    return { exam, changed };
  });

  notify(() => {
    for (const attempt of changed) broadcast.attemptState(attempt, exam);
  });
  return exam;
}
