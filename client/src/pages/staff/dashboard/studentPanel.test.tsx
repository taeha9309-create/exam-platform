// @vitest-environment jsdom
import type { AttemptSummary, SignalDto } from '@exam/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../staffApi', async (orig) => ({
  ...(await orig<typeof import('../staffApi')>()),
  postAction: vi.fn(),
  getTimeline: vi.fn(),
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
vi.mock('../../../socket', () => ({ connectStaffSocket: () => fakeSocket }));

import { ApiError } from '../../../api';
import { t } from '../../../copy/ko';
import * as staffApi from '../staffApi';
import { DashboardCards } from './DashboardCards';
import { describeSignal } from './timelineText';
import { useDashboard } from './useDashboard';

const EXAM_ID = '11111111-1111-4111-8111-111111111111';
const emitServer = (ev: string, payload: unknown) => act(() => handlers.get(ev)!(payload));

const summary = (i: number, over: Partial<AttemptSummary> = {}): AttemptSummary => ({
  attemptId: `att-${i}`,
  studentNo: `2024${String(i).padStart(4, '0')}`,
  name: `학생${String(i).padStart(2, '0')}`,
  state: 'ACTIVE',
  ready: true,
  consentDeclined: false,
  violationCount: 2,
  unackedSeverity: 'WARN',
  locked: false,
  connected: true,
  away: false,
  extraSeconds: 0,
  deadline: Date.now() + 600_000,
  pausedAt: null,
  lastSignal: null,
  ...over,
});

const sig = (id: string, type: SignalDto['type'], receivedAt: number, over: Partial<SignalDto> = {}): SignalDto => ({
  id,
  type,
  severity: 'WARN',
  clientAt: null,
  receivedAt,
  durationMs: null,
  questionId: null,
  meta: {},
  ...over,
});

const timeline = (a: AttemptSummary, signals: SignalDto[], over: Partial<staffApi.TimelineResponse> = {}): staffApi.TimelineResponse => ({
  attempt: a,
  signals,
  truncated: false,
  actions: [],
  ...over,
});

function Harness() {
  const dash = useDashboard(EXAM_ID);
  return <DashboardCards dash={dash} />;
}

const renderDash = (attempts: AttemptSummary[]) => {
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  emitServer('dashboard:snapshot', {
    exam: { id: EXAM_ID, title: '시험', status: 'RUNNING', endsAt: Date.now() + 600_000, lockNewEntry: false, serverNow: Date.now(), ready: 1, total: attempts.length },
    attempts,
    pendingApprovals: [],
    networkIncident: null,
  });
};

const getTimeline = vi.mocked(staffApi.getTimeline);
const openPanel = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: t.staff.panel.openLabel(name) }));
  return screen.findByRole('dialog');
};
const items = () => screen.getAllByTestId('signal-item').map((li) => li.textContent ?? '');

beforeEach(() => {
  handlers.clear();
  getTimeline.mockReset();
});
afterEach(cleanup);

describe('describeSignal', () => {
  it('shared의 모든 SignalType에 문구가 있다(타입 전수 검사)', () => {
    const src = readFileSync(resolve(process.cwd(), '../shared/src/index.ts'), 'utf-8');
    const block = /export type SignalType =([^;]+);/.exec(src)?.[1] ?? '';
    const types = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThanOrEqual(10);
    for (const type of types) {
      const text = describeSignal(sig('x', type as SignalDto['type'], 1));
      expect(text.trim(), type).not.toBe('');
      expect(text, type).not.toBe(t.staff.panel.unknownSignal);
    }
  });

  it('관찰 사실 문구', () => {
    expect(describeSignal(sig('a', 'LEAVE', 1, { durationMs: 12_000 }))).toBe('다른 탭/앱으로 이동 (12초)');
    expect(describeSignal(sig('a', 'FULLSCREEN_EXIT', 1))).toBe('전체화면 해제');
    expect(describeSignal(sig('a', 'PASTE', 1, { meta: { length: 340, blocked: true } }))).toBe('붙여넣기 340자 (차단됨)');
    expect(describeSignal(sig('a', 'DISCONNECT', 1))).toBe('연결 끊김');
  });

  it('모르는 타입은 일반 문구', () => {
    expect(describeSignal(sig('a', 'NOPE' as SignalDto['type'], 1))).toBe(t.staff.panel.unknownSignal);
  });
});

describe('학생 상세 패널', () => {
  it('열면 로딩 후 시간 오름차순 신호·조치 기록·추가 시간을 보여준다', async () => {
    const a = summary(1, { extraSeconds: 300, deadline: Date.now() + 600_000 });
    getTimeline.mockResolvedValue(
      timeline(
        a,
        [sig('s2', 'FULLSCREEN_EXIT', 2000), sig('s1', 'LEAVE', 1000, { durationMs: 12_000 })],
        { actions: [{ id: 'a1', type: 'WARN', reason: '주의 바랍니다', staffName: '김감독', payload: {}, createdAt: 3000 }] },
      ),
    );
    renderDash([a]);
    fireEvent.click(screen.getByRole('button', { name: t.staff.panel.openLabel(a.name) }));
    expect(screen.getByText(t.staff.panel.loading)).toBeTruthy();
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText(t.staff.panel.timelineTitle);
    expect(getTimeline).toHaveBeenCalledWith('att-1');
    const [first, second] = items();
    expect(first).toContain('다른 탭/앱으로 이동 (12초)');
    expect(second).toContain('전체화면 해제');
    expect(within(dlg).getByText(/추가 시간 5분/)).toBeTruthy();
    expect(within(dlg).getByText(/남은 시간/)).toBeTruthy();
    const action = screen.getByTestId('action-item').textContent!;
    expect(action).toContain('김감독');
    expect(action).toContain('주의 바랍니다');
  });

  it('truncated면 생략 안내를 보인다', async () => {
    const a = summary(1);
    getTimeline.mockResolvedValue(timeline(a, [sig('s1', 'LEAVE', 1000)], { truncated: true }));
    renderDash([a]);
    await openPanel(a.name);
    expect(await screen.findByText(t.staff.panel.truncated)).toBeTruthy();
  });

  it('signal:new는 해당 응시만 맨 아래에 추가하고 같은 id는 무시한다', async () => {
    const a = summary(1);
    const b = summary(2);
    getTimeline.mockResolvedValue(timeline(a, [sig('s1', 'LEAVE', 1000, { durationMs: 5000 })]));
    renderDash([a, b]);
    await openPanel(a.name);
    await screen.findByTestId('signal-item');
    const fresh = sig('s9', 'DISCONNECT', 500); // 시각이 더 이르더라도 도착 순서대로 맨 아래
    emitServer('signal:new', { attemptId: 'att-1', signal: fresh });
    emitServer('signal:new', { attemptId: 'att-1', signal: fresh });
    emitServer('signal:new', { attemptId: 'att-2', signal: sig('s7', 'DROP', 3000) });
    const list = items();
    expect(list).toHaveLength(2);
    expect(list[1]).toContain('연결 끊김');
    expect(list.join()).not.toContain('끌어놓기');
    // 조회 결과에 이미 있는 신호가 다시 와도 중복되지 않는다
    emitServer('signal:new', { attemptId: 'att-1', signal: sig('s1', 'LEAVE', 1000, { durationMs: 5000 }) });
    expect(items()).toHaveLength(2);
  });

  it('조회 응답보다 먼저 온 signal:new도 반영한다', async () => {
    const a = summary(1);
    let resolve!: (v: staffApi.TimelineResponse) => void;
    getTimeline.mockReturnValue(new Promise((r) => (resolve = r)));
    renderDash([a]);
    fireEvent.click(screen.getByRole('button', { name: t.staff.panel.openLabel(a.name) }));
    emitServer('signal:new', { attemptId: 'att-1', signal: sig('s2', 'RECONNECT', 2000) });
    await act(async () => resolve(timeline(a, [sig('s1', 'DISCONNECT', 1000)])));
    const list = items();
    expect(list[0]).toContain('연결 끊김');
    expect(list[1]).toContain('다시 연결됨');
  });

  it('조회 실패 시 오류와 다시 시도를 보이고, 다시 시도하면 불러온다', async () => {
    const a = summary(1);
    getTimeline.mockRejectedValueOnce(new ApiError(500, 'INTERNAL'));
    getTimeline.mockResolvedValue(timeline(a, [sig('s1', 'FULLSCREEN_EXIT', 1000)]));
    renderDash([a]);
    await openPanel(a.name);
    expect((await screen.findByRole('alert')).textContent).toContain(t.staff.panel.loadFailed);
    fireEvent.click(screen.getByRole('button', { name: t.staff.panel.retry }));
    await waitFor(() => expect(items()[0]).toContain('전체화면 해제'));
  });

  it('서버 문자열(사유·이름)은 HTML이 아닌 텍스트로 그린다', async () => {
    const a = summary(1);
    getTimeline.mockResolvedValue(
      timeline(a, [sig('s1', 'PASTE', 1000, { meta: { length: 3, blocked: false, note: '<img src=x onerror=alert(1)>' } })], {
        actions: [{ id: 'a1', type: 'PAUSE', reason: '<img src=x data-evil=1>', staffName: '<b>evil</b>', payload: {}, createdAt: 2000 }],
      }),
    );
    renderDash([a]);
    const dlg = await openPanel(a.name);
    await within(dlg).findByTestId('action-item');
    expect(dlg.querySelector('img')).toBeNull();
    expect(dlg.querySelector('b')).toBeNull();
    expect(screen.getByTestId('action-item').textContent).toContain('<img src=x data-evil=1>');
  });

  it('화면에 판정 표현이 없다', async () => {
    const a = summary(1);
    getTimeline.mockResolvedValue(timeline(a, [sig('s1', 'PASTE', 1, { meta: { length: 340, blocked: true } }), sig('s2', 'MULTI_MONITOR', 2), sig('s3', 'SEQ_GAP', 3)]));
    renderDash([a]);
    const dlg = await openPanel(a.name);
    await within(dlg).findAllByTestId('signal-item');
    for (const w of ['부정행위', 'AI 사용', '적발', '커닝']) expect(document.body.textContent).not.toContain(w);
  });

  it('[확인]은 패널을 열지 않고, [상세] 버튼과 카드 클릭은 연다. 닫기도 동작한다', async () => {
    const a = summary(1);
    getTimeline.mockResolvedValue(timeline(a, []));
    vi.mocked(staffApi.postAction).mockResolvedValue({ attempt: { id: 'att-1', state: 'ACTIVE' } });
    renderDash([a]);
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.ack }));
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getTimeline).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('student-card'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: t.staff.panel.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
