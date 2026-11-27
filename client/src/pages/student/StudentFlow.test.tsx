// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../student/studentApi', async (orig) => ({
  ...(await orig<typeof import('../../student/studentApi')>()),
  getPublicExam: vi.fn(),
  postEntry: vi.fn(),
  postConfirm: vi.fn(),
  getAttempt: vi.fn(),
  postConsent: vi.fn(),
  postEnv: vi.fn(),
  getStudentExam: vi.fn(),
  postSubmit: vi.fn(),
  postSurvey: vi.fn(),
}));

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
type Ack = (err: Error | null, res?: { ok: boolean; savedAt?: string; code?: string }) => void;
const saves: { payload: Record<string, unknown>; ack: Ack }[] = [];
const fakeSocket = {
  connected: true,
  on: vi.fn((ev: string, h: Handler) => {
    handlers.set(ev, h);
    return fakeSocket;
  }),
  off: vi.fn((ev: string) => {
    handlers.delete(ev);
    return fakeSocket;
  }),
  connect: vi.fn(),
  disconnect: vi.fn(),
  timeout: () => ({
    emit: (_ev: string, payload: Record<string, unknown>, ack: Ack) => {
      saves.push({ payload, ack });
    },
  }),
};
vi.mock('../../socket', () => ({ connectStudentSocket: () => fakeSocket }));

import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { drafts, session } from '../../student/session';
import * as api from '../../student/studentApi';
import { StudentFlow } from './StudentFlow';

const CODE = 'ABCD2345';
const serverEmit = (ev: string, payload?: unknown) => act(() => handlers.get(ev)!(payload));
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

function view(over: Partial<api.AttemptView> = {}): api.AttemptView {
  return { state: 'WAITING', deadline: null, serverNow: Date.now(), extraSeconds: 0, violationCount: 0, needs: { consent: false, env: false }, ...over };
}
const QUESTIONS: api.StudentQuestion[] = [
  { id: 'q1', type: 'MCQ', prompt: '1+1은?', points: 2, choices: [{ id: 'c1', text: '둘' }, { id: 'c2', text: '셋' }] },
  { id: 'q2', type: 'ESSAY', prompt: '설명하시오', points: 5 },
  { id: 'q3', type: 'ESSAY', prompt: '의견을 쓰시오', points: 5 },
];
const mockExam = (answers: api.StudentAnswer[] = []) => vi.mocked(api.getStudentExam).mockResolvedValue({ questions: QUESTIONS, answers });
const activeView = () => view({ state: 'ACTIVE', deadline: Date.now() + 600_000 });

function renderFlow() {
  return render(
    <MemoryRouter initialEntries={[`/e/${CODE}`]}>
      <Routes>
        <Route path="/e/:examCode" element={<StudentFlow />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  handlers.clear();
  saves.length = 0;
  fakeSocket.connected = true;
  vi.mocked(api.getPublicExam).mockResolvedValue({ title: '기말 시험', status: 'OPEN' });
  Object.defineProperty(navigator, 'userAgentData', { value: { brands: [{ brand: 'Google Chrome' }] }, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'userAgentData');
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('입장·본인 확인', () => {
  it('학번·비밀번호 → 본인 확인 → 세션 저장 → 동의 화면', async () => {
    vi.mocked(api.postEntry).mockResolvedValue({ name: '홍길동' });
    vi.mocked(api.postConfirm).mockResolvedValue({ sessionToken: 'tok-1', attempt: { id: 'a1', ...view({ needs: { consent: true, env: true } }) } });
    vi.mocked(api.getAttempt).mockResolvedValue(view({ needs: { consent: true, env: true } }));
    renderFlow();
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '20269001' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    expect(await screen.findByText(t.student.confirm.question('20269001', '홍길동'))).toBeTruthy();
    expect(vi.mocked(api.postEntry)).toHaveBeenCalledWith({ examCode: CODE, studentNo: '20269001', passcode: '123456' });
    fireEvent.click(screen.getByRole('button', { name: t.student.confirm.yes }));
    expect(await screen.findByRole('heading', { name: t.student.consent.title })).toBeTruthy();
    expect(session.get(CODE)).toBe('tok-1');
    expect(document.body.textContent).not.toContain('tok-1');
  });

  it('입장 실패(ENTRY_FAILED)는 사유 구분 없는 같은 문구', async () => {
    vi.mocked(api.postEntry).mockRejectedValue(new ApiError(401, 'ENTRY_FAILED'));
    renderFlow();
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.ENTRY_FAILED);
    expect((screen.getByLabelText(t.student.entry.passcode) as HTMLInputElement).value).toBe('');
  });

  it.each([
    ['EXAM_NOT_ENTERABLE', 403, t.errors.EXAM_NOT_ENTERABLE],
    ['TOO_MANY_ATTEMPTS', 429, t.student.entry.tooMany],
  ])('입장 오류 %s 문구', async (code, status, text) => {
    vi.mocked(api.postEntry).mockRejectedValue(new ApiError(status, code));
    renderFlow();
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
  });

  it('입장 마감(ENTRY_CLOSED)은 안내 화면', async () => {
    vi.mocked(api.postEntry).mockResolvedValue({ name: '홍길동' });
    vi.mocked(api.postConfirm).mockRejectedValue(new ApiError(403, 'ENTRY_CLOSED'));
    renderFlow();
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    fireEvent.click(await screen.findByRole('button', { name: t.student.confirm.yes }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.student.notice.entryClosed);
  });

  it('[아닙니다]는 입력 화면으로 돌아간다', async () => {
    vi.mocked(api.postEntry).mockResolvedValue({ name: '홍길동' });
    renderFlow();
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    fireEvent.click(await screen.findByRole('button', { name: t.student.confirm.no }));
    expect(await screen.findByLabelText(t.student.entry.studentNo)).toBeTruthy();
    expect(vi.mocked(api.postConfirm)).not.toHaveBeenCalled();
  });
});

describe('중복 접속 승인 대기 폴링', () => {
  async function enterDuplicate() {
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '20269001' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    fireEvent.click(await screen.findByRole('button', { name: t.student.confirm.yes }));
    await screen.findByText(t.student.pending.body);
  }

  it('pendingToken을 보관해 2초마다 같은 입력으로 /confirm을 다시 호출하고, 승인되면 세션을 저장한다', async () => {
    vi.mocked(api.postEntry).mockResolvedValue({ name: '홍길동' });
    vi.mocked(api.postConfirm)
      .mockResolvedValueOnce({ status: 'DUPLICATE_PENDING', pendingToken: 'pend-1' })
      .mockResolvedValueOnce({ status: 'DUPLICATE_PENDING' })
      .mockResolvedValueOnce({ sessionToken: 'tok-new', attempt: { id: 'a1', ...view() } });
    vi.mocked(api.getAttempt).mockResolvedValue(view());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderFlow();
    await enterDuplicate();
    const calls = () => vi.mocked(api.postConfirm).mock.calls;
    expect(calls()).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(calls()).toHaveLength(1); // 2초가 되기 전에는 부르지 않는다
    await act(async () => void (await vi.advanceTimersByTimeAsync(1100)));
    expect(calls()).toHaveLength(2);
    expect(calls()[1]![0]).toEqual({ examCode: CODE, studentNo: '20269001', passcode: '123456', sessionToken: 'pend-1' });
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(calls()).toHaveLength(3);
    expect(calls()[2]![0]).toMatchObject({ sessionToken: 'pend-1' });
    expect(session.get(CODE)).toBe('tok-new');
    // 승인된 뒤에는 더 호출하지 않는다
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(calls()).toHaveLength(3);
  });

  it('ENTRY_REJECTED를 받으면 폴링을 멈추고 안내 화면을 보인다', async () => {
    vi.mocked(api.postEntry).mockResolvedValue({ name: '홍길동' });
    vi.mocked(api.postConfirm)
      .mockResolvedValueOnce({ status: 'DUPLICATE_PENDING', pendingToken: 'pend-1' })
      .mockRejectedValue(new ApiError(403, 'ENTRY_REJECTED'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderFlow();
    await enterDuplicate();
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    expect(screen.getByRole('alert').textContent).toBe(t.student.notice.rejected);
    const n = vi.mocked(api.postConfirm).mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(vi.mocked(api.postConfirm).mock.calls).toHaveLength(n);
    expect(session.get(CODE)).toBeNull();
  });

  it('APPROVAL_ALREADY_PENDING은 안내 문구를 보이고 폴링하지 않는다', async () => {
    vi.mocked(api.postEntry).mockResolvedValue({ name: '홍길동' });
    vi.mocked(api.postConfirm).mockRejectedValue(new ApiError(409, 'APPROVAL_ALREADY_PENDING'));
    renderFlow();
    fireEvent.change(await screen.findByLabelText(t.student.entry.studentNo), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(t.student.entry.passcode), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.entry.submit }));
    fireEvent.click(await screen.findByRole('button', { name: t.student.confirm.yes }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.APPROVAL_ALREADY_PENDING);
    expect(vi.mocked(api.postConfirm)).toHaveBeenCalledTimes(1);
  });
});

describe('상태에 따른 화면 전환', () => {
  beforeEach(() => session.set(CODE, 'tok'));

  it('needs.consent → 동의, needs.env → 환경 점검, 그 뒤 대기실', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ needs: { consent: true, env: true } }));
    vi.mocked(api.postConsent).mockResolvedValue(view({ needs: { consent: false, env: true } }));
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: t.student.consent.agree }));
    expect(await screen.findByRole('heading', { name: t.student.env.title })).toBeTruthy();
    expect(vi.mocked(api.postConsent)).toHaveBeenCalledWith('tok', true);
  });

  it('동의하지 않음 → 안내와 [다시 보기]', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ needs: { consent: true, env: true } }));
    vi.mocked(api.postConsent).mockResolvedValue(view({ needs: { consent: true, env: true } }));
    renderFlow();
    fireEvent.click(await screen.findByRole('button', { name: t.student.consent.decline }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.student.consent.declinedBody);
    fireEvent.click(screen.getByRole('button', { name: t.student.consent.review }));
    expect(await screen.findByRole('button', { name: t.student.consent.agree })).toBeTruthy();
  });

  it('대기실에 waiting:count를 "현재 N/M명 입장"으로 보인다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view());
    renderFlow();
    await screen.findByRole('heading', { name: t.student.waiting.title });
    serverEmit('waiting:count', { ready: 3, total: 20 });
    expect(screen.getByText(t.student.waiting.body(3, 20))).toBeTruthy();
  });

  it('PENDING_APPROVAL은 승인 대기 화면', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'PENDING_APPROVAL' }));
    renderFlow();
    expect(await screen.findByText(t.student.pending.body)).toBeTruthy();
  });

  it('attempt:state ACTIVE를 받으면 ExamTaking을 그린다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view());
    mockExam();
    renderFlow();
    await screen.findByRole('heading', { name: t.student.waiting.title });
    serverEmit('attempt:state', activeView());
    expect(await screen.findByText(t.student.taking.recording)).toBeTruthy();
    expect(await screen.findByText('1+1은?')).toBeTruthy();
  });

  it('PAUSED는 문항을 가리고 일시정지 안내를 보인다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'PAUSED', deadline: Date.now() + 600_000 }));
    mockExam();
    renderFlow();
    expect((await screen.findByRole('alert')).textContent).toBe(t.student.taking.paused);
    expect(screen.queryByText('1+1은?')).toBeNull();
  });

  it('REJECTED는 안내 화면', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'REJECTED' }));
    renderFlow();
    expect((await screen.findByRole('alert')).textContent).toBe(t.student.notice.rejected);
  });

  it('SUBMITTED는 제출 완료 + 설문, [건너뛰기]는 빈 본문으로 보낸다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'SUBMITTED' }));
    vi.mocked(api.postSurvey).mockResolvedValue({});
    renderFlow();
    expect(await screen.findByRole('heading', { name: t.student.submitted.title })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.student.submitted.skip }));
    expect(await screen.findByText(t.student.submitted.skipped)).toBeTruthy();
    expect(vi.mocked(api.postSurvey)).toHaveBeenCalledWith('tok', {});
    expect(session.get(CODE)).toBeNull();
  });

  it('설문 제출은 난이도·의견을 보내고, 이미 낸 설문(409)은 완료로 본다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'TERMINATED' }));
    vi.mocked(api.postSurvey).mockRejectedValue(new ApiError(409, 'ALREADY_SUBMITTED'));
    renderFlow();
    await screen.findByRole('heading', { name: t.student.submitted.title });
    fireEvent.click(screen.getByLabelText(t.student.submitted.difficultyLevels[3]!));
    fireEvent.change(screen.getByLabelText(t.student.submitted.comment), { target: { value: ' 어려웠어요 ' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.submitted.send }));
    expect(await screen.findByText(t.student.submitted.done)).toBeTruthy();
    expect(vi.mocked(api.postSurvey)).toHaveBeenCalledWith('tok', { difficulty: 4, comment: '어려웠어요' });
  });

  it('토큰이 거부되면(401) 입장 화면으로 돌아가고 토큰을 지운다', async () => {
    vi.mocked(api.getAttempt).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED'));
    renderFlow();
    expect(await screen.findByLabelText(t.student.entry.studentNo)).toBeTruthy();
    expect(session.get(CODE)).toBeNull();
  });
});

describe('소켓 이벤트', () => {
  beforeEach(() => session.set(CODE, 'tok'));

  it('session:revoked → 서버에서 토큰이 무효임을 확인하면 Notice + 토큰·초안 삭제', async () => {
    vi.mocked(api.getAttempt).mockResolvedValueOnce(activeView());
    mockExam();
    drafts.save(CODE, 'q2', { rev: 3, text: '미저장' });
    renderFlow();
    await screen.findByText('1+1은?');
    vi.mocked(api.getAttempt).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED'));
    serverEmit('session:revoked', {});
    expect((await screen.findByRole('alert')).textContent).toBe(t.student.notice.revoked);
    expect(session.get(CODE)).toBeNull();
    expect(drafts.load(CODE, 'q2')).toBeNull();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });

  it('session:revoked 뒤 GET /attempt가 성공하면(낡은 알림) 화면을 유지한다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view());
    renderFlow();
    await screen.findByRole('heading', { name: t.student.waiting.title });
    serverEmit('session:revoked', {});
    await waitFor(() => expect(fakeSocket.connect).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: t.student.waiting.title })).toBeTruthy();
    expect(session.get(CODE)).toBe('tok');
  });

  it('소켓이 (재)연결되면 GET /attempt로 상태를 한 번 더 확인한다', async () => {
    vi.mocked(api.getAttempt).mockResolvedValue(view());
    renderFlow();
    await screen.findByRole('heading', { name: t.student.waiting.title });
    const before = vi.mocked(api.getAttempt).mock.calls.length;
    serverEmit('connect');
    await waitFor(() => expect(vi.mocked(api.getAttempt).mock.calls.length).toBe(before + 1));
  });

  it('순서가 뒤바뀐 옛 attempt:state(serverNow가 더 작음)는 무시한다', async () => {
    const now = Date.now();
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'WAITING', serverNow: now }));
    mockExam();
    renderFlow();
    await screen.findByRole('heading', { name: t.student.waiting.title });
    serverEmit('attempt:state', activeView()); // 새 상태
    await screen.findByText('1+1은?');
    serverEmit('attempt:state', view({ state: 'WAITING', serverNow: now - 5000 })); // 늦게 도착한 옛 상태
    expect(screen.getByText('1+1은?')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: t.student.waiting.title })).toBeNull();
  });
});

describe('환경 점검', () => {
  beforeEach(() => {
    session.set(CODE, 'tok');
    vi.mocked(api.getAttempt).mockResolvedValue(view({ needs: { consent: false, env: true } }));
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'userAgentData');
    Reflect.deleteProperty(screen_, 'isExtended');
    Reflect.deleteProperty(document, 'fullscreenElement');
  });
  const screen_ = window.screen as unknown as Record<string, unknown>;
  const setBrand = (brand: string | null) =>
    Object.defineProperty(navigator, 'userAgentData', { value: brand ? { brands: [{ brand }] } : undefined, configurable: true });

  it('Firefox(userAgentData 없음)는 진행 불가 안내', async () => {
    setBrand(null);
    renderFlow();
    expect((await screen.findByRole('alert')).textContent).toBe(t.student.notice.unsupportedBrowser);
  });

  it('전체화면에 들어가기 전에는 [다음]이 비활성이고, 버튼 클릭으로 requestFullscreen을 부른다', async () => {
    setBrand('Google Chrome');
    const req = vi.fn(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true });
      return Promise.resolve();
    });
    document.documentElement.requestFullscreen = req;
    vi.mocked(api.postEnv).mockResolvedValue(view());
    renderFlow();
    const next = (await screen.findByRole('button', { name: t.student.env.next })) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t.student.env.fullscreenButton }));
    await waitFor(() => expect(next.disabled).toBe(false));
    expect(req).toHaveBeenCalledTimes(1);
    fireEvent.click(next);
    await waitFor(() => expect(vi.mocked(api.postEnv)).toHaveBeenCalledWith('tok', { browser: 'chrome', isExtended: false }));
  });

  it('다중 모니터는 경고만 하고 진행은 막지 않는다(isExtended=true를 서버에 보낸다)', async () => {
    setBrand('Microsoft Edge');
    screen_.isExtended = true;
    Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true });
    vi.mocked(api.postEnv).mockResolvedValue(view());
    renderFlow();
    expect((await screen.findByText(t.student.env.extendedWarn)).textContent).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.student.env.next }));
    await waitFor(() => expect(vi.mocked(api.postEnv)).toHaveBeenCalledWith('tok', { browser: 'edge', isExtended: true }));
  });
});

describe('응시 화면', () => {
  beforeEach(() => {
    session.set(CODE, 'tok');
    vi.mocked(api.getAttempt).mockResolvedValue(activeView());
  });

  const essay = () => screen.findByLabelText(t.student.taking.essayLabel);
  const goto = (n: number) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${n}번`) }));

  it('문항 목록(답안 여부)·자유 이동·서버 시계 기준 남은 시간', async () => {
    const serverNow = Date.now() - 5 * 60_000; // 학생 PC 시계가 서버보다 5분 빠름
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'ACTIVE', serverNow, deadline: serverNow + 90_000 }));
    mockExam([{ questionId: 'q1', choiceId: 'c1', rev: 1, savedAt: new Date().toISOString() }]);
    renderFlow();
    await screen.findByText('1+1은?');
    expect(screen.getByRole('timer').textContent).toMatch(/01:(30|29)/);
    expect(within(screen.getByRole('button', { name: /^1번/ })).getByText(t.student.taking.answered)).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /^2번/ })).getByText(t.student.taking.unanswered)).toBeTruthy();
    expect((screen.getByLabelText('둘') as HTMLInputElement).checked).toBe(true);
    goto(2);
    expect(await screen.findByText('설명하시오')).toBeTruthy();
    expect(screen.getByText(t.student.taking.violationCounter(0, 5))).toBeTruthy();
  });

  it('정답 표시나 점수 정보가 없다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    expect(document.body.innerHTML).not.toMatch(/correct|정답/);
  });

  it('서술형 입력 1초 뒤 rev 1로 전송하고, ack로 "저장됨 HH:mm:ss"를 보인다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    const ta = await essay();
    vi.useFakeTimers();
    fireEvent.change(ta, { target: { value: '답안' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(saves).toHaveLength(1);
    expect(saves[0]!.payload).toEqual({ questionId: 'q2', text: '답안', rev: 1 });
    act(() => saves[0]!.ack(null, { ok: true, savedAt: '2026-11-27T05:03:21.000Z' }));
    expect(screen.getByText(/^저장됨 \d\d:\d\d:\d\d$/)).toBeTruthy();
    expect(drafts.load(CODE, 'q2')).toBeNull();
  });

  it('객관식 선택도 저장하고, 내용이 바뀌면 rev가 오른다', async () => {
    mockExam([{ questionId: 'q1', choiceId: 'c1', rev: 4, savedAt: new Date().toISOString() }]);
    renderFlow();
    await screen.findByText('1+1은?');
    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText('셋'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(saves[0]!.payload).toEqual({ questionId: 'q1', choiceId: 'c2', rev: 5 });
    act(() => saves[0]!.ack(null, { ok: true, savedAt: new Date().toISOString() }));
    fireEvent.click(screen.getByLabelText('둘'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(saves[1]!.payload.rev).toBe(6);
  });

  it('5000자 입력 제한을 표시한다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    fireEvent.change(await essay(), { target: { value: '가'.repeat(10) } });
    expect(screen.getByText(t.student.taking.charCount(10, 5000))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t.student.taking.essayLabel), { target: { value: '가'.repeat(5001) } });
    expect(screen.getByText(t.student.taking.tooLong(5000))).toBeTruthy();
  });

  it('새로고침 뒤 서버보다 새로운 초안은 복구해 같은 rev로 다시 보낸다', async () => {
    mockExam([{ questionId: 'q2', text: '서버 값', rev: 2, savedAt: new Date().toISOString() }]);
    drafts.save(CODE, 'q2', { rev: 3, text: '서버 값에 더 쓴 내용' });
    drafts.save(CODE, 'q3', { rev: 1, text: '낡은 초안' });
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    expect(((await essay()) as HTMLTextAreaElement).value).toBe('서버 값에 더 쓴 내용');
    expect(drafts.load(CODE, 'q3')).not.toBeNull(); // 서버 답안이 없는 문항의 초안은 유지된다
    await waitFor(() => expect(saves).toHaveLength(2), { timeout: 3000 }); // 복구 1초 뒤 재전송
    const sent = saves.map((s) => s.payload);
    expect(sent).toContainEqual({ questionId: 'q2', text: '서버 값에 더 쓴 내용', rev: 3 });
    expect(sent).toContainEqual({ questionId: 'q3', text: '낡은 초안', rev: 1 });
  });

  it('서버 rev 이하인 낡은 초안은 버린다', async () => {
    mockExam([{ questionId: 'q2', text: '서버 값', rev: 5, savedAt: new Date().toISOString() }]);
    drafts.save(CODE, 'q2', { rev: 4, text: '낡은 초안' });
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    expect(((await essay()) as HTMLTextAreaElement).value).toBe('서버 값');
    expect(drafts.load(CODE, 'q2')).toBeNull();
  });

  it('STALE_REV 응답이면 GET /exam으로 서버 값을 다시 받아 반영한다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    const ta = await essay();
    vi.useFakeTimers();
    fireEvent.change(ta, { target: { value: '내 답' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(vi.mocked(api.getStudentExam)).toHaveBeenCalledTimes(1);
    vi.mocked(api.getStudentExam).mockResolvedValue({ questions: QUESTIONS, answers: [{ questionId: 'q2', text: '서버의 더 새 값', rev: 9, savedAt: new Date().toISOString() }] });
    act(() => saves[0]!.ack(null, { ok: false, code: 'STALE_REV' }));
    await flush();
    expect(vi.mocked(api.getStudentExam)).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText(t.student.taking.essayLabel) as HTMLTextAreaElement).value).toBe('서버의 더 새 값');
    expect(drafts.load(CODE, 'q2')).toBeNull();
    fireEvent.change(screen.getByLabelText(t.student.taking.essayLabel), { target: { value: '다시 씀' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(saves[1]!.payload.rev).toBe(10);
  });

  it('NOT_ACTIVE 응답이면 저장을 멈추고 GET /attempt로 상태를 확인한다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    const ta = await essay();
    vi.useFakeTimers();
    fireEvent.change(ta, { target: { value: 'a' } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    const before = vi.mocked(api.getAttempt).mock.calls.length;
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'PAUSED', deadline: Date.now() + 60_000 }));
    act(() => saves[0]!.ack(null, { ok: false, code: 'NOT_ACTIVE' }));
    await flush();
    expect(vi.mocked(api.getAttempt).mock.calls.length).toBe(before + 1);
    expect(screen.getByRole('alert').textContent).toBe(t.student.taking.paused);
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(saves).toHaveLength(1);
  });

  it('제출은 미응답 수 확인 대화상자 뒤에만 되고, 취소하면 제출하지 않는다', async () => {
    mockExam([{ questionId: 'q1', choiceId: 'c1', rev: 1, savedAt: new Date().toISOString() }]);
    renderFlow();
    await screen.findByText('1+1은?');
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.submit }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t.student.taking.confirmBody(2))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t.student.taking.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.mocked(api.postSubmit)).not.toHaveBeenCalled();
  });

  it('Esc로 대화상자를 닫는다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.submit }));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('확인하면 미저장 답안을 먼저 저장한 뒤 한 번만 제출하고, 초안을 정리하고 설문 화면으로 간다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    fireEvent.change(await essay(), { target: { value: '마지막 문장' } });
    vi.mocked(api.postSubmit).mockResolvedValue({ state: 'SUBMITTED', submittedAt: new Date().toISOString() });
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.submit }));
    const confirmBtn = within(await screen.findByRole('dialog')).getByRole('button', { name: t.student.taking.confirmSubmit });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn); // 중복 클릭
    await waitFor(() => expect(saves).toHaveLength(1)); // 제출 전에 저장 먼저
    expect(vi.mocked(api.postSubmit)).not.toHaveBeenCalled();
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'SUBMITTED' }));
    act(() => saves[0]!.ack(null, { ok: true, savedAt: new Date().toISOString() }));
    expect(await screen.findByRole('heading', { name: t.student.submitted.title })).toBeTruthy();
    expect(vi.mocked(api.postSubmit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.postSubmit)).toHaveBeenCalledWith('tok');
    expect(drafts.load(CODE, 'q2')).toBeNull();
  });

  it('저장하지 못한 답안이 있으면 제출하지 않고 안내한다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    goto(2);
    fireEvent.change(await essay(), { target: { value: '쓰는 중' } });
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.submit }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t.student.taking.confirmSubmit }));
    await waitFor(() => expect(saves).toHaveLength(1));
    vi.useFakeTimers();
    act(() => saves[0]!.ack(null, { ok: false, code: 'INVALID' }));
    await flush();
    expect(screen.getByText(t.student.taking.unsavedBlock)).toBeTruthy();
    expect(vi.mocked(api.postSubmit)).not.toHaveBeenCalled();
  });

  it('제출이 BUSY면 다시 시도한다', async () => {
    mockExam([{ questionId: 'q1', choiceId: 'c1', rev: 1, savedAt: new Date().toISOString() }]);
    renderFlow();
    await screen.findByText('1+1은?');
    vi.mocked(api.postSubmit).mockRejectedValueOnce(new ApiError(409, 'BUSY')).mockResolvedValue({ state: 'SUBMITTED', submittedAt: null });
    vi.mocked(api.getAttempt).mockResolvedValue(view({ state: 'SUBMITTED' }));
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.submit }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t.student.taking.confirmSubmit }));
    expect(await screen.findByRole('heading', { name: t.student.submitted.title }, { timeout: 4000 })).toBeTruthy();
    expect(vi.mocked(api.postSubmit)).toHaveBeenCalledTimes(2);
  });

  it('소켓이 끊기면 안내를 보이고 입력은 계속 받는다', async () => {
    mockExam();
    renderFlow();
    await screen.findByText('1+1은?');
    fakeSocket.connected = false;
    serverEmit('disconnect');
    expect(screen.getByText(t.student.taking.socketDown)).toBeTruthy();
    goto(2);
    fireEvent.change(await essay(), { target: { value: '오프라인 입력' } });
    expect(drafts.load(CODE, 'q2')).toEqual({ rev: 1, text: '오프라인 입력' });
  });
});
