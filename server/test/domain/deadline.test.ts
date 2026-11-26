import { describe, expect, it } from 'vitest';
import { attemptDeadline, remainingMs } from '../../src/domain/deadline';

describe('attemptDeadline', () => {
  it('endsAt + extraSeconds를 계산한다', () => {
    const d = attemptDeadline(new Date('2026-12-01T01:00:00Z'), 600);
    expect(d.toISOString()).toBe('2026-12-01T01:10:00.000Z');
  });
  it('extraSeconds가 0이면 endsAt과 같다', () => {
    const d = attemptDeadline(new Date('2026-12-01T01:00:00Z'), 0);
    expect(d.toISOString()).toBe('2026-12-01T01:00:00.000Z');
  });
  it('원본 Date를 바꾸지 않는다', () => {
    const endsAt = new Date('2026-12-01T01:00:00Z');
    attemptDeadline(endsAt, 60);
    expect(endsAt.toISOString()).toBe('2026-12-01T01:00:00.000Z');
  });
});

describe('remainingMs', () => {
  const deadline = new Date('2026-12-01T01:10:00Z');
  it('마감까지 남은 밀리초를 돌려준다', () => {
    expect(remainingMs(deadline, new Date('2026-12-01T01:09:30Z'))).toBe(30_000);
  });
  it('마감이 지났으면 0', () => {
    expect(remainingMs(deadline, new Date('2026-12-01T01:11:00Z'))).toBe(0);
  });
  it('마감 시각 정확히 도달하면 0', () => {
    expect(remainingMs(deadline, deadline)).toBe(0);
  });
});
