// @vitest-environment jsdom
import type { AttemptSummary } from '@exam/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../staffApi', async (orig) => ({
  ...(await orig<typeof import('../staffApi')>()),
  postAction: vi.fn(),
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
import { DashboardCards, NetworkIncidentBanner } from './DashboardCards';
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
  violationCount: 0,
  unackedSeverity: 'NONE',
  locked: false,
  connected: true,
  away: false,
  extraSeconds: 0,
  deadline: Date.now() + 600_000,
  pausedAt: null,
  lastSignal: null,
  ...over,
});

const snapshotOf = (attempts: AttemptSummary[], over: Record<string, unknown> = {}) => ({
  exam: { id: EXAM_ID, title: '시험', status: 'RUNNING', endsAt: Date.now() + 600_000, lockNewEntry: false, serverNow: Date.now(), ready: 7, total: attempts.length },
  attempts,
  pendingApprovals: [],
  networkIncident: null,
  ...over,
});

function Harness() {
  const dash = useDashboard(EXAM_ID);
  return (
    <>
      <NetworkIncidentBanner incident={dash.networkIncident} />
      <DashboardCards dash={dash} />
    </>
  );
}

const renderDash = (attempts: AttemptSummary[], over: Record<string, unknown> = {}) => {
  const utils = render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  emitServer('dashboard:snapshot', snapshotOf(attempts, over));
  return utils;
};

const cardOf = (name: string) => screen.getAllByTestId('student-card').find((c) => c.textContent?.includes(name))!;
const order = () => screen.getAllByTestId('student-card').map((c) => c.getAttribute('data-student-no'));

beforeEach(() => {
  handlers.clear();
  fakeSocket.connected = false;
  vi.mocked(staffApi.postAction).mockResolvedValue({ attempt: { id: 'x', state: 'ACTIVE' } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('감독 대시보드', () => {
  it('(a) 스냅샷의 20명이 이름·학번·상태와 함께 카드로 보이고 미입장도 표시된다', () => {
    const list = Array.from({ length: 20 }, (_, i) => summary(i + 1));
    list[4] = summary(5, { attemptId: null, state: null, connected: false });
    renderDash(list);
    expect(screen.getAllByTestId('student-card')).toHaveLength(20);
    const c = cardOf('학생01');
    expect(within(c).getByText('20240001')).toBeTruthy();
    expect(within(c).getByText(t.staff.dash.state.ACTIVE)).toBeTruthy();
    const notEntered = cardOf('학생05');
    expect(within(notEntered).getByText(t.staff.dash.state.NOT_ENTERED)).toBeTruthy();
    expect(within(c).getByText(t.staff.dash.violations(0, 5))).toBeTruthy();
  });

  it('(b) 기본은 학번순, 확인 필요순에서는 새 WARN이 생긴 카드가 attempt:updated 직후 맨 위로 온다', () => {
    const list = Array.from({ length: 5 }, (_, i) => summary(i + 1));
    renderDash(list);
    expect(order()).toEqual(list.map((s) => s.studentNo));
    fireEvent.change(screen.getByLabelText(t.staff.dash.sort), { target: { value: 'NEEDS_ATTENTION' } });
    emitServer('attempt:updated', summary(4, { unackedSeverity: 'WARN', violationCount: 1, lastSignal: { type: 'FULLSCREEN_EXIT', severity: 'WARN', receivedAt: 2000 } }));
    expect(order()[0]).toBe(list[3]!.studentNo);
    // 더 높은 ALERT가 생기면 그 카드가 위로, WARN은 그 아래
    emitServer('attempt:updated', summary(2, { unackedSeverity: 'ALERT', lastSignal: { type: 'LEAVE', severity: 'ALERT', receivedAt: 1000 } }));
    expect(order().slice(0, 2)).toEqual([list[1]!.studentNo, list[3]!.studentNo]);
    // 같은 심각도는 최근 신호가 먼저
    emitServer('attempt:updated', summary(5, { unackedSeverity: 'WARN', lastSignal: { type: 'PASTE', severity: 'WARN', receivedAt: 3000 } }));
    expect(order().slice(0, 3)).toEqual([list[1]!.studentNo, list[4]!.studentNo, list[3]!.studentNo]);
  });

  it('(c) 이름·학번 검색이 카드를 거른다', () => {
    renderDash(Array.from({ length: 5 }, (_, i) => summary(i + 1)));
    const box = screen.getByLabelText(t.staff.dash.search);
    fireEvent.change(box, { target: { value: '학생03' } });
    expect(order()).toEqual(['20240003']);
    fireEvent.change(box, { target: { value: '20240004' } });
    expect(order()).toEqual(['20240004']);
    fireEvent.change(box, { target: { value: '없는사람' } });
    expect(screen.queryAllByTestId('student-card')).toHaveLength(0);
    expect(screen.getByText(t.staff.dash.noMatch)).toBeTruthy();
  });

  it('(d) 색 규칙: INFO·NONE 초록, WARN 노랑, ALERT 빨강, PAUSED 회색 테두리, 종료 흐리게, 잠김은 빨강+잠금 표시', () => {
    renderDash([
      summary(1, { unackedSeverity: 'NONE' }),
      summary(2, { unackedSeverity: 'INFO' }),
      summary(3, { unackedSeverity: 'WARN' }),
      summary(4, { unackedSeverity: 'ALERT' }),
      summary(5, { state: 'PAUSED', unackedSeverity: 'WARN', pausedAt: Date.now() }),
      summary(6, { state: 'PAUSED', locked: true, unackedSeverity: 'WARN', violationCount: 5, pausedAt: Date.now() }),
      summary(7, { state: 'SUBMITTED' }),
      summary(8, { state: 'TERMINATED' }),
    ]);
    expect(cardOf('학생01').getAttribute('data-tone')).toBe('green');
    expect(cardOf('학생02').getAttribute('data-tone')).toBe('green');
    expect(cardOf('학생03').getAttribute('data-tone')).toBe('yellow');
    expect(cardOf('학생04').getAttribute('data-tone')).toBe('red');
    const paused = cardOf('학생05');
    expect(paused.getAttribute('data-paused')).toBe('true');
    expect(paused.getAttribute('data-locked')).toBe('false');
    expect(within(paused).queryByText(t.staff.dash.lockMark)).toBeNull();
    const locked = cardOf('학생06');
    expect(locked.getAttribute('data-tone')).toBe('red');
    expect(locked.getAttribute('data-locked')).toBe('true');
    expect(within(locked).getByText(t.staff.dash.locked)).toBeTruthy();
    expect(within(locked).getByText(t.staff.dash.lockMark)).toBeTruthy();
    expect(within(locked).getByText(t.staff.dash.violations(5, 5))).toBeTruthy();
    expect(cardOf('학생07').getAttribute('data-dim')).toBe('true');
    expect(cardOf('학생08').getAttribute('data-dim')).toBe('true');
    expect(within(cardOf('학생08')).getByText(t.staff.dash.state.TERMINATED)).toBeTruthy();
  });

  it('(e) [확인]은 사유 없이 ACK를 보낸다', async () => {
    renderDash([summary(1, { unackedSeverity: 'WARN' }), summary(2)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.ack }));
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'ACK' }));
    // 확인할 것이 없는 카드(NONE)의 [확인]은 비활성
    expect((within(cardOf('학생02')).getByRole('button', { name: t.staff.dash.ack }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('(f) 사유가 비어 있으면 일시정지·종료가 비활성이고 빠른 선택 버튼이 사유를 채운다', async () => {
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    const pause = screen.getByRole('button', { name: t.staff.dash.pause }) as HTMLButtonElement;
    const term = screen.getByRole('button', { name: t.staff.dash.terminate }) as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(term.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.quickOk }));
    expect((screen.getByLabelText(t.staff.dash.reasonLabel) as HTMLInputElement).value).toBe(t.staff.dash.quickOk);
    expect(pause.disabled).toBe(false);
    expect(term.disabled).toBe(false);
    fireEvent.click(pause);
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'PAUSE', reason: t.staff.dash.quickOk }));
    // 공백만 입력하면 다시 비활성
    fireEvent.change(screen.getByLabelText(t.staff.dash.reasonLabel), { target: { value: '   ' } });
    await waitFor(() => expect((screen.getByRole('button', { name: t.staff.dash.pause }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('(g) 응시 종료는 확인 대화상자에서 확인한 뒤에만 API를 호출한다', async () => {
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    fireEvent.change(screen.getByLabelText(t.staff.dash.reasonLabel), { target: { value: '본인 요청' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.terminate }));
    expect(staffApi.postAction).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.staff.common.cancel }));
    expect(staffApi.postAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.terminate }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.staff.common.confirm }));
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'TERMINATE', reason: '본인 요청' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('(h) networkIncident가 있으면 상단 배너가 뜨고 null이면 사라진다', () => {
    renderDash([summary(1)], { networkIncident: { count: 3, attemptIds: ['a', 'b', 'c'], since: 1 } });
    expect(screen.getByText(t.staff.dash.networkIncident(3))).toBeTruthy();
    emitServer('network:incident', { count: 4, attemptIds: ['a', 'b', 'c', 'd'], since: 1 });
    expect(screen.getByText(t.staff.dash.networkIncident(4))).toBeTruthy();
    emitServer('network:incident', null);
    expect(screen.queryByText(/네트워크 장애 의심/)).toBeNull();
  });

  it('(i) 같은 이벤트가 두 번 와도(재전송) 카드가 중복되지 않는다', () => {
    const list = [summary(1), summary(2)];
    renderDash(list);
    const upd = summary(2, { unackedSeverity: 'WARN', violationCount: 1 });
    emitServer('attempt:updated', upd);
    emitServer('attempt:updated', upd);
    const sig = { attemptId: 'att-2', signal: { id: 's1', type: 'FULLSCREEN_EXIT', severity: 'WARN', clientAt: 1, receivedAt: 5, durationMs: null, questionId: null, meta: {} } };
    emitServer('signal:new', sig);
    emitServer('signal:new', sig);
    emitServer('dashboard:snapshot', snapshotOf(list));
    emitServer('dashboard:snapshot', snapshotOf(list));
    expect(screen.getAllByTestId('student-card')).toHaveLength(2);
  });

  it('(j) 화면에 금지어가 없고 신호는 관찰 사실로 표시된다', () => {
    renderDash([summary(1, { unackedSeverity: 'ALERT', violationCount: 3, lastSignal: { type: 'LEAVE', severity: 'ALERT', receivedAt: 10 } }), summary(2)]);
    emitServer('signal:new', { attemptId: 'att-1', signal: { id: 's', type: 'LEAVE', severity: 'ALERT', clientAt: 1, receivedAt: 10, durationMs: 12000, questionId: null, meta: {} } });
    emitServer('signal:new', { attemptId: 'att-2', signal: { id: 's2', type: 'PASTE', severity: 'WARN', clientAt: 1, receivedAt: 11, durationMs: null, questionId: null, meta: { length: 340, blocked: true } } });
    expect(within(cardOf('학생01')).getByText(/다른 탭\/앱으로 이동 \(12초\)/)).toBeTruthy();
    expect(within(cardOf('학생02')).getByText(/붙여넣기 340자 \(차단됨\)/)).toBeTruthy();
    const text = document.body.textContent ?? '';
    for (const w of ['부정행위', 'AI 사용', '적발', '커닝']) expect(text).not.toContain(w);
  });

  it('상태 배지: 연결 끊김과 이탈 중은 상태 배지와 함께 보인다', () => {
    renderDash([summary(1, { connected: false }), summary(2, { away: true })]);
    expect(within(cardOf('학생01')).getByText(t.staff.dash.disconnected)).toBeTruthy();
    expect(within(cardOf('학생02')).getByText(t.staff.dash.away)).toBeTruthy();
  });

  it('재연결하면 스냅샷을 다시 요청하고, 언마운트하면 구독을 해제한다', () => {
    const { unmount } = renderDash([summary(1)]);
    act(() => handlers.get('connect')!());
    act(() => handlers.get('connect')!());
    const joins = fakeSocket.emit.mock.calls.filter((c) => c[0] === 'dashboard:join');
    expect(joins.length).toBeGreaterThanOrEqual(2);
    expect(joins[0]![1]).toEqual({ examId: EXAM_ID });
    unmount();
    expect(fakeSocket.off).toHaveBeenCalled();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });

  it('잠긴 학생: [재개]와 "잠겨 있던 시간 n분 추가"(pausedAt 기준 올림 분)가 보이고 addPausedTime으로 RESUME을 보낸다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    const pausedAt = Date.now() - (7 * 60_000 + 1_000); // 7분 1초 전 -> 8분
    renderDash([summary(1, { state: 'PAUSED', locked: true, violationCount: 5, pausedAt, unackedSeverity: 'WARN' })]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.quickOk }));
    const addBtn = screen.getByRole('button', { name: t.staff.dash.resumeAddTime(8) });
    fireEvent.click(addBtn);
    await waitFor(() =>
      expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'RESUME', reason: t.staff.dash.quickOk, payload: { addPausedTime: true } }),
    );
    // 성공하면 사유가 비워지므로 다시 채운다. 일반 [재개]는 payload 없이
    await waitFor(() => expect((screen.getByLabelText(t.staff.dash.reasonLabel) as HTMLInputElement).value).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.quickOk }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.resume }));
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'RESUME', reason: t.staff.dash.quickOk }));
  });

  it('시간 추가: 1~60분 정수만 허용한다', async () => {
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    fireEvent.change(screen.getByLabelText(t.staff.dash.reasonLabel), { target: { value: '본인 요청' } });
    const btn = screen.getByRole('button', { name: t.staff.dash.addTime }) as HTMLButtonElement;
    const minutes = screen.getByLabelText(t.staff.dash.minutes);
    for (const bad of ['0', '61', '1.5', '', '-3']) {
      fireEvent.change(minutes, { target: { value: bad } });
      expect(btn.disabled, bad).toBe(true);
    }
    fireEvent.change(minutes, { target: { value: '60' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'ADD_TIME', reason: '본인 요청', payload: { minutes: 60 } }));
  });

  it('경고 메시지는 사유 입력란의 내용을 WARN으로 보낸다', async () => {
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.quickWarn }));
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.warn }));
    await waitFor(() => expect(staffApi.postAction).toHaveBeenCalledWith('att-1', { type: 'WARN', reason: t.staff.dash.quickWarn }));
  });

  it('요청 중에는 중복 클릭이 한 번만 전송되고, 409 BUSY·INVALID_STATE는 오류 문구로 표시된다', async () => {
    renderDash([summary(1, { unackedSeverity: 'WARN' })]);
    let reject!: (e: unknown) => void;
    vi.mocked(staffApi.postAction).mockReturnValue(new Promise((_, rej) => (reject = rej)));
    const ack = within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.ack });
    fireEvent.click(ack);
    fireEvent.click(ack);
    expect(staffApi.postAction).toHaveBeenCalledTimes(1);
    await act(async () => reject(new ApiError(409, 'BUSY')));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.BUSY);
    vi.mocked(staffApi.postAction).mockRejectedValue(new ApiError(409, 'INVALID_STATE'));
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.ack }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t.errors.INVALID_STATE));
  });

  it('시간 추가가 EXTRA_TIME_LIMIT(409)이면 고정 안내 문구가 보인다', async () => {
    vi.mocked(staffApi.postAction).mockRejectedValue(new ApiError(409, 'EXTRA_TIME_LIMIT'));
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    fireEvent.change(screen.getByLabelText(t.staff.dash.reasonLabel), { target: { value: '본인 요청' } });
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.addTime }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.EXTRA_TIME_LIMIT);
    expect(t.errors.EXTRA_TIME_LIMIT).toContain('24시간');
  });

  it('선택한 학생이 제출·종료 상태가 되면 조치 막대가 닫힌다', () => {
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    expect(screen.getByRole('button', { name: t.staff.dash.pause })).toBeTruthy();
    emitServer('attempt:updated', summary(1, { state: 'SUBMITTED' }));
    expect(screen.queryByRole('button', { name: t.staff.dash.pause })).toBeNull();
    expect(screen.queryByLabelText(t.staff.dash.reasonLabel)).toBeNull();
    expect(screen.getByText(t.staff.dash.noTarget)).toBeTruthy();
  });

  it('조치가 성공하면 사유 입력란이 비워지고, 실패하면 유지된다', async () => {
    renderDash([summary(1)]);
    fireEvent.click(within(cardOf('학생01')).getByRole('button', { name: t.staff.dash.select }));
    const box = () => screen.getByLabelText(t.staff.dash.reasonLabel) as HTMLInputElement;
    fireEvent.change(box(), { target: { value: '본인 요청' } });
    vi.mocked(staffApi.postAction).mockRejectedValueOnce(new ApiError(409, 'BUSY'));
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.pause }));
    await screen.findByRole('alert');
    expect(box().value).toBe('본인 요청');
    fireEvent.click(screen.getByRole('button', { name: t.staff.dash.pause }));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('알 수 없는 state의 항목은 무시하고 나머지 카드는 정상 표시한다', () => {
    renderDash([summary(1), { ...summary(2), state: 'WEIRD' as never }]);
    expect(order()).toEqual(['20240001']);
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('dashboard:join ack가 ok:false이면 안내 문구를 보이고, ok:true이면 보이지 않는다', () => {
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    const ack = () => fakeSocket.emit.mock.calls.filter((c) => c[0] === 'dashboard:join').at(-1)![2] as (r: unknown) => void;
    act(() => handlers.get('connect')!());
    act(() => ack()({ ok: false, code: 'FORBIDDEN' }));
    expect(screen.getByText(t.staff.dash.joinFailed)).toBeTruthy();
    act(() => handlers.get('connect')!());
    act(() => ack()({ ok: true, code: 'OK' }));
    expect(screen.queryByText(t.staff.dash.joinFailed)).toBeNull();
  });

  it('승인 요청은 스냅샷의 학번·이름과 함께 보관되고 이벤트로 추가·제거된다', () => {
    function Probe() {
      const d = useDashboard(EXAM_ID);
      return (
        <ul>
          {d.pendingApprovals.map((a) => (
            <li key={a.attemptId}>{`${a.kind}|${a.studentNo}|${a.name}`}</li>
          ))}
          <li>{`ready ${d.ready}/${d.total}`}</li>
        </ul>
      );
    }
    render(<Probe />);
    emitServer('dashboard:snapshot', snapshotOf([summary(3)], { pendingApprovals: [{ attemptId: 'att-3', kind: 'LATE', studentNo: '20240003', name: '학생03' }] }));
    expect(screen.getByText('LATE|20240003|학생03')).toBeTruthy();
    expect(screen.getByText('ready 7/1')).toBeTruthy(); // 스냅샷 초기값
    emitServer('approval:pending', { attemptId: 'att-3', kind: 'LATE' }); // 중복
    emitServer('approval:pending', { attemptId: 'att-9', kind: 'DUPLICATE' });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    emitServer('approval:resolved', { attemptId: 'att-3', kind: 'LATE' });
    expect(screen.queryByText('LATE|20240003|학생03')).toBeNull();
    emitServer('waiting:count', { ready: 9, total: 12 });
    expect(screen.getByText('ready 9/12')).toBeTruthy();
  });
});
