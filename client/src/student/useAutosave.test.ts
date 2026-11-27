// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drafts } from './session';
import { useAutosave, type AutosaveSocket } from './useAutosave';

type Ack = (err: Error | null, res?: { ok: boolean; savedAt?: string; code?: string }) => void;
interface Sent {
  payload: Record<string, unknown>;
  ack: Ack;
}

function makeSocket(connected = true) {
  const handlers = new Map<string, () => void>();
  const sent: Sent[] = [];
  const socket = {
    connected,
    on: vi.fn((ev: string, h: () => void) => {
      handlers.set(ev, h);
    }),
    off: vi.fn((ev: string) => {
      handlers.delete(ev);
    }),
    timeout: () => ({
      emit: (_ev: string, payload: Record<string, unknown>, ack: Ack) => {
        sent.push({ payload, ack });
      },
    }),
  };
  return { socket: socket as unknown as AutosaveSocket & { connected: boolean }, sent, handlers };
}

const okAck = (s: Sent, savedAt = '2026-11-27T05:03:21.000Z') => act(() => s.ack(null, { ok: true, savedAt }));
const failAck = (s: Sent, code: string) => act(() => s.ack(null, { ok: false, code }));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

function setup(over: Partial<Parameters<typeof useAutosave>[0]> = {}, connected = true) {
  const s = makeSocket(connected);
  const onStale = vi.fn();
  const onNotActive = vi.fn();
  const hook = renderHook(() => useAutosave({ socket: s.socket, examCode: 'EX', onStale, onNotActive, ...over }));
  return { ...s, hook, onStale, onNotActive };
}

describe('useAutosave 타이밍', () => {
  it('입력 후 1초에 한 번 전송한다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: '가' }));
    act(() => void vi.advanceTimersByTime(999));
    expect(sent).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ questionId: 'q1', text: '가', rev: 1 });
  });

  it('계속 입력해도 5초 안에 최소 한 번 전송한다', () => {
    const { hook, sent } = setup();
    for (let i = 0; i < 12; i++) {
      act(() => hook.result.current.change('q1', { text: 'a'.repeat(i + 1) }));
      act(() => void vi.advanceTimersByTime(500));
    }
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.payload.text).toBe('aaaaaaaaaa'); // 5초 시점의 값(10글자)
  });

  it('연결이 끊긴 동안 입력하면 보내지 않고, 재연결 시 최신 값을 한 번 보낸다', () => {
    const { hook, sent, handlers, socket } = setup({}, false);
    act(() => hook.result.current.change('q1', { text: '하나' }));
    act(() => hook.result.current.change('q1', { text: '하나둘' }));
    act(() => void vi.advanceTimersByTime(12_000));
    expect(sent).toHaveLength(0);
    socket.connected = true;
    act(() => handlers.get('connect')!());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ questionId: 'q1', text: '하나둘', rev: 2 });
  });

  it('IME 조합 중에는 보내지 않고, 조합이 끝나면 1초 뒤에 보낸다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.compositionStart());
    act(() => hook.result.current.change('q1', { text: 'ㅎ' }));
    act(() => void vi.advanceTimersByTime(7000)); // 디바운스·5초 강제 타이머가 지나도
    expect(sent).toHaveLength(0);
    act(() => hook.result.current.change('q1', { text: '한' }));
    act(() => hook.result.current.compositionEnd());
    act(() => void vi.advanceTimersByTime(999));
    expect(sent).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.text).toBe('한');
  });

  it('언마운트 뒤에는 타이머가 전송하지 않는다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: '가' }));
    hook.unmount();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(0);
  });
});

describe('useAutosave rev 규칙', () => {
  it('내용이 바뀔 때마다 rev가 오르고, 같은 내용은 올리지 않는다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    okAck(sent[0]!);
    act(() => hook.result.current.change('q1', { text: 'ab' }));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent.map((s) => s.payload.rev)).toEqual([1, 2]);
    okAck(sent[1]!);
    act(() => hook.result.current.change('q1', { text: 'ab' })); // 같은 내용
    act(() => void vi.advanceTimersByTime(6000));
    expect(sent).toHaveLength(2);
  });

  it('서버가 가진 rev 다음부터 시작한다(seed)', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.seed('q1', 7));
    act(() => hook.result.current.change('q1', { choiceId: 'c2' }));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent[0]!.payload).toEqual({ questionId: 'q1', choiceId: 'c2', rev: 8 });
  });

  it('ack 실패 뒤 재전송은 같은 rev·같은 내용이다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    failAck(sent[0]!, 'BUSY');
    act(() => void vi.advanceTimersByTime(1000)); // 첫 백오프 1초
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload).toEqual(sent[0]!.payload);
  });

  it('BUSY는 지수 백오프(1초, 2초, 4초)로 재시도한다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    failAck(sent[0]!, 'BUSY');
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toHaveLength(2);
    failAck(sent[1]!, 'BUSY');
    act(() => void vi.advanceTimersByTime(1999));
    expect(sent).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(1));
    expect(sent).toHaveLength(3);
  });

  it('성공하면 savedAt을 돌려주고 초안을 지운다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: '내용' }));
    expect(drafts.load('EX', 'q1')).toEqual({ rev: 1, text: '내용' });
    act(() => void vi.advanceTimersByTime(1000));
    okAck(sent[0]!, '2026-11-27T05:03:21.000Z');
    expect(hook.result.current.savedAt?.toISOString()).toBe('2026-11-27T05:03:21.000Z');
    expect(drafts.load('EX', 'q1')).toBeNull();
    expect(hook.result.current.pending).toBe(false);
  });

  it('저장 중 더 입력했다면 초안은 남기고 다음 rev로 다시 보낸다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => hook.result.current.change('q1', { text: 'ab' }));
    okAck(sent[0]!);
    expect(drafts.load('EX', 'q1')).toEqual({ rev: 2, text: 'ab' });
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent[1]!.payload).toEqual({ questionId: 'q1', text: 'ab', rev: 2 });
  });
});

describe('useAutosave ack 오류', () => {
  it('STALE_REV는 재동기화를 요청한다', () => {
    const { hook, sent, onStale } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    failAck(sent[0]!, 'STALE_REV');
    expect(onStale).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(1); // 같은 값을 계속 보내지 않는다
  });

  it('adopt로 서버 값을 받아들이면 초안이 지워지고 그 rev 다음부터 이어간다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    failAck(sent[0]!, 'STALE_REV');
    act(() => hook.result.current.adopt([{ questionId: 'q1', rev: 5 }]));
    expect(drafts.load('EX', 'q1')).toBeNull();
    act(() => hook.result.current.change('q1', { text: 'b' }));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent[1]!.payload.rev).toBe(6);
  });

  it('NOT_ACTIVE는 저장을 멈추고 상태 재확인을 요청한다', () => {
    const { hook, sent, onNotActive } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    failAck(sent[0]!, 'NOT_ACTIVE');
    expect(onNotActive).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.change('q1', { text: 'ab' }));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(sent).toHaveLength(1);
  });

  it('TOO_LONG·INVALID는 오류를 표시하고 재시도하지 않는다. 내용이 바뀌면 다시 시도한다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    failAck(sent[0]!, 'INVALID');
    expect(hook.result.current.errors.q1).toBe('INVALID');
    act(() => void vi.advanceTimersByTime(20_000));
    expect(sent).toHaveLength(1);
    act(() => hook.result.current.change('q1', { text: 'ab' }));
    expect(hook.result.current.errors.q1).toBeUndefined();
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toHaveLength(2);
  });

  it('5000자(code point)를 넘으면 보내지 않고 TOO_LONG을 표시한다', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: '😀'.repeat(5001) })); // UTF-16으로는 10002
    act(() => void vi.advanceTimersByTime(6000));
    expect(sent).toHaveLength(0);
    expect(hook.result.current.errors.q1).toBe('TOO_LONG');
    act(() => hook.result.current.change('q1', { text: '😀'.repeat(5000) })); // 정확히 5000자는 통과
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toHaveLength(1);
  });

  it('flushAll은 모든 미저장 답안을 즉시 보내고 ack 뒤에 true로 끝난다', async () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.change('q1', { text: 'a' }));
    act(() => hook.result.current.change('q2', { choiceId: 'c1' }));
    let result: boolean | null = null;
    act(() => {
      void hook.result.current.flushAll().then((r) => (result = r));
    });
    expect(sent).toHaveLength(2);
    okAck(sent[0]!);
    okAck(sent[1]!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result).toBe(true);
  });
});
