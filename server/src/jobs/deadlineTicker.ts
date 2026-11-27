import type { Attempt, SubmitReason } from '@prisma/client';
import { prisma } from '../db';
import { attemptDeadline } from '../domain/deadline';
import { lockExam, runExamTx } from '../services/examLifecycle';
import { submitAttempt } from '../services/submission';

export interface TickDeps {
  submit: (attemptId: string, reason: SubmitReason, now: Date) => Promise<Attempt>;
  log: (...args: unknown[]) => void;
}

const defaultDeps: TickDeps = { submit: submitAttempt, log: (...args) => console.error(...args) };

/**
 * 마감 처리 1회(SPEC 2.2, F-11).
 * 1) 학생 마감(endsAt + extraSeconds)이 지난 ACTIVE/PAUSED 응시를 TIMEOUT으로 제출한다. 한 응시가 실패해도 나머지는 계속한다.
 * 2) 모든 응시가 종착이고 now > endsAt인 RUNNING 시험을 ENDED로 바꾼다.
 * @returns TIMEOUT으로 제출 처리된 응시 수
 */
export async function tickDeadlines(now: Date, deps: Partial<TickDeps> = {}): Promise<number> {
  const { submit, log } = { ...defaultDeps, ...deps };

  // extraSeconds는 0 이상이므로 exam.endsAt <= now는 필요조건이다(SQL로 후보를 줄이고, 정확한 마감은 JS에서 한 번 더 계산).
  const candidates = await prisma.attempt.findMany({
    where: { state: { in: ['ACTIVE', 'PAUSED'] }, exam: { status: 'RUNNING', endsAt: { lte: now } } },
    select: { id: true, extraSeconds: true, exam: { select: { endsAt: true } } },
  });
  let processed = 0;
  for (const c of candidates) {
    if (!c.exam.endsAt || attemptDeadline(c.exam.endsAt, c.extraSeconds).getTime() > now.getTime()) continue;
    try {
      const result = await submit(c.id, 'TIMEOUT', now);
      // 이미 다른 경로(학생 제출 등)로 종착이었다면 submittedAt이 now와 다르다. 이 틱이 처리한 것만 센다.
      if (result.submittedAt?.getTime() === now.getTime() && result.submitReason === 'TIMEOUT') processed++;
    } catch (err) {
      log('마감 처리 실패(다음 틱에 다시 시도)', c.id, err instanceof Error ? err.message : 'unknown');
    }
  }

  const running = await prisma.exam.findMany({ where: { status: 'RUNNING', endsAt: { lt: now } }, select: { id: true } });
  for (const { id } of running) {
    try {
      await runExamTx(async (tx) => {
        const { status } = await lockExam(tx, id);
        if (status !== 'RUNNING') return;
        const exam = await tx.exam.findUniqueOrThrow({ where: { id }, select: { endsAt: true } });
        if (!exam.endsAt || now.getTime() <= exam.endsAt.getTime()) return;
        const unfinished = await tx.attempt.count({ where: { examId: id, state: { notIn: ['SUBMITTED', 'TERMINATED', 'REJECTED'] } } });
        if (unfinished > 0) return;
        await tx.exam.updateMany({ where: { id, status: 'RUNNING' }, data: { status: 'ENDED', endedAt: now } });
      });
    } catch (err) {
      log('시험 자동 종료 실패(다음 틱에 다시 시도)', id, err instanceof Error ? err.message : 'unknown');
    }
  }
  return processed;
}

export interface TickerOptions {
  intervalMs?: number;
  tick?: (now: Date) => Promise<number>;
  log?: (...args: unknown[]) => void;
}

/**
 * 1초(기본)마다 tickDeadlines를 돌린다. 이전 실행이 끝나지 않았으면 이번 틱은 건너뛰고(겹침 없음),
 * 예외는 로그만 남기고 다음 틱에 계속한다. 타이머는 unref되어 프로세스 종료를 막지 않는다.
 * stop()은 타이머를 멈추고 진행 중인 실행이 끝나기를 기다린다.
 */
export function startDeadlineTicker(options: TickerOptions = {}): { stop(): Promise<void> } {
  const { intervalMs = 1000, tick = tickDeadlines, log = (...args: unknown[]) => console.error(...args) } = options;
  let running: Promise<void> | null = null;
  let stopped = false;

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = (async () => {
      try {
        await tick(new Date());
      } catch (err) {
        log('마감 티커 오류', err instanceof Error ? err.message : 'unknown');
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
    },
  };
}
