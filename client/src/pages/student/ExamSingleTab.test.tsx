// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../student/studentApi', async (orig) => ({
  ...(await orig<typeof import('../../student/studentApi')>()),
  getStudentExam: vi.fn(),
  postSubmit: vi.fn(),
}));

import { t } from '../../copy/ko';
import type { LockManagerLike } from '../../student/useSingleTabGuard';
import * as api from '../../student/studentApi';
import { ExamTaking, type ExamSocket } from './ExamTaking';

const emit = vi.fn();
const socket = { connected: true, on: vi.fn(), off: vi.fn(), emit, timeout: () => ({ emit: vi.fn() }) };

/** 항상 락이 이미 다른 탭에 있는 상태 */
const heldElsewhere: LockManagerLike = { request: vi.fn((_n, _o, cb) => Promise.resolve(cb(null))) as LockManagerLike['request'] };

function renderTaking(locks: LockManagerLike | null) {
  return render(
    <ExamTaking
      examCode="ABCD2345"
      token="tok"
      socket={socket as unknown as ExamSocket}
      state="ACTIVE"
      deadline={Date.now() + 600_000}
      clock={{ now: () => Date.now() }}
      violationCount={0}
      connected
      onRefresh={vi.fn()}
      locks={locks}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(api.getStudentExam).mockResolvedValue({ questions: [], answers: [] } as unknown as api.StudentExam);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('응시 화면 단일 탭 (#95)', () => {
  it('락을 못 얻은 탭은 안내만 보이고 문항 조회·신호 전송을 시작하지 않는다', async () => {
    renderTaking(heldElsewhere);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('alert').textContent).toBe(t.student.taking.otherTab);
    expect(api.getStudentExam).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalled();
  });

  it('미지원 환경(locks=null)에서는 기존대로 문항을 불러온다', async () => {
    renderTaking(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getStudentExam).toHaveBeenCalled();
    expect(screen.queryByText(t.student.taking.otherTab)).toBeNull();
  });
});
