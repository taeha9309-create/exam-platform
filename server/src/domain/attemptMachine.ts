import type { AttemptState } from '@exam/shared';

/** 응시 상태를 바꾸는 이벤트 (SPEC 2.2 표) */
export type AttemptEvent =
  | 'EXAM_START'
  | 'READY'
  | 'APPROVE'
  | 'REJECT'
  | 'PAUSE'
  | 'RESUME'
  | 'SUBMIT'
  | 'TIMEOUT'
  | 'EXAM_END'
  | 'TERMINATE';

/** 전이 판단에 필요한 시험 쪽 조건 */
export interface TransitionContext {
  /** 준비 완료 = 동의 + 환경 점검 */
  ready: boolean;
  /** 시험이 RUNNING 상태인지 */
  examRunning: boolean;
}

/** 표에 없는 (상태, 이벤트) 조합을 바꾸려 할 때 던진다 */
export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION' as const;

  constructor(
    readonly from: AttemptState,
    readonly event: AttemptEvent,
  ) {
    super(`응시 상태 ${from}에서 ${event} 이벤트는 허용되지 않습니다`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * 응시 상태 전이 (SPEC 2.2).
 * 전이 조건을 만족하지 않는 이벤트(예: 준비 미완료 상태의 EXAM_START)는
 * 오류가 아니라 현재 상태를 그대로 돌려준다. 표 자체에 없는 조합만 오류다.
 */
export function nextState(
  current: AttemptState,
  event: AttemptEvent,
  ctx: TransitionContext,
): AttemptState {
  switch (current) {
    case 'WAITING':
      switch (event) {
        case 'EXAM_START':
          return ctx.ready ? 'ACTIVE' : 'WAITING';
        case 'READY':
          return ctx.ready && ctx.examRunning ? 'ACTIVE' : 'WAITING';
        case 'SUBMIT':
        case 'TIMEOUT':
        case 'EXAM_END':
          return 'SUBMITTED';
      }
      break;

    case 'PENDING_APPROVAL':
      switch (event) {
        case 'APPROVE':
          return 'WAITING';
        case 'REJECT':
        case 'EXAM_END':
          return 'REJECTED';
      }
      break;

    case 'ACTIVE':
      switch (event) {
        case 'PAUSE':
          return 'PAUSED';
        case 'SUBMIT':
        case 'TIMEOUT':
        case 'EXAM_END':
          return 'SUBMITTED';
        case 'TERMINATE':
          return 'TERMINATED';
      }
      break;

    case 'PAUSED':
      switch (event) {
        case 'RESUME':
          return 'ACTIVE';
        case 'SUBMIT':
        case 'TIMEOUT':
        case 'EXAM_END':
          return 'SUBMITTED';
        case 'TERMINATE':
          return 'TERMINATED';
      }
      break;

    // SUBMITTED, TERMINATED, REJECTED는 종착 상태 (SPEC 2.2)
    default:
      break;
  }
  throw new InvalidTransitionError(current, event);
}
