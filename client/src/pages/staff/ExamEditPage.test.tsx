// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./staffApi', async (orig) => ({
  ...(await orig<typeof import('./staffApi')>()),
  getExam: vi.fn(),
  putQuestions: vi.fn(),
  putRoster: vi.fn(),
  patchExam: vi.fn(),
}));

import { t } from '../../copy/ko';
import { ExamEditPage } from './ExamEditPage';
import * as staffApi from './staffApi';
import { makeExam } from './testUtil';

const exam = makeExam({
  questions: [{ id: 'q1', position: 0, type: 'MCQ', prompt: '1+1은?', points: 5, choices: [{ id: 'c1', text: '2' }], correctChoiceId: 'c1' }],
});

beforeEach(() => {
  vi.mocked(staffApi.getExam).mockResolvedValue({ exam });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[`/staff/exams/${exam.id}/edit`]}>
      <Routes>
        <Route path="/staff/exams/:id/edit" element={<ExamEditPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('시험 편집(S-03)', () => {
  it('객관식 보기 1개로 저장하면 서버 오류(index 0, choices)가 그 문항 아래에 표시된다(F-03 AC)', async () => {
    vi.mocked(staffApi.putQuestions).mockRejectedValue(
      new staffApi.DetailedApiError(400, 'INVALID_INPUT', [{ index: 0, field: 'choices', code: 'CHOICES_COUNT' }]),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: t.staff.edit.tabs.questions }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.edit.saveQuestions }));
    const group = await screen.findByRole('group', { name: t.staff.edit.questionLabel(1) });
    const alert = await within(group).findByRole('alert');
    expect(alert.textContent).toContain(t.staff.edit.questionErrors.CHOICES_COUNT);
    expect(staffApi.putQuestions).toHaveBeenCalledTimes(1);
  });

  it('명단 CSV 오류는 "2번째 줄" 문구로 표시된다(F-04 AC)', async () => {
    vi.mocked(staffApi.putRoster).mockRejectedValue(
      new staffApi.DetailedApiError(400, 'INVALID_INPUT', [{ line: 2, code: 'DUPLICATE', message: '중복 학번' }]),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: t.staff.edit.tabs.roster }));
    fireEvent.change(screen.getByLabelText(t.staff.edit.rosterCsv), { target: { value: '학번,이름\n1,가\n1,나' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.edit.saveRoster }));
    expect((await screen.findByRole('alert')).textContent).toContain('2번째 줄: 중복 학번');
  });

  it('명단 저장 성공 시 저장 인원을 알려 준다', async () => {
    vi.mocked(staffApi.putRoster).mockResolvedValue({ rosterCount: 2 });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: t.staff.edit.tabs.roster }));
    fireEvent.change(screen.getByLabelText(t.staff.edit.rosterCsv), { target: { value: '1,가\n2,나' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.edit.saveRoster }));
    expect(await screen.findByText(t.staff.edit.rosterSaved(2))).toBeTruthy();
    expect(staffApi.putRoster).toHaveBeenCalledWith(exam.id, '1,가\n2,나');
  });

  it('DRAFT가 아닌 시험은 문항·명단 저장이 비활성이다', async () => {
    vi.mocked(staffApi.getExam).mockResolvedValue({ exam: { ...exam, status: 'OPEN' } });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: t.staff.edit.tabs.questions }));
    expect((screen.getByRole('button', { name: t.staff.edit.saveQuestions }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(t.staff.edit.readOnly).length).toBeGreaterThan(0);
  });

  it('서버로 보내는 문항에는 화면에서 만든 보기 id와 정답이 들어간다', async () => {
    vi.mocked(staffApi.getExam).mockResolvedValue({ exam: makeExam() });
    vi.mocked(staffApi.putQuestions).mockResolvedValue({ questions: [] });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: t.staff.edit.tabs.questions }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.edit.addMcq }));
    const group = screen.getByRole('group', { name: t.staff.edit.questionLabel(1) });
    fireEvent.change(within(group).getByLabelText(t.staff.edit.prompt), { target: { value: '질문' } });
    fireEvent.change(within(group).getByLabelText(t.staff.edit.choice(1)), { target: { value: '가' } });
    fireEvent.change(within(group).getByLabelText(t.staff.edit.choice(2)), { target: { value: '나' } });
    fireEvent.click(within(group).getByRole('radio', { name: `${t.staff.edit.choice(2)} ${t.staff.edit.correct}` }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.edit.saveQuestions }));
    await waitFor(() => expect(staffApi.putQuestions).toHaveBeenCalled());
    const sent = vi.mocked(staffApi.putQuestions).mock.calls[0]![1];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'MCQ', prompt: '질문', points: 1, choices: [{ text: '가' }, { text: '나' }] });
    expect(sent[0]!.correctChoiceId).toBe(sent[0]!.choices![1]!.id);
  });
});
