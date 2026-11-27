// 학생 행동 신호 수집(SPEC 5.1~5.3). 통합(ExamTaking·StudentFlow에 붙이기)은 Task 7.
// 신호에는 학생이 쓴 내용·토큰을 넣지 않는다. meta에는 길이·원인 같은 사실만 담는다.
import { useEffect, useRef, useState } from 'react';
import { createSignalQueue, type ClientSignalType, type QueueMsg, type SendResult, type SignalQueue } from './signalQueue';

// Task 1 병합 후 shared의 HEARTBEAT_MS로 교체 가능.
export const HEARTBEAT_MS = 5000;
const FOCUS_POLL_MS = 1000;
const ACK_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** socket.io-client Socket 중 쓰는 부분만(테스트에서 가짜로 바꾸기 쉽게). */
export interface SignalSocket {
  connected: boolean;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
  emit(event: string, payload: unknown): unknown;
  timeout(ms: number): { emit(event: string, payload: unknown, ack: (err: Error | null, res?: { ok: boolean; code?: string }) => void): unknown };
}

export interface SignalCollectorOptions {
  socket: SignalSocket | null;
  examCode: string;
  /** ACTIVE일 때만 true. false면 위반 신호를 만들지 않는다(하트비트는 별개). */
  enabled: boolean;
  /** WAITING·ACTIVE·PAUSED일 때 true. */
  heartbeatEnabled: boolean;
  pasteMode: 'RECORD' | 'BLOCK';
  getQuestionId(): string | null;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 글자 수(code point). 서버·useAutosave와 같은 기준. */
function textLength(s: string): number {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}

/** 답안 입력란인가: textarea 또는 data-answer-input 표시가 있는 요소(Task 7에서 필요하면 입력란에 표시). */
function inAnswerField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('textarea, [data-answer-input]') !== null;
}

export function useSignalCollector(options: SignalCollectorOptions): { awayNow: boolean } {
  const { socket, examCode } = options;
  const [awayNow, setAwayNow] = useState(false);
  const opts = useRef(options);
  opts.current = options;

  const queueRef = useRef<{ code: string; q: SignalQueue } | null>(null);
  const getQueue = (): SignalQueue => {
    if (!queueRef.current || queueRef.current.code !== opts.current.examCode) {
      queueRef.current = { code: opts.current.examCode, q: createSignalQueue(safeStorage(), `exam:${opts.current.examCode}`) };
    }
    return queueRef.current.q;
  };

  // 소켓·시험 코드가 바뀔 때만 리스너·타이머를 다시 건다. 나머지 옵션은 ref로 최신 값을 읽는다.
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffN = 0;
    let away: { startAt: number; cause: 'hidden' | 'blur'; questionId: string | null } | null = null;

    const send = (msg: QueueMsg): Promise<SendResult> => {
      const s = opts.current.socket;
      if (!s || !s.connected) return Promise.resolve({ ok: false });
      if (msg.type === 'HB') {
        // 하트비트는 ack를 기다리지 않는다(소켓은 보낸 순서를 유지한다).
        s.emit('hb', { seq: msg.seq });
        return Promise.resolve({ ok: true });
      }
      const { seq, type, clientAt, durationMs, questionId, meta } = msg;
      return new Promise<SendResult>((resolve) => {
        s.timeout(ACK_TIMEOUT_MS).emit('signal', { seq, type, clientAt, durationMs, questionId, meta }, (err, res) => {
          if (err || !res) resolve({ ok: false });
          else resolve({ ok: !!res.ok, code: res.code });
        });
      });
    };

    const drain = () => {
      const s = opts.current.socket;
      if (!alive || !s || !s.connected) return;
      void getQueue()
        .drain(send)
        .then(() => {
          if (!alive) return;
          if (getQueue().size() === 0) {
            backoffN = 0;
            return;
          }
          const s2 = opts.current.socket;
          if (!s2 || !s2.connected) return; // 재연결 때 다시 비운다
          // RATE·BUSY·시간 초과 등: 지수 백오프 뒤 같은 건부터 재시도.
          // 같은 진행 중 drain을 여러 번 기다린 호출이 있어도 백오프는 한 번만 올린다.
          if (retryTimer !== undefined) return;
          backoffN += 1;
          const delay = Math.min(BACKOFF_BASE_MS * 2 ** (backoffN - 1), BACKOFF_MAX_MS);
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            drain();
          }, delay);
        });
    };

    const emitSignal = (type: ClientSignalType, extra: { durationMs?: number; questionId?: string | null; meta?: object } = {}) => {
      const q = getQueue();
      const msg: QueueMsg = { seq: q.nextSeq(), type, clientAt: Date.now(), meta: extra.meta ?? {} };
      if (extra.durationMs !== undefined) msg.durationMs = extra.durationMs;
      const qid = extra.questionId === undefined ? opts.current.getQuestionId() : extra.questionId;
      if (qid) msg.questionId = qid;
      q.enqueue(msg);
      drain();
    };

    // --- 이탈(탭 숨김·창 포커스 상실). 겹쳐도 LEAVE는 1건 ---
    const beginAway = (cause: 'hidden' | 'blur') => {
      if (away) {
        if (cause === 'hidden') away.cause = 'hidden'; // 탭 숨김이 더 강한 원인
        return;
      }
      if (!opts.current.enabled) return;
      away = { startAt: Date.now(), cause, questionId: opts.current.getQuestionId() };
      setAwayNow(true);
      emitSignal('LEAVE_START', { questionId: away.questionId });
    };
    // LEAVE_START를 보낸 이탈은 그 사이 enabled가 꺼졌어도 짝을 맞춰 LEAVE로 닫는다(서버가 상태에 따라 세지 않음).
    const endAway = () => {
      if (!away) return;
      const a = away;
      away = null;
      setAwayNow(false);
      emitSignal('LEAVE', { durationMs: Math.max(0, Date.now() - a.startAt), questionId: a.questionId, meta: { cause: a.cause } });
    };
    const checkReturn = () => {
      if (!document.hidden && document.hasFocus()) endAway();
    };

    const onVisibility = () => (document.hidden ? beginAway('hidden') : checkReturn());
    const onBlur = () => beginAway('blur');
    const onFocus = () => checkReturn();
    const focusPoll = setInterval(() => {
      if (document.hidden) beginAway('hidden');
      else if (!document.hasFocus()) beginAway('blur');
      else checkReturn();
    }, FOCUS_POLL_MS);

    const onFullscreen = () => {
      if (!document.fullscreenElement && opts.current.enabled) emitSignal('FULLSCREEN_EXIT');
    };

    // --- 붙여넣기·드롭: 길이만 보낸다(내용은 보내지 않는다) ---
    const onClipboardLike = (type: 'PASTE' | 'DROP') => (e: Event) => {
      if (!inAnswerField(e.target)) return;
      const blocked = opts.current.pasteMode === 'BLOCK';
      if (blocked) e.preventDefault();
      if (!opts.current.enabled) return;
      let length = 0;
      try {
        const dt = type === 'PASTE' ? (e as ClipboardEvent).clipboardData : (e as DragEvent).dataTransfer;
        length = textLength(dt?.getData('text') ?? '');
      } catch {
        length = 0;
      }
      emitSignal(type, { meta: { length, blocked } });
    };
    const onPaste = onClipboardLike('PASTE');
    const onDrop = onClipboardLike('DROP');
    // BLOCK이면 dragover도 막아 브라우저가 파일을 열어 버리는 기본 동작을 방지한다.
    const onDragOver = (e: Event) => {
      if (opts.current.pasteMode === 'BLOCK' && inAnswerField(e.target)) e.preventDefault();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragover', onDragOver, true);

    // --- 하트비트: 연결된 동안만 seq를 쓴다(끊긴 동안 만들지 않아 seq 빈틈·폭주가 없다) ---
    const hbTimer = setInterval(() => {
      const s = opts.current.socket;
      if (!opts.current.heartbeatEnabled || !s || !s.connected) return;
      const q = getQueue();
      q.enqueue({ seq: q.nextSeq(), type: 'HB', clientAt: Date.now(), meta: {} });
      drain();
    }, HEARTBEAT_MS);

    const onConnect = () => {
      backoffN = 0;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      drain();
    };
    socket?.on('connect', onConnect);
    drain(); // 새로고침 직후 남아 있던 신호

    return () => {
      alive = false;
      clearInterval(hbTimer);
      clearInterval(focusPoll);
      clearTimeout(retryTimer);
      socket?.off('connect', onConnect);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragover', onDragOver, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, examCode]);

  return { awayNow };
}
