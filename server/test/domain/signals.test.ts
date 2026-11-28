import { describe, expect, it } from 'vitest';
import {
  countsAsViolation,
  detectNetworkIncident,
  isNetworkSignal,
  maxSeverity,
  shouldAutoPause,
  signalSeverity,
} from '../../src/domain/signals';

describe('signalSeverity', () => {
  it.each([
    ['LEAVE', 2999, 'INFO'],
    ['LEAVE', 3000, 'WARN'],
    ['LEAVE', 15000, 'WARN'],
    ['LEAVE', 15001, 'ALERT'],
    ['LEAVE_START', null, 'WARN'],
    ['FULLSCREEN_EXIT', null, 'WARN'],
    ['PASTE', null, 'WARN'],
    ['DROP', null, 'WARN'],
    ['DISCONNECT', null, 'WARN'],
    ['HEARTBEAT_GAP', null, 'WARN'],
    ['SEQ_GAP', null, 'WARN'],
    ['RECONNECT', null, 'INFO'],
    ['SIDEBAR_SUSPECT', null, 'INFO'],
  ] as const)('%s %s -> %s', (type, ms, sev) => {
    expect(signalSeverity(type, ms)).toBe(sev);
  });
});

describe('countsAsViolation', () => {
  it('LEAVE는 3000ms 이상만 ACTIVE에서 위반', () => {
    expect(countsAsViolation('LEAVE', 3000, 'ACTIVE')).toBe(true);
    expect(countsAsViolation('LEAVE', 2999, 'ACTIVE')).toBe(false);
    expect(countsAsViolation('LEAVE', null, 'ACTIVE')).toBe(false);
    expect(countsAsViolation('LEAVE', 3000, 'PAUSED')).toBe(false);
  });
  it.each(['FULLSCREEN_EXIT', 'PASTE', 'DROP'] as const)('%s는 ACTIVE에서만 위반', (t) => {
    expect(countsAsViolation(t, null, 'ACTIVE')).toBe(true);
    expect(countsAsViolation(t, null, 'PAUSED')).toBe(false);
    expect(countsAsViolation(t, null, 'WAITING')).toBe(false);
  });
  it.each(['DISCONNECT', 'HEARTBEAT_GAP', 'SEQ_GAP', 'MULTI_MONITOR', 'LEAVE_START', 'RECONNECT', 'SIDEBAR_SUSPECT'] as const)(
    '%s는 항상 위반 아님',
    (t) => {
      expect(countsAsViolation(t, 99999, 'ACTIVE')).toBe(false);
    },
  );
});

describe('maxSeverity', () => {
  it.each([
    ['NONE', 'INFO', 'INFO'],
    ['ALERT', 'INFO', 'ALERT'],
    ['WARN', 'WARN', 'WARN'],
    ['INFO', 'ALERT', 'ALERT'],
  ] as const)('%s,%s -> %s', (a, b, r) => {
    expect(maxSeverity(a, b)).toBe(r);
  });
});

describe('isNetworkSignal', () => {
  it('DISCONNECT·HEARTBEAT_GAP·SEQ_GAP만 true', () => {
    expect(isNetworkSignal('DISCONNECT')).toBe(true);
    expect(isNetworkSignal('HEARTBEAT_GAP')).toBe(true);
    expect(isNetworkSignal('SEQ_GAP')).toBe(true);
    expect(isNetworkSignal('RECONNECT')).toBe(false);
    expect(isNetworkSignal('LEAVE')).toBe(false);
  });
});

describe('shouldAutoPause', () => {
  it.each([
    [0, false],
    [4, false],
    [5, true],
    [6, false],
    [10, true],
  ])('%i -> %s', (n, r) => {
    expect(shouldAutoPause(n)).toBe(r);
  });
});

describe('detectNetworkIncident', () => {
  const now = 100_000;
  const ev = (id: string, ago: number) => ({ attemptId: id, at: now - ago });

  it('10초 안에 서로 다른 3명이면 객체', () => {
    const r = detectNetworkIncident([ev('a', 1000), ev('b', 2000), ev('c', 3000)], 100, now);
    expect(r?.count).toBe(3);
    expect([...(r?.attemptIds ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect(r?.since).toBe(now - 3000);
  });
  it('같은 학생 3건은 1명으로 세어 null', () => {
    expect(detectNetworkIncident([ev('a', 1), ev('a', 2), ev('a', 3)], 100, now)).toBeNull();
  });
  it('2명(응시 100명)이면 null', () => {
    expect(detectNetworkIncident([ev('a', 1), ev('b', 2)], 100, now)).toBeNull();
  });
  it('응시 20명 중 6명(30%)이면 객체', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => ev(i, 100));
    expect(detectNetworkIncident(six, 20, now)?.count).toBe(6);
  });
  it('비율 조건만으로 충족: 응시 5명 중 2명(40%)이면 객체', () => {
    expect(detectNetworkIncident([ev('a', 1), ev('b', 2)], 5, now)?.count).toBe(2);
  });
  it('비율 미달: 응시 20명 중 2명(10%)은 null', () => {
    expect(detectNetworkIncident([ev('a', 1), ev('b', 2)], 20, now)).toBeNull();
  });
  it('totalAttempts 0이면 비율 조건은 무시', () => {
    expect(detectNetworkIncident([ev('a', 1)], 0, now)).toBeNull();
  });
  it('윈도 경계: 정확히 10초 전은 포함, 10초 1ms 전은 제외', () => {
    expect(detectNetworkIncident([ev('a', 10000), ev('b', 10000), ev('c', 10000)], 100, now)?.count).toBe(3);
    expect(detectNetworkIncident([ev('a', 10001), ev('b', 10001), ev('c', 10001)], 100, now)).toBeNull();
  });
  it('10초보다 오래된 이벤트는 제외', () => {
    expect(detectNetworkIncident([ev('a', 1000), ev('b', 2000), ev('c', 20000)], 100, now)).toBeNull();
  });
  it('최소 2명 규칙: 응시 1명만 끊겨도 응시 인원 1~3명이면 null', () => {
    for (const total of [1, 2, 3]) {
      expect(detectNetworkIncident([ev('a', 1)], total, now)).toBeNull();
    }
  });
  it('최소 2명 규칙: 2명이 응시 3명 중(67%)이면 객체', () => {
    const r = detectNetworkIncident([ev('a', 1), ev('b', 2)], 3, now);
    expect(r?.count).toBe(2);
  });
  it('최소 2명 규칙: 2명이 응시 10명 중(20%)이면 null', () => {
    expect(detectNetworkIncident([ev('a', 1), ev('b', 2)], 10, now)).toBeNull();
  });
  it('3명 이상이면 응시 100명이어도 객체', () => {
    expect(detectNetworkIncident([ev('a', 1), ev('b', 2), ev('c', 3)], 100, now)?.count).toBe(3);
  });
});
