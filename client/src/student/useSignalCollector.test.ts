// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSignalCollector, type SignalCollectorOptions, type SignalSocket } from './useSignalCollector';

type SignalAck = (err: Error | null, res?: { ok: boolean; code?: string }) => void;
interface Sent {
  event: 'hb' | 'signal';
  payload: Record<string, unknown>;
  ack?: SignalAck;
}

/** autoAck가 true면 signal을 바로 ok로 응답한다. false면 테스트가 ack를 직접 호출한다. */
function makeSocket(connected = true, autoAck = true) {
  const handlers = new Map<string, () => void>();
  const sent: Sent[] = [];
  const socket = {
    connected,
    autoAck,
    on: vi.fn((ev: string, h: () => void) => void handlers.set(ev, h)),
    off: vi.fn((ev: string) => void handlers.delete(ev)),
    emit: (event: string, payload: Record<string, unknown>) => void sent.push({ event: event as 'hb', payload }),
    timeout: () => ({
      emit: (event: string, payload: Record<string, unknown>, ack: SignalAck) => {
        sent.push({ event: event as 'signal', payload, ack });
        if (socket.autoAck) ack(null, { ok: true });
      },
    }),
  };
  return { socket: socket as unknown as SignalSocket & { connected: boolean; autoAck: boolean }, sent, handlers };
}

let hidden = false;
let focused = true;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  hidden = false;
  focused = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(over: Partial<SignalCollectorOptions> = {}, connected = true, autoAck = true) {
  const s = makeSocket(connected, autoAck);
  const getQuestionId = vi.fn(() => 'q1');
  const initial: SignalCollectorOptions = {
    socket: s.socket,
    examCode: 'EX',
    enabled: true,
    heartbeatEnabled: true,
    pasteMode: 'RECORD',
    getQuestionId,
    ...over,
  };
  const hook = renderHook((p: SignalCollectorOptions) => useSignalCollector(p), { initialProps: initial });
  return { ...s, hook, initial };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const tick = (ms: number) =>
  act(async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  });
const signals = (sent: Sent[], type?: string) => sent.filter((s) => s.event === 'signal' && (!type || s.payload.type === type));

function goAway(cause: 'hidden' | 'blur') {
  act(() => {
    if (cause === 'hidden') {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    } else {
      focused = false;
      window.dispatchEvent(new Event('blur'));
    }
  });
}
function comeBack() {
  act(() => {
    hidden = false;
    focused = true;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

function makeTextarea() {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  return ta;
}
function firePaste(el: Element, text: string) {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } });
  act(() => void el.dispatchEvent(ev));
  return ev;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('하트비트와 seq', () => {
  it('(a) 5초마다 hb가 가고 seq가 1씩 늘며 신호와 같은 카운터를 쓴다', async () => {
    const { sent } = setup();
    await tick(4999);
    expect(sent).toHaveLength(0);
    await tick(1);
    expect(sent.map((s) => [s.event, s.payload.seq])).toEqual([['hb', 1]]);
    goAway('hidden'); // LEAVE_START = seq 2
    await tick(5000); // hb = seq 3
    const all = sent.map((s) => [s.event, s.payload.seq]);
    expect(all).toEqual([
      ['hb', 1],
      ['signal', 2],
      ['hb', 3],
    ]);
  });

  it('heartbeatEnabled=false면 하트비트를 보내지 않는다', async () => {
    const { sent } = setup({ heartbeatEnabled: false });
    await tick(20_000);
    expect(sent).toHaveLength(0);
  });

  it('끊긴 동안에는 하트비트를 만들지 않아 seq에 빈틈이 없다', async () => {
    const { sent, socket, handlers } = setup({}, false);
    await tick(30_000);
    expect(sent).toHaveLength(0);
    socket.connected = true;
    act(() => handlers.get('connect')!());
    await tick(5000);
    expect(sent.map((s) => s.payload.seq)).toEqual([1]);
  });
});

describe('이탈(LEAVE)', () => {
  it('(b) 탭 숨김 즉시 LEAVE_START, 5초 뒤 복귀하면 LEAVE(durationMs≈5000, cause hidden)', async () => {
    const { sent, hook } = setup({ heartbeatEnabled: false });
    goAway('hidden');
    await tick(0);
    expect(signals(sent, 'LEAVE_START')).toHaveLength(1);
    expect(hook.result.current.awayNow).toBe(true);
    await tick(5000);
    comeBack();
    await tick(0);
    const leave = signals(sent, 'LEAVE');
    expect(leave).toHaveLength(1);
    expect(leave[0]!.payload).toMatchObject({ type: 'LEAVE', durationMs: 5000, meta: { cause: 'hidden' }, questionId: 'q1' });
    expect(hook.result.current.awayNow).toBe(false);
  });

  it('(b) blur만 발생하면 cause가 blur', async () => {
    const { sent } = setup({ heartbeatEnabled: false });
    goAway('blur');
    await tick(3000);
    comeBack();
    await tick(0);
    expect(signals(sent, 'LEAVE')[0]!.payload).toMatchObject({ durationMs: 3000, meta: { cause: 'blur' } });
  });

  it('(b) 숨김과 blur가 겹쳐도 LEAVE는 1건이고 숨김이면 cause는 hidden', async () => {
    const { sent } = setup({ heartbeatEnabled: false });
    goAway('blur');
    goAway('hidden');
    await tick(2000);
    expect(signals(sent, 'LEAVE_START')).toHaveLength(1);
    comeBack();
    await tick(2000); // 복귀 뒤 poll이 돌아도 추가 신호 없음
    expect(signals(sent, 'LEAVE')).toHaveLength(1);
    expect(signals(sent, 'LEAVE')[0]!.payload).toMatchObject({ meta: { cause: 'hidden' } });
  });

  it('(b) 이벤트 없이 포커스만 잃은 경우 1초 주기 hasFocus 확인으로 잡는다', async () => {
    const { sent } = setup({ heartbeatEnabled: false });
    focused = false;
    await tick(1000);
    expect(signals(sent, 'LEAVE_START')).toHaveLength(1);
    focused = true;
    await tick(1000);
    expect(signals(sent, 'LEAVE')).toHaveLength(1);
  });

  it('숨김에서 돌아와도 포커스가 없으면 아직 이탈 중이다', async () => {
    const { sent } = setup({ heartbeatEnabled: false });
    goAway('hidden');
    act(() => {
      hidden = false;
      focused = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(0);
    expect(signals(sent, 'LEAVE')).toHaveLength(0);
  });
});

describe('전체화면 해제', () => {
  it('(c) fullscreenchange로 전체화면이 풀리면 FULLSCREEN_EXIT 1건', async () => {
    const { sent } = setup({ heartbeatEnabled: false });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body });
    act(() => void document.dispatchEvent(new Event('fullscreenchange'))); // 진입: 신호 없음
    await tick(0);
    expect(signals(sent)).toHaveLength(0);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    act(() => void document.dispatchEvent(new Event('fullscreenchange')));
    await tick(0);
    expect(signals(sent, 'FULLSCREEN_EXIT')).toHaveLength(1);
  });
});

describe('붙여넣기·드롭', () => {
  it('(d) BLOCK이면 paste 기본 동작을 막고 PASTE {length, blocked:true}만 보낸다(내용은 보내지 않는다)', async () => {
    const { sent } = setup({ pasteMode: 'BLOCK', heartbeatEnabled: false });
    const ta = makeTextarea();
    const ev = firePaste(ta, '비밀 내용😀abc');
    expect(ev.defaultPrevented).toBe(true);
    await tick(0);
    const p = signals(sent, 'PASTE');
    expect(p).toHaveLength(1);
    expect(p[0]!.payload.meta).toEqual({ length: 9, blocked: true });
    expect(JSON.stringify(sent)).not.toContain('비밀');
  });

  it('(d) RECORD면 막지 않고 blocked:false로 기록한다', async () => {
    const { sent } = setup({ pasteMode: 'RECORD', heartbeatEnabled: false });
    const ta = makeTextarea();
    const ev = firePaste(ta, 'abc');
    expect(ev.defaultPrevented).toBe(false);
    await tick(0);
    expect(signals(sent, 'PASTE')[0]!.payload.meta).toEqual({ length: 3, blocked: false });
  });

  it('드롭도 DROP {length, blocked}으로 기록하고 BLOCK이면 막는다', async () => {
    const { sent } = setup({ pasteMode: 'BLOCK', heartbeatEnabled: false });
    const ta = makeTextarea();
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { getData: () => 'xyz' } });
    act(() => void ta.dispatchEvent(ev));
    await tick(0);
    expect(ev.defaultPrevented).toBe(true);
    expect(signals(sent, 'DROP')[0]!.payload.meta).toEqual({ length: 3, blocked: true });
  });

  it('답안 입력란이 아닌 곳의 paste는 무시한다', async () => {
    const { sent } = setup({ pasteMode: 'BLOCK', heartbeatEnabled: false });
    const div = document.createElement('div');
    document.body.appendChild(div);
    const ev = firePaste(div, 'abc');
    expect(ev.defaultPrevented).toBe(false);
    await tick(0);
    expect(signals(sent)).toHaveLength(0);
  });

  it('onPasteBlocked: BLOCK에서 막는 순간 종류와 함께 호출된다(enabled가 꺼져 있어도)', async () => {
    const onPasteBlocked = vi.fn();
    setup({ pasteMode: 'BLOCK', enabled: false, heartbeatEnabled: false, onPasteBlocked });
    const ta = makeTextarea();
    firePaste(ta, 'abc');
    expect(onPasteBlocked).toHaveBeenCalledTimes(1);
    expect(onPasteBlocked).toHaveBeenLastCalledWith('PASTE');
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { getData: () => 'x' } });
    act(() => void ta.dispatchEvent(ev));
    expect(onPasteBlocked).toHaveBeenCalledTimes(2);
    expect(onPasteBlocked).toHaveBeenLastCalledWith('DROP');
  });

  it('onPasteBlocked: RECORD와 입력란이 아닌 곳에서는 호출되지 않는다', async () => {
    const onPasteBlocked = vi.fn();
    setup({ pasteMode: 'RECORD', heartbeatEnabled: false, onPasteBlocked });
    firePaste(makeTextarea(), 'abc');
    expect(onPasteBlocked).not.toHaveBeenCalled();
    const b = setup({ pasteMode: 'BLOCK', heartbeatEnabled: false, onPasteBlocked });
    const div = document.createElement('div');
    document.body.appendChild(div);
    firePaste(div, 'abc');
    expect(onPasteBlocked).not.toHaveBeenCalled();
    b.hook.unmount();
  });

  it('onPasteBlocked: 언마운트 뒤에는 호출되지 않는다', async () => {
    const onPasteBlocked = vi.fn();
    const { hook } = setup({ pasteMode: 'BLOCK', heartbeatEnabled: false, onPasteBlocked });
    hook.unmount();
    firePaste(makeTextarea(), 'abc');
    expect(onPasteBlocked).not.toHaveBeenCalled();
  });
});

describe('오프라인 큐', () => {
  it('(e) 끊긴 동안 신호 3건을 쌓고 재연결하면 seq 순서대로 한 건씩, ack 뒤에만 제거한다', async () => {
    const { sent, socket, handlers } = setup({ heartbeatEnabled: false }, false, false);
    const ta = makeTextarea();
    firePaste(ta, 'a');
    firePaste(ta, 'bb');
    firePaste(ta, 'ccc');
    await tick(0);
    expect(sent).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('exam:EX:signalQueue')!)).toHaveLength(3);

    socket.connected = true;
    act(() => handlers.get('connect')!());
    await tick(0);
    expect(sent.map((s) => s.payload.seq)).toEqual([1]); // 첫 ack 전에는 다음을 보내지 않는다
    expect(JSON.parse(localStorage.getItem('exam:EX:signalQueue')!)).toHaveLength(3);
    act(() => sent[0]!.ack!(null, { ok: true }));
    await tick(0);
    expect(sent.map((s) => s.payload.seq)).toEqual([1, 2]);
    act(() => sent[1]!.ack!(null, { ok: true }));
    await tick(0);
    act(() => sent[2]!.ack!(null, { ok: true }));
    await tick(0);
    expect(sent.map((s) => s.payload.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(localStorage.getItem('exam:EX:signalQueue')!)).toHaveLength(0);
  });

  it('(e) RATE로 거절되면 순서를 유지한 채 남기고 백오프 뒤 같은 건부터 재시도한다', async () => {
    const { sent } = setup({ heartbeatEnabled: false }, true, false);
    const ta = makeTextarea();
    firePaste(ta, 'a');
    firePaste(ta, 'bb');
    await tick(0);
    expect(sent.map((s) => s.payload.seq)).toEqual([1]);
    act(() => sent[0]!.ack!(null, { ok: false, code: 'RATE' }));
    await tick(0);
    expect(sent).toHaveLength(1); // 바로 재시도하지 않는다
    await tick(999);
    expect(sent).toHaveLength(1);
    await tick(1); // 1초 백오프
    expect(sent.map((s) => s.payload.seq)).toEqual([1, 1]);
    act(() => sent[1]!.ack!(null, { ok: false, code: 'BUSY' }));
    await tick(1999);
    expect(sent).toHaveLength(2);
    await tick(1); // 2초 백오프
    expect(sent.map((s) => s.payload.seq)).toEqual([1, 1, 1]);
    act(() => sent[2]!.ack!(null, { ok: true }));
    await tick(0);
    expect(sent.map((s) => s.payload.seq)).toEqual([1, 1, 1, 2]); // 순서 유지
  });

  it('(f) 새로고침(언마운트 후 새 마운트)해도 seq가 이어지고 미전송 신호가 남아 있다가 전송된다', async () => {
    const first = setup({ heartbeatEnabled: false }, false);
    const ta = makeTextarea();
    firePaste(ta, 'a');
    firePaste(ta, 'bb');
    await tick(0);
    first.hook.unmount();

    const second = setup({ heartbeatEnabled: false }, true);
    await tick(0);
    expect(signals(second.sent).map((s) => s.payload.seq)).toEqual([1, 2]); // 남아 있던 신호
    firePaste(ta, 'ccc');
    await tick(0);
    expect(signals(second.sent).map((s) => s.payload.seq)).toEqual([1, 2, 3]); // seq 이어짐
  });

  it('저장소 접근이 던져도 메모리로 동작한다', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { sent } = setup({ heartbeatEnabled: false });
    firePaste(makeTextarea(), 'a');
    await tick(0);
    expect(signals(sent, 'PASTE')).toHaveLength(1);
  });
});

describe('enabled', () => {
  it('(g) enabled=false에서는 위반 신호를 만들지 않고 하트비트는 계속 보낸다', async () => {
    const { sent } = setup({ enabled: false, pasteMode: 'RECORD' });
    goAway('hidden');
    comeBack();
    firePaste(makeTextarea(), 'abc');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    act(() => void document.dispatchEvent(new Event('fullscreenchange')));
    await tick(5000);
    expect(signals(sent)).toHaveLength(0);
    expect(sent.map((s) => s.event)).toEqual(['hb']);
    await tick(5000);
    expect(sent.map((s) => s.event)).toEqual(['hb', 'hb']);
  });

  it('(g) enabled=false여도 BLOCK이면 붙여넣기는 막는다(신호만 없음)', async () => {
    const { sent } = setup({ enabled: false, pasteMode: 'BLOCK', heartbeatEnabled: false });
    const ev = firePaste(makeTextarea(), 'abc');
    expect(ev.defaultPrevented).toBe(true);
    await tick(0);
    expect(signals(sent)).toHaveLength(0);
  });

  it('enabled가 true로 바뀌면 그 뒤부터 수집한다', async () => {
    const { sent, hook, initial } = setup({ enabled: false, heartbeatEnabled: false });
    goAway('hidden');
    comeBack();
    hook.rerender({ ...initial, enabled: true, heartbeatEnabled: false });
    goAway('hidden');
    await tick(0);
    expect(signals(sent, 'LEAVE_START')).toHaveLength(1);
  });
});

describe('정리', () => {
  it('(h) 언마운트하면 모든 리스너와 타이머를 정리한다', async () => {
    const docAdd = vi.spyOn(document, 'addEventListener');
    const winAdd = vi.spyOn(window, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const { hook, sent, socket } = setup();
    const added = [...docAdd.mock.calls, ...winAdd.mock.calls].length;
    expect(added).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect([...docRemove.mock.calls, ...winRemove.mock.calls].length).toBe(added);
    for (const call of [...docAdd.mock.calls, ...winAdd.mock.calls]) {
      const [type, handler] = call;
      const removed = [...docRemove.mock.calls, ...winRemove.mock.calls].some((c) => c[0] === type && c[1] === handler);
      expect(removed).toBe(true);
    }
    expect(socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    // 정리 뒤에는 어떤 이벤트도 신호를 만들지 않는다
    goAway('hidden');
    firePaste(makeTextarea(), 'abc');
    await tick(20_000);
    expect(sent).toHaveLength(0);
  });
});
