import { describe, expect, it } from 'vitest';
import type { AttemptState } from '@exam/shared';
import { InvalidTransitionError, nextState, type AttemptEvent } from '../../src/domain/attemptMachine';

const on = { ready: true, examRunning: true };
const off = { ready: false, examRunning: true };

const ALL_EVENTS: AttemptEvent[] = [
  'EXAM_START', 'READY', 'APPROVE', 'REJECT', 'PAUSE', 'RESUME',
  'SUBMIT', 'TIMEOUT', 'EXAM_END', 'TERMINATE',
];
const ALL_STATES: AttemptState[] = [
  'WAITING', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'SUBMITTED', 'TERMINATED', 'REJECTED',
];

describe('nextState (SPEC 2.2 표)', () => {
  it('WAITING + EXAM_START: 준비 완료면 ACTIVE', () => {
    expect(nextState('WAITING', 'EXAM_START', on)).toBe('ACTIVE');
  });
  it('WAITING + EXAM_START: 준비 미완료면 WAITING 유지', () => {
    expect(nextState('WAITING', 'EXAM_START', off)).toBe('WAITING');
  });
  it('WAITING + READY: 시험 진행 중 + 준비 완료면 ACTIVE', () => {
    expect(nextState('WAITING', 'READY', on)).toBe('ACTIVE');
  });
  it('WAITING + READY: 시험이 진행 중이 아니면 WAITING 유지', () => {
    expect(nextState('WAITING', 'READY', { ready: true, examRunning: false })).toBe('WAITING');
  });
  it('PENDING_APPROVAL + APPROVE → WAITING', () => {
    expect(nextState('PENDING_APPROVAL', 'APPROVE', on)).toBe('WAITING');
  });
  it('PENDING_APPROVAL + REJECT → REJECTED', () => {
    expect(nextState('PENDING_APPROVAL', 'REJECT', on)).toBe('REJECTED');
  });
  it('PENDING_APPROVAL + EXAM_END → REJECTED', () => {
    expect(nextState('PENDING_APPROVAL', 'EXAM_END', on)).toBe('REJECTED');
  });
  it('ACTIVE + PAUSE → PAUSED', () => {
    expect(nextState('ACTIVE', 'PAUSE', on)).toBe('PAUSED');
  });
  it('PAUSED + RESUME → ACTIVE', () => {
    expect(nextState('PAUSED', 'RESUME', on)).toBe('ACTIVE');
  });
  it('PAUSED + TIMEOUT → SUBMITTED', () => {
    expect(nextState('PAUSED', 'TIMEOUT', on)).toBe('SUBMITTED');
  });
  it('ACTIVE/PAUSED/WAITING + SUBMIT → SUBMITTED', () => {
    expect(nextState('ACTIVE', 'SUBMIT', on)).toBe('SUBMITTED');
    expect(nextState('PAUSED', 'SUBMIT', on)).toBe('SUBMITTED');
    expect(nextState('WAITING', 'SUBMIT', on)).toBe('SUBMITTED');
  });
  it('ACTIVE/WAITING + TIMEOUT → SUBMITTED', () => {
    expect(nextState('ACTIVE', 'TIMEOUT', on)).toBe('SUBMITTED');
    expect(nextState('WAITING', 'TIMEOUT', on)).toBe('SUBMITTED');
  });
  it('WAITING + EXAM_END → SUBMITTED', () => {
    expect(nextState('WAITING', 'EXAM_END', on)).toBe('SUBMITTED');
  });
  it('ACTIVE/PAUSED + EXAM_END → SUBMITTED', () => {
    expect(nextState('ACTIVE', 'EXAM_END', on)).toBe('SUBMITTED');
    expect(nextState('PAUSED', 'EXAM_END', on)).toBe('SUBMITTED');
  });
  it('ACTIVE/PAUSED + TERMINATE → TERMINATED', () => {
    expect(nextState('ACTIVE', 'TERMINATE', on)).toBe('TERMINATED');
    expect(nextState('PAUSED', 'TERMINATE', on)).toBe('TERMINATED');
  });

  it('표에 없는 전이는 InvalidTransitionError', () => {
    expect(() => nextState('SUBMITTED', 'RESUME', on)).toThrow(InvalidTransitionError);
    expect(() => nextState('WAITING', 'PAUSE', on)).toThrow(InvalidTransitionError);
    expect(() => nextState('REJECTED', 'APPROVE', on)).toThrow(InvalidTransitionError);
  });

  it('InvalidTransitionError는 code INVALID_TRANSITION을 가진다', () => {
    let caught: unknown;
    try {
      nextState('REJECTED', 'APPROVE', on);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as InvalidTransitionError).code).toBe('INVALID_TRANSITION');
  });

  it('종착 상태(SUBMITTED, TERMINATED, REJECTED)는 모든 이벤트를 거부한다', () => {
    const terminals: AttemptState[] = ['SUBMITTED', 'TERMINATED', 'REJECTED'];
    for (const s of terminals) {
      for (const e of ALL_EVENTS) {
        expect(() => nextState(s, e, on), `${s}+${e}`).toThrow(InvalidTransitionError);
      }
    }
  });

  it('표에 없는 모든 조합은 InvalidTransitionError (전수 검사)', () => {
    const allowed = new Set([
      'WAITING:EXAM_START', 'WAITING:READY', 'WAITING:SUBMIT', 'WAITING:TIMEOUT', 'WAITING:EXAM_END',
      'PENDING_APPROVAL:APPROVE', 'PENDING_APPROVAL:REJECT', 'PENDING_APPROVAL:EXAM_END',
      'ACTIVE:PAUSE', 'ACTIVE:SUBMIT', 'ACTIVE:TIMEOUT', 'ACTIVE:EXAM_END', 'ACTIVE:TERMINATE',
      'PAUSED:RESUME', 'PAUSED:SUBMIT', 'PAUSED:TIMEOUT', 'PAUSED:EXAM_END', 'PAUSED:TERMINATE',
    ]);
    for (const s of ALL_STATES) {
      for (const e of ALL_EVENTS) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => nextState(s, e, on), `${s}+${e}`).toThrow(InvalidTransitionError);
      }
    }
  });
});
