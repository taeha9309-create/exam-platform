// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./staffApi', async (orig) => ({
  ...(await orig<typeof import('./staffApi')>()),
  getExam: vi.fn(),
  openExam: vi.fn(),
  startExam: vi.fn(),
  endExam: vi.fn(),
  regeneratePasscode: vi.fn(),
  patchExam: vi.fn(),
  resolveApproval: vi.fn(),
}));

const handlers = new Map<string, (...args: unknown[]) => void>();
const fakeSocket = {
  connected: false,
  on: vi.fn((ev: string, h: (...args: unknown[]) => void) => {
    handlers.set(ev, h);
    return fakeSocket;
  }),
  off: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('../../socket', () => ({ connectStaffSocket: () => fakeSocket }));

import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { ExamRunPage } from './ExamRunPage';
import * as staffApi from './staffApi';
import { makeExam } from './testUtil';

const Q = { id: 'q', position: 0, type: 'ESSAY' as const, prompt: '서술', points: 5 };
const emitServer = (ev: string, payload: unknown) => act(() => handlers.get(ev)!(payload));

beforeEach(() => {
  handlers.clear();
  fakeSocket.connected = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = (exam = makeExam()) => {
  vi.mocked(staffApi.getExam).mockResolvedValue({ exam });
  return render(
    <MemoryRouter initialEntries={[`/staff/exams/${exam.id}/run`]}>
      <Routes>
        <Route path="/staff/exams/:id/run" element={<ExamRunPage />} />
      </Routes>
    </MemoryRouter>,
  );
};

describe('운영 화면', () => {
  it('문항이 없는 시험은 [입장 열기]가 비활성이고 이유가 표시된다(F-06 AC)', async () => {
    renderPage(makeExam({ questions: [], rosterCount: 3 }));
    const btn = await screen.findByRole('button', { name: t.staff.run.open });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t.staff.run.openBlocked)).toBeTruthy();
  });

  it('명단이 없어도 [입장 열기]는 비활성이다. 둘 다 있으면 활성이고 누르면 호출된다', async () => {
    const { unmount } = renderPage(makeExam({ questions: [Q], rosterCount: 0 }));
    expect((await screen.findByRole('button', { name: t.staff.run.open }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const ready = makeExam({ questions: [Q], rosterCount: 3 });
    vi.mocked(staffApi.openExam).mockResolvedValue({ exam: { ...ready, status: 'OPEN', passcode: '123456' } });
    renderPage(ready);
    const btn = await screen.findByRole('button', { name: t.staff.run.open });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(staffApi.openExam).toHaveBeenCalledWith(ready.id));
    expect(await screen.findByRole('button', { name: t.staff.run.start })).toBeTruthy();
  });

  it('[시험 종료]는 확인 대화상자에서 확인한 뒤에만 호출된다', async () => {
    const running = makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 3, endsAt: new Date(Date.now() + 600_000).toISOString() });
    vi.mocked(staffApi.endExam).mockResolvedValue({ exam: { ...running, status: 'ENDED' } });
    renderPage(running);
    fireEvent.click(await screen.findByRole('button', { name: t.staff.run.end }));
    expect(staffApi.endExam).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    // 취소하면 호출되지 않는다
    fireEvent.click(within(dialog).getByRole('button', { name: t.staff.common.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(staffApi.endExam).not.toHaveBeenCalled();
    // Esc로도 닫힌다
    fireEvent.click(screen.getByRole('button', { name: t.staff.run.end }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(staffApi.endExam).not.toHaveBeenCalled();
    // 확인하면 호출된다
    fireEvent.click(screen.getByRole('button', { name: t.staff.run.end }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.staff.common.confirm }));
    await waitFor(() => expect(staffApi.endExam).toHaveBeenCalledWith(running.id));
  });

  it('비밀번호 크게 보기: 전체 화면 오버레이에 비밀번호를 보여 주고 닫을 수 있다', async () => {
    renderPage(makeExam({ status: 'OPEN', passcode: '482913', questions: [Q], rosterCount: 3 }));
    expect(screen.queryByText('482913')).toBeNull(); // 평소에는 화면에 드러나지 않는다
    fireEvent.click(await screen.findByRole('button', { name: t.staff.run.showPasscode }));
    const overlay = screen.getByRole('dialog', { name: t.staff.run.passcodeOverlay });
    expect(within(overlay).getByText('482913')).toBeTruthy();
    fireEvent.click(within(overlay).getByRole('button', { name: t.staff.run.closeOverlay }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('비밀번호는 localStorage·sessionStorage·URL에 남지 않는다', async () => {
    renderPage(makeExam({ status: 'OPEN', passcode: '482913', questions: [Q], rosterCount: 3 }));
    fireEvent.click(await screen.findByRole('button', { name: t.staff.run.showPasscode }));
    expect(JSON.stringify({ ...localStorage })).not.toContain('482913');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('482913');
    expect(window.location.href).not.toContain('482913');
  });

  it('[재발급]은 확인 후 새 비밀번호를 오버레이에 보여 준다', async () => {
    vi.mocked(staffApi.regeneratePasscode).mockResolvedValue({ passcode: '777777' });
    renderPage(makeExam({ status: 'OPEN', passcode: '482913', questions: [Q], rosterCount: 3 }));
    fireEvent.click(await screen.findByRole('button', { name: t.staff.run.reissue }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.staff.common.confirm }));
    await waitFor(() => expect(staffApi.regeneratePasscode).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: t.staff.run.showPasscode }));
    expect(within(screen.getByRole('dialog')).getByText('777777')).toBeTruthy();
  });

  it('waiting:count 이벤트로 입장 현황 ready/total이 갱신된다', async () => {
    renderPage(makeExam({ status: 'OPEN', passcode: '482913', questions: [Q], rosterCount: 5 }));
    await screen.findByRole('button', { name: t.staff.run.start });
    fakeSocket.connected = false;
    act(() => handlers.get('connect')!());
    expect(fakeSocket.emit).toHaveBeenCalledWith('dashboard:join', { examId: makeExam().id }, expect.any(Function));
    emitServer('waiting:count', { ready: 2, total: 5 });
    expect(screen.getByText(t.staff.run.waitingCount(2, 5))).toBeTruthy();
  });

  it('승인 요청: approval:pending으로 목록에 추가되고 [승인]은 사유와 함께 서버로 간다', async () => {
    vi.mocked(staffApi.resolveApproval).mockResolvedValue({ attempt: { id: 'att-1', state: 'WAITING' } });
    renderPage(makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 5, endsAt: new Date(Date.now() + 600_000).toISOString() }));
    await screen.findByRole('button', { name: t.staff.run.end });
    expect(screen.getByText(t.staff.run.noApprovals)).toBeTruthy();
    emitServer('approval:pending', { attemptId: 'att-1', kind: 'LATE' });
    emitServer('approval:pending', { attemptId: 'att-2', kind: 'DUPLICATE' });
    const late = screen.getByText(t.staff.run.kindLate).closest('li')!;
    fireEvent.click(within(late).getByRole('button', { name: t.staff.run.approve }));
    await waitFor(() => expect(staffApi.resolveApproval).toHaveBeenCalledWith('att-1', 'APPROVE_ENTRY', t.staff.run.reasonQuick));
    await waitFor(() => expect(screen.queryByText(t.staff.run.kindLate)).toBeNull());
    // 중복 접속은 세션 조치 종류로 거절한다. 사유를 바꿔 입력할 수 있다
    const dup = screen.getByText(t.staff.run.kindDuplicate).closest('li')!;
    fireEvent.change(within(dup).getByLabelText(t.staff.run.reason), { target: { value: '본인 아님' } });
    fireEvent.click(within(dup).getByRole('button', { name: t.staff.run.reject }));
    await waitFor(() => expect(staffApi.resolveApproval).toHaveBeenCalledWith('att-2', 'REJECT_SESSION', '본인 아님'));
  });

  it('approval:resolved(다른 감독관이 처리) 이벤트는 목록에서 그 요청을 지운다', async () => {
    renderPage(makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 5, endsAt: new Date(Date.now() + 600_000).toISOString() }));
    await screen.findByRole('button', { name: t.staff.run.end });
    emitServer('approval:pending', { attemptId: 'att-9', kind: 'LATE' });
    expect(screen.getByText(t.staff.run.kindLate)).toBeTruthy();
    emitServer('approval:resolved', { attemptId: 'att-9', kind: 'LATE', approved: true });
    expect(screen.queryByText(t.staff.run.kindLate)).toBeNull();
  });

  it('스냅샷의 승인 요청은 학번·이름으로 표시되고 입장 현황은 스냅샷 초기값을 쓴다(#54)', async () => {
    renderPage(makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 5, endsAt: new Date(Date.now() + 600_000).toISOString() }));
    await screen.findByRole('button', { name: t.staff.run.end });
    expect(screen.getByText(t.staff.run.waitingCount('-', 5))).toBeTruthy();
    emitServer('dashboard:snapshot', {
      exam: { id: makeExam().id, title: 't', status: 'RUNNING', endsAt: null, lockNewEntry: false, serverNow: 0, ready: 3, total: 5 },
      attempts: [],
      pendingApprovals: [{ attemptId: 'att-1', kind: 'LATE', studentNo: '20240001', name: '홍길동' }],
      networkIncident: null,
    });
    expect(screen.getByText(t.staff.run.waitingCount(3, 5))).toBeTruthy();
    const li = screen.getByText(t.staff.run.kindLate).closest('li')!;
    expect(within(li).getByText('20240001 홍길동')).toBeTruthy();
    // 사유 기본값이 입력란에 채워져 보인다
    expect((within(li).getByLabelText(t.staff.run.reason) as HTMLInputElement).value).toBe(t.staff.run.reasonQuick);
  });

  it('이미 처리된 승인 요청(409)은 오류를 보이고 목록에서 지운다', async () => {
    vi.mocked(staffApi.resolveApproval).mockRejectedValue(new ApiError(409, 'INVALID_STATE'));
    renderPage(makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 5, endsAt: new Date(Date.now() + 600_000).toISOString() }));
    await screen.findByRole('button', { name: t.staff.run.end });
    emitServer('approval:pending', { attemptId: 'att-1', kind: 'LATE' });
    fireEvent.click(within(screen.getByText(t.staff.run.kindLate).closest('li')!).getByRole('button', { name: t.staff.run.approve }));
    await waitFor(() => expect(screen.queryByText(t.staff.run.kindLate)).toBeNull());
    expect((await screen.findByRole('alert')).textContent).toBe(t.staff.dash.resolvedGone);
  });

  it('승인 409 BUSY(일시적 충돌)는 항목을 남기고 다시 시도 안내만 보이며, 다시 눌러 성공하면 사라진다', async () => {
    vi.mocked(staffApi.resolveApproval).mockRejectedValueOnce(new ApiError(409, 'BUSY')).mockResolvedValueOnce({ attempt: { id: 'att-1', state: 'WAITING' } });
    renderPage(makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 5, endsAt: new Date(Date.now() + 600_000).toISOString() }));
    await screen.findByRole('button', { name: t.staff.run.end });
    emitServer('approval:pending', { attemptId: 'att-1', kind: 'LATE' });
    const approve = () => within(screen.getByText(t.staff.run.kindLate).closest('li')!).getByRole('button', { name: t.staff.run.approve });
    fireEvent.click(approve());
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.BUSY);
    expect(screen.getByText(t.staff.run.kindLate)).toBeTruthy();
    fireEvent.click(approve());
    await waitFor(() => expect(screen.queryByText(t.staff.run.kindLate)).toBeNull());
  });

  it('요청 중에는 버튼이 비활성이고, 409 BUSY는 다시 시도 안내 문구로 표시된다', async () => {
    const ready = makeExam({ questions: [Q], rosterCount: 3 });
    let reject!: (e: unknown) => void;
    vi.mocked(staffApi.openExam).mockReturnValue(new Promise((_, rej) => (reject = rej)));
    renderPage(ready);
    const btn = await screen.findByRole('button', { name: t.staff.run.open });
    fireEvent.click(btn);
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(btn);
    expect(staffApi.openExam).toHaveBeenCalledTimes(1);
    await act(async () => reject(new ApiError(409, 'BUSY')));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.BUSY);
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('[신규 입장 차단] 토글은 lockNewEntry를 서버에 보낸다', async () => {
    const running = makeExam({ status: 'RUNNING', questions: [Q], rosterCount: 3, endsAt: new Date(Date.now() + 600_000).toISOString() });
    vi.mocked(staffApi.patchExam).mockResolvedValue({ exam: { ...running, lockNewEntry: true } });
    renderPage(running);
    fireEvent.click(await screen.findByRole('checkbox', { name: t.staff.run.lockNewEntry }));
    await waitFor(() => expect(staffApi.patchExam).toHaveBeenCalledWith(running.id, { lockNewEntry: true }));
  });
});
