// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./staffApi', async (orig) => ({ ...(await orig<typeof import('./staffApi')>()), listExams: vi.fn(), createExam: vi.fn(), deleteExam: vi.fn() }));

import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { ExamListPage } from './ExamListPage';
import * as staffApi from './staffApi';

const row = (id: string, title: string, status: 'DRAFT' | 'OPEN' | 'RUNNING' | 'ENDED') => ({
  id,
  title,
  status,
  ownerName: '김교수',
  rosterCount: 20,
  attemptCount: 0,
  createdAt: '2026-11-20T00:00:00.000Z',
});

beforeEach(() => {
  vi.mocked(staffApi.listExams).mockResolvedValue({
    exams: [row('a', '진행중 시험', 'RUNNING'), row('b', '준비중 시험', 'DRAFT'), row('c', '종료된 시험', 'ENDED')],
  });
  vi.mocked(staffApi.deleteExam).mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <ExamListPage />
    </MemoryRouter>,
  );

describe('시험 목록(S-02)', () => {
  it('RUNNING 시험의 [삭제]는 비활성이고 이유가 표시된다(F-02 AC)', async () => {
    renderPage();
    const running = (await screen.findByText('진행중 시험')).closest('tr')!;
    expect((within(running).getByRole('button', { name: t.staff.list.remove }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(running).getByText(t.staff.list.removeDisabled)).toBeTruthy();
    const draft = screen.getByText('준비중 시험').closest('tr')!;
    expect((within(draft).getByRole('button', { name: t.staff.list.remove }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('삭제는 확인 대화상자에서 확인한 뒤에만 호출된다', async () => {
    renderPage();
    const draft = (await screen.findByText('준비중 시험')).closest('tr')!;
    fireEvent.click(within(draft).getByRole('button', { name: t.staff.list.remove }));
    expect(staffApi.deleteExam).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t.staff.common.confirm }));
    await waitFor(() => expect(staffApi.deleteExam).toHaveBeenCalledWith('b'));
  });

  it('새 시험을 만들면 서버에 제목·안내문·제한 시간을 보낸다', async () => {
    vi.mocked(staffApi.createExam).mockResolvedValue({ exam: { id: 'new' } });
    renderPage();
    await screen.findByText('진행중 시험');
    fireEvent.change(screen.getByLabelText(t.staff.list.title), { target: { value: '기말' } });
    fireEvent.change(screen.getByLabelText(t.staff.list.duration), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.list.create }));
    await waitFor(() => expect(staffApi.createExam).toHaveBeenCalledWith({ title: '기말', instructions: '', durationMin: 45 }));
  });

  it('목록 조회 실패는 한국어 오류 문구로 보인다', async () => {
    vi.mocked(staffApi.listExams).mockRejectedValue(new ApiError(500, 'INTERNAL'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.INTERNAL);
  });
});
