// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./staffApi', async (orig) => ({ ...(await orig<typeof import('./staffApi')>()), getResults: vi.fn(), gradeAnswer: vi.fn() }));

import { t } from '../../copy/ko';
import { ResultsPage } from './ResultsPage';
import * as staffApi from './staffApi';

const results: staffApi.ResultsResponse = {
  questions: [
    { id: 'q1', type: 'MCQ', points: 5, position: 0 },
    { id: 'q2', type: 'ESSAY', points: 10, position: 1 },
  ],
  rows: [
    {
      attemptId: 'att-1',
      studentNo: '2024001',
      name: '홍길동',
      state: 'SUBMITTED',
      mcqScore: 5,
      essayScore: null,
      total: null,
      signalCounts: { INFO: 1, WARN: 2, ALERT: 0 },
      actionCount: 0,
      answers: [
        { answerId: 'ans-1', questionId: 'q1', choiceId: 'c1', awardedPoints: 5 },
        { answerId: 'ans-2', questionId: 'q2', text: '<b>답안</b>', awardedPoints: null },
      ],
    },
  ],
};

beforeEach(() => {
  vi.mocked(staffApi.getResults).mockResolvedValue(results);
  vi.mocked(staffApi.gradeAnswer).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/staff/exams/e1/results']}>
      <Routes>
        <Route path="/staff/exams/:id/results" element={<ResultsPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('결과(S-06)', () => {
  it('서술형 미채점이면 서술형 점수·총점 칸에 "미채점"이 보인다', async () => {
    renderPage();
    const row = (await screen.findByText('홍길동')).closest('tr')!;
    expect(within(row).getAllByText(t.staff.results.ungraded)).toHaveLength(2);
  });

  it('서술형 점수가 배점을 넘으면 저장 버튼이 비활성이고 이유가 보인다(F-17 AC)', async () => {
    renderPage();
    await screen.findByText('홍길동');
    const input = screen.getByLabelText(t.staff.results.score('2024001 홍길동', 2));
    const save = screen.getByRole('button', { name: t.staff.results.saveGrade });
    fireEvent.change(input, { target: { value: '11' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t.staff.results.overMax(10))).toBeTruthy();
    fireEvent.change(input, { target: { value: '-1' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '7' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('범위 안 점수는 서버로 저장되고, 답안 문자열은 태그 없이 글자 그대로 보인다', async () => {
    renderPage();
    await screen.findByText('홍길동');
    expect(screen.getByText('<b>답안</b>')).toBeTruthy(); // 이스케이프되어 문자 그대로
    fireEvent.change(screen.getByLabelText(t.staff.results.score('2024001 홍길동', 2)), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.results.saveGrade }));
    await waitFor(() => expect(staffApi.gradeAnswer).toHaveBeenCalledWith('ans-2', 7));
    // 저장 후 결과를 다시 불러온다
    await waitFor(() => expect(staffApi.getResults).toHaveBeenCalledTimes(2));
  });
});
