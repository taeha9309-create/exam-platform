// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./staffApi', async (orig) => ({ ...(await orig<typeof import('./staffApi')>()), login: vi.fn(), getSurvey: vi.fn() }));

import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { LoginPage } from './LoginPage';
import { SurveyPage } from './SurveyPage';
import * as staffApi from './staffApi';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('로그인(S-01)', () => {
  const renderLogin = () =>
    render(
      <MemoryRouter initialEntries={['/staff/login']}>
        <Routes>
          <Route path="/staff/login" element={<LoginPage />} />
          <Route path="/staff/exams" element={<p>목록 화면</p>} />
        </Routes>
      </MemoryRouter>,
    );

  it('틀린 계정은 열거 방지 문구를 그대로 표시한다(F-01 AC)', async () => {
    vi.mocked(staffApi.login).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS'));
    renderLogin();
    fireEvent.change(screen.getByLabelText(t.staff.login.email), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(t.staff.login.password), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.login.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe('이메일 또는 비밀번호가 올바르지 않습니다.');
  });

  it('로그인에 성공하면 시험 목록으로 이동한다', async () => {
    vi.mocked(staffApi.login).mockResolvedValue({ staff: { id: '1', name: '김', email: 'a@b.c' } });
    renderLogin();
    fireEvent.change(screen.getByLabelText(t.staff.login.email), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(t.staff.login.password), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.login.submit }));
    expect(await screen.findByText('목록 화면')).toBeTruthy();
    expect(staffApi.login).toHaveBeenCalledWith('a@b.c', 'pw');
  });

  it('비밀번호는 입력 칸에서 가려지고, 한도 초과(429)는 한국어 문구로 보인다', async () => {
    vi.mocked(staffApi.login).mockRejectedValue(new ApiError(429, 'TOO_MANY_ATTEMPTS'));
    renderLogin();
    expect((screen.getByLabelText(t.staff.login.password) as HTMLInputElement).type).toBe('password');
    fireEvent.change(screen.getByLabelText(t.staff.login.email), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(t.staff.login.password), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.login.submit }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t.errors.TOO_MANY_ATTEMPTS));
  });
});

describe('설문 요약(S-07)', () => {
  it('응답 수·평균·분포·의견을 보여 주고 의견은 글자 그대로 표시한다', async () => {
    vi.mocked(staffApi.getSurvey).mockResolvedValue({ count: 3, distribution: [0, 1, 0, 2, 0], average: 3.33, comments: ['<i>어려웠어요</i>'] });
    render(
      <MemoryRouter initialEntries={['/staff/exams/e1/survey']}>
        <Routes>
          <Route path="/staff/exams/:id/survey" element={<SurveyPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(t.staff.survey.count(3))).toBeTruthy();
    expect(screen.getByText('3.33')).toBeTruthy();
    expect(screen.getByText('<i>어려웠어요</i>')).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(6);
  });

  it('시험이 끝나기 전(409 NOT_ENDED)이면 오류가 아니라 안내 문구와 다시 확인 버튼을 보여 준다', async () => {
    vi.mocked(staffApi.getSurvey).mockRejectedValueOnce(new ApiError(409, 'NOT_ENDED'));
    render(
      <MemoryRouter initialEntries={['/staff/exams/e1/survey']}>
        <Routes>
          <Route path="/staff/exams/:id/survey" element={<SurveyPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByRole('status')).textContent).toBe(t.staff.survey.notEnded);
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(staffApi.getSurvey).mockResolvedValue({ count: 1, distribution: [0, 0, 1, 0, 0], average: 3, comments: [] });
    fireEvent.click(screen.getByRole('button', { name: t.staff.survey.retry }));
    expect(await screen.findByText(t.staff.survey.count(1))).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('서버에 아직 없는 API(404)면 한국어 오류 문구가 표시된다', async () => {
    vi.mocked(staffApi.getSurvey).mockRejectedValue(new ApiError(404, 'NOT_FOUND'));
    render(
      <MemoryRouter initialEntries={['/staff/exams/e1/survey']}>
        <Routes>
          <Route path="/staff/exams/:id/survey" element={<SurveyPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.NOT_FOUND);
  });
});
