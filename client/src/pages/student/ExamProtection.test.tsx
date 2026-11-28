// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../student/studentApi', async (orig) => ({
  ...(await orig<typeof import('../../student/studentApi')>()),
  getStudentExam: vi.fn(),
  postSubmit: vi.fn(),
}));

import { t } from '../../copy/ko';
import { session } from '../../student/session';
import * as api from '../../student/studentApi';
import { ExamTaking, type ExamSocket } from './ExamTaking';

const CODE = 'ABCD2345';
type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Handler[]>();
const fakeSocket = {
  connected: true,
  on: vi.fn((ev: string, h: Handler) => {
    handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
  }),
  off: vi.fn((ev: string, h: Handler) => {
    handlers.set(ev, (handlers.get(ev) ?? []).filter((x) => x !== h));
  }),
  emit: vi.fn(),
  timeout: () => ({ emit: vi.fn() }),
};
const serverEmit = (ev: string, payload?: unknown) => act(() => (handlers.get(ev) ?? []).forEach((h) => h(payload)));
const setFullscreen = (on: boolean) => {
  Object.defineProperty(document, 'fullscreenElement', { value: on ? document.documentElement : null, configurable: true });
  act(() => void document.dispatchEvent(new Event('fullscreenchange')));
};

const QUESTIONS: api.StudentQuestion[] = [
  { id: 'q1', type: 'MCQ', prompt: '1+1은?', points: 2, choices: [{ id: 'c1', text: '둘' }, { id: 'c2', text: '셋' }] },
  { id: 'q2', type: 'ESSAY', prompt: '설명하시오', points: 5 },
];

function renderTaking(over: { state?: 'ACTIVE' | 'PAUSED'; violationCount?: number; pasteMode?: 'RECORD' | 'BLOCK' } = {}) {
  vi.mocked(api.getStudentExam).mockResolvedValue({ questions: QUESTIONS, answers: [], pasteMode: over.pasteMode ?? 'RECORD' } as api.StudentExam);
  const props = {
    examCode: CODE,
    token: 'tok',
    socket: fakeSocket as unknown as ExamSocket,
    state: over.state ?? ('ACTIVE' as 'ACTIVE' | 'PAUSED'),
    deadline: Date.now() + 600_000,
    clock: { now: () => Date.now() },
    violationCount: over.violationCount ?? 0,
    connected: true,
    onRefresh: vi.fn(),
  };
  const utils = render(<ExamTaking {...props} />);
  return { ...utils, props, rerenderWith: (p: Partial<typeof props>) => utils.rerender(<ExamTaking {...props} {...p} />) };
}

beforeEach(() => {
  localStorage.clear();
  handlers.clear();
  Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(document, 'fullscreenElement');
  cleanup();
  vi.clearAllMocks();
});

describe('전체화면 가림', () => {
  it('(a) 전체화면이 아니면 문항 영역이 없고, 버튼 클릭에서 requestFullscreen을 부른다', async () => {
    setFullscreen(false);
    const req = vi.fn(() => Promise.resolve());
    document.documentElement.requestFullscreen = req;
    renderTaking();
    await waitFor(() => expect(vi.mocked(api.getStudentExam)).toHaveBeenCalled());
    expect(screen.queryByText('1+1은?')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.fullscreenGateButton }));
    expect(req).toHaveBeenCalledTimes(1);
    setFullscreen(true);
    expect(await screen.findByText('1+1은?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.student.taking.fullscreenGateButton })).toBeNull();
  });
});

describe('일시정지', () => {
  it('(b) PAUSED면 문항 컴포넌트를 그리지 않고, ACTIVE로 돌아오면 다시 보인다', async () => {
    const { rerenderWith } = renderTaking();
    await screen.findByText('1+1은?');
    rerenderWith({ state: 'PAUSED' });
    expect(screen.getByText(t.student.taking.paused)).toBeTruthy();
    expect(screen.queryByText('1+1은?')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    rerenderWith({ state: 'ACTIVE' });
    expect(await screen.findByText('1+1은?')).toBeTruthy();
  });

  it('위반이 한도에 닿아 잠기면 자동 잠금 문구를 보인다', async () => {
    const { rerenderWith } = renderTaking();
    await screen.findByText('1+1은?');
    serverEmit('violation:counted', { count: 5, limit: 5, type: 'FULLSCREEN_EXIT' });
    rerenderWith({ state: 'PAUSED', violationCount: 5 });
    expect(screen.getByText(t.student.taking.autoLocked(5))).toBeTruthy();
  });
});

describe('위반 표시', () => {
  it('(c) violation:counted로 카운터와 알림이 바뀐다', async () => {
    renderTaking();
    await screen.findByText('1+1은?');
    expect(screen.getByText('위반 0/5')).toBeTruthy();
    serverEmit('violation:counted', { count: 3, limit: 5, type: 'FULLSCREEN_EXIT' });
    expect(screen.getByText('위반 3/5')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('위반 3/5: 전체화면 해제');
  });

  it('violation:counted 뒤 더 작은 violationCount가 와도 카운터는 줄지 않는다(max)', async () => {
    const { rerenderWith } = renderTaking();
    await screen.findByText('1+1은?');
    serverEmit('violation:counted', { count: 3, limit: 5, type: 'LEAVE' });
    rerenderWith({ violationCount: 2 });
    expect(screen.getByText('위반 3/5')).toBeTruthy();
    // 반대로 attempt:state가 더 크면 그 값을 따른다(이 단언이 counted 우선 구현을 잡는다)
    rerenderWith({ violationCount: 4 });
    expect(screen.getByText('위반 4/5')).toBeTruthy();
  });

  it('attempt:state의 violationCount 변경도 카운터에 반영된다', async () => {
    const { rerenderWith } = renderTaking();
    await screen.findByText('1+1은?');
    rerenderWith({ violationCount: 2 });
    expect(screen.getByText('위반 2/5')).toBeTruthy();
  });
});

describe('감독관 경고', () => {
  it('(d) 대화상자는 [확인]으로만 닫힌다(Esc 불가)', async () => {
    renderTaking();
    await screen.findByText('1+1은?');
    serverEmit('proctor:warning', { message: '자리를 지켜 주세요' });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('자리를 지켜 주세요');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t.student.taking.warningConfirm }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('경고가 연달아 오면 하나씩 보이고 [확인]마다 다음 건이 나타난다', async () => {
    renderTaking();
    await screen.findByText('1+1은?');
    serverEmit('proctor:warning', { message: '첫째 경고' });
    serverEmit('proctor:warning', { message: '둘째 경고' });
    const confirm = () => fireEvent.click(screen.getByRole('button', { name: t.student.taking.warningConfirm }));
    expect(screen.getByRole('dialog').textContent).toContain('첫째 경고');
    expect(screen.queryByText('둘째 경고')).toBeNull();
    confirm();
    expect(screen.getByRole('dialog').textContent).toContain('둘째 경고');
    expect(screen.queryByText('첫째 경고')).toBeNull();
    confirm();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('경고 메시지는 텍스트로만 그린다(HTML 해석 없음)', async () => {
    renderTaking();
    await screen.findByText('1+1은?');
    serverEmit('proctor:warning', { message: '<img src=x onerror=alert(1)>' });
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('붙여넣기 차단 안내', () => {
  const paste = () => {
    const area = screen.getByLabelText(t.student.taking.essayLabel);
    fireEvent.paste(area, { clipboardData: { getData: () => '복사한 내용' } });
  };

  it('(e) BLOCK 시험에서 붙여넣기를 시도하면 안내가 보인다', async () => {
    renderTaking({ pasteMode: 'BLOCK' });
    await screen.findByText('1+1은?');
    fireEvent.click(screen.getByRole('button', { name: /^2번/ }));
    await screen.findByLabelText(t.student.taking.essayLabel);
    paste();
    expect(await screen.findByText('이 시험에서는 붙여넣기를 할 수 없습니다')).toBeTruthy();
  });

  it('RECORD 시험에서는 안내가 없다', async () => {
    renderTaking({ pasteMode: 'RECORD' });
    await screen.findByText('1+1은?');
    fireEvent.click(screen.getByRole('button', { name: /^2번/ }));
    await screen.findByLabelText(t.student.taking.essayLabel);
    paste();
    expect(screen.queryByText(t.student.taking.pasteBlocked)).toBeNull();
  });
});

describe('문구와 정보 노출', () => {
  it('(f) 화면 어디에도 판정 표현이 없다', async () => {
    renderTaking();
    await screen.findByText('1+1은?');
    serverEmit('violation:counted', { count: 1, limit: 5, type: 'LEAVE' });
    serverEmit('proctor:warning', { message: '안내' });
    const text = document.body.textContent ?? '';
    for (const w of ['부정행위', 'AI 사용', '적발', '커닝']) expect(text).not.toContain(w);
    for (const w of ['부정행위', 'AI 사용', '적발', '커닝']) expect(JSON.stringify(t)).not.toContain(w);
  });

  it('(g) 시험 중 정답 정보가 DOM에 없다', async () => {
    renderTaking();
    await screen.findByText('1+1은?');
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/correct|정답|answerKey|score|점수/i);
  });
});

describe('저장소 정리', () => {
  it('session.clearAll은 신호 seq·큐도 지운다', () => {
    localStorage.setItem(`exam:${CODE}:seq`, '12');
    localStorage.setItem(`exam:${CODE}:signalQueue`, '[]');
    localStorage.setItem(`exam:${CODE}:token`, 'tok');
    localStorage.setItem('exam:OTHER000:seq', '3');
    session.clearAll(CODE);
    expect(localStorage.getItem(`exam:${CODE}:seq`)).toBeNull();
    expect(localStorage.getItem(`exam:${CODE}:signalQueue`)).toBeNull();
    expect(localStorage.getItem(`exam:${CODE}:token`)).toBeNull();
    expect(localStorage.getItem('exam:OTHER000:seq')).toBe('3');
  });
});
