// 답안 자동 저장(SPEC F-11). 변경 후 1초 디바운스 + 미저장분은 최소 5초마다 강제 전송.
// 서버 규칙(rev): 같은 문항에서 내용이 바뀔 때마다 rev를 올려야 하고(같은 rev에 다른 내용은 STALE_REV),
// 같은 rev·같은 내용 재전송은 멱등 성공이다. 그래서 rev는 "내용이 바뀔 때"만 올리고 재전송은 같은 rev로 보낸다.
import { EV } from '@exam/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drafts } from './session';

export type AnswerValue = { choiceId: string } | { text: string };
type SaveAck = { ok: true; savedAt: string } | { ok: false; code: string };

/** socket.io-client의 Socket 중 쓰는 부분만(테스트에서 가짜로 바꾸기 쉽게). */
export interface AutosaveSocket {
  connected: boolean;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
  timeout(ms: number): { emit(event: string, payload: unknown, ack: (err: Error | null, res?: SaveAck) => void): unknown };
}

export interface AutosaveOptions {
  socket: AutosaveSocket | null;
  examCode: string;
  /** false면 보내지 않는다(일시정지 등). true로 돌아오면 멈춤 상태를 풀고 다시 보낸다. */
  enabled?: boolean;
  /** STALE_REV: 서버 값이 더 새롭다. 호출한 쪽이 서버에서 다시 읽어 adopt()로 알려 준다. */
  onStale?: () => void;
  /** NOT_ACTIVE: 저장을 멈춘다. 호출한 쪽이 응시 상태를 다시 확인한다. */
  onNotActive?: () => void;
}

export const DEBOUNCE_MS = 1000;
export const FORCE_MS = 5000;
export const MAX_TEXT_LENGTH = 5000;
const ACK_TIMEOUT_MS = 5000;
const FLUSH_WAIT_MS = 8000;
const BACKOFF_MAX_MS = 30_000;

interface Entry {
  answer: AnswerValue | null;
  rev: number;
  ackedRev: number;
  inFlightRev: number | null;
  /** 연결이 다시 맺어지면 올린다. 이전 연결에서 보낸 요청의 늦은 ack를 무시하기 위함 */
  gen: number;
  blocked: string | null;
}

const isDirty = (e: Entry) => e.answer !== null && e.rev > e.ackedRev;

/** 글자 수(code point). 서버도 code point로 센다(UTF-16 길이로 세면 이모지에서 어긋난다). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}

function sameAnswer(a: AnswerValue | null, b: AnswerValue): boolean {
  if (!a) return false;
  if ('text' in a && 'text' in b) return a.text === b.text;
  if ('choiceId' in a && 'choiceId' in b) return a.choiceId === b.choiceId;
  return false;
}

export function useAutosave(options: AutosaveOptions) {
  const { socket, examCode } = options;
  const enabled = options.enabled ?? true;
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  // 최신 옵션을 타이머 콜백에서 읽기 위해 ref에 둔다.
  const opts = useRef({ socket, examCode, enabled, onStale: options.onStale, onNotActive: options.onNotActive });
  opts.current = { socket, examCode, enabled, onStale: options.onStale, onNotActive: options.onNotActive };

  const entries = useRef(new Map<string, Entry>());
  const composing = useRef(false);
  const halted = useRef(false);
  const backoffN = useRef(0);
  const timers = useRef<{ debounce?: ReturnType<typeof setTimeout>; force?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout> }>({});
  const waiters = useRef(new Set<() => void>());
  const alive = useRef(true);
  // 함수들이 서로를 부르므로 한 객체에 모아 ref로 연결한다.
  const api = useRef<{ flush: (force?: boolean) => void; scheduleDebounce: () => void; scheduleForce: () => void }>(null as never);

  const refreshPending = () => {
    if (!alive.current) return;
    setPending([...entries.current.values()].some((e) => isDirty(e) && !e.blocked));
    for (const w of [...waiters.current]) w();
  };
  const setError = (questionId: string, code: string | null) => {
    if (!alive.current) return;
    setErrors((prev) => {
      if (code === null) {
        if (!(questionId in prev)) return prev;
        const { [questionId]: _removed, ...rest } = prev; // eslint-disable-line @typescript-eslint/no-unused-vars
        return rest;
      }
      return prev[questionId] === code ? prev : { ...prev, [questionId]: code };
    });
  };

  const handleAck = (questionId: string, entry: Entry, gen: number, sentRev: number, err: Error | null, res?: SaveAck) => {
    if (!alive.current || entries.current.get(questionId) !== entry || entry.gen !== gen) return; // 낡은 응답
    entry.inFlightRev = null;
    if (!err && res?.ok) {
      backoffN.current = 0;
      entry.ackedRev = Math.max(entry.ackedRev, sentRev);
      if (entry.rev === sentRev) drafts.remove(opts.current.examCode, questionId);
      const at = new Date(res.savedAt);
      setSavedAt(Number.isNaN(at.getTime()) ? new Date() : at);
      refreshPending();
      if (isDirty(entry)) api.current.scheduleDebounce(); // 저장 중에 더 입력했다
      return;
    }
    const code = err || !res ? 'TIMEOUT' : res.ok ? 'INTERNAL' : res.code;
    switch (code) {
      case 'STALE_REV':
        entry.blocked = code; // 서버 값을 받아오기 전까지 같은 값을 계속 보내지 않는다
        opts.current.onStale?.();
        break;
      case 'NOT_ACTIVE':
      case 'UNAUTHORIZED':
        halted.current = true;
        opts.current.onNotActive?.();
        break;
      case 'TOO_LONG':
      case 'INVALID':
        entry.blocked = code;
        setError(questionId, code);
        break;
      default: {
        // BUSY·내부 오류·응답 시간 초과: 같은 rev·같은 내용으로 지수 백오프 재시도
        backoffN.current += 1;
        const delay = Math.min(1000 * 2 ** (backoffN.current - 1), BACKOFF_MAX_MS);
        clearTimeout(timers.current.retry);
        timers.current.retry = setTimeout(() => api.current.flush(), delay);
      }
    }
    refreshPending();
  };

  const send = (questionId: string, entry: Entry, force: boolean) => {
    const s = opts.current.socket;
    if (!s || !s.connected || halted.current || !(force || opts.current.enabled)) return;
    if (!isDirty(entry) || entry.blocked || entry.inFlightRev !== null || !entry.answer) return;
    const sentRev = entry.rev;
    const gen = entry.gen;
    entry.inFlightRev = sentRev;
    s.timeout(ACK_TIMEOUT_MS).emit(EV.ANSWER_SAVE, { questionId, ...entry.answer, rev: sentRev }, (err, res) => handleAck(questionId, entry, gen, sentRev, err, res));
  };

  api.current = {
    flush: (force = false) => {
      if (!alive.current || (composing.current && !force)) return;
      for (const [qid, entry] of entries.current) send(qid, entry, force);
    },
    scheduleDebounce: () => {
      clearTimeout(timers.current.debounce);
      timers.current.debounce = setTimeout(() => api.current.flush(), DEBOUNCE_MS);
    },
    scheduleForce: () => {
      if (timers.current.force) return;
      timers.current.force = setTimeout(() => {
        timers.current.force = undefined;
        api.current.flush();
        // 아직 미저장분이 있으면(조합 중·전송 중·오프라인) 5초 뒤 다시 시도한다.
        if ([...entries.current.values()].some((e) => isDirty(e) && !e.blocked)) api.current.scheduleForce();
      }, FORCE_MS);
    },
  };

  const getEntry = (questionId: string): Entry => {
    let e = entries.current.get(questionId);
    if (!e) {
      e = { answer: null, rev: 0, ackedRev: 0, inFlightRev: null, gen: 0, blocked: null };
      entries.current.set(questionId, e);
    }
    return e;
  };

  const applyChange = (questionId: string, answer: AnswerValue, rev: number) => {
    const e = getEntry(questionId);
    e.answer = answer;
    e.rev = rev;
    drafts.save(opts.current.examCode, questionId, 'text' in answer ? { rev, text: answer.text } : { rev, choiceId: answer.choiceId });
    if ('text' in answer && codePointLength(answer.text) > MAX_TEXT_LENGTH) {
      e.blocked = 'TOO_LONG'; // 서버가 최종 판정하지만 뻔히 거절될 값은 보내지 않는다
      setError(questionId, 'TOO_LONG');
    } else {
      e.blocked = null;
      setError(questionId, null);
    }
    refreshPending();
    api.current.scheduleDebounce();
    api.current.scheduleForce();
  };

  /** 사용자가 답안을 바꿨다. 내용이 달라졌을 때만 rev를 올린다. */
  const change = useCallback((questionId: string, answer: AnswerValue) => {
    const e = getEntry(questionId);
    if (sameAnswer(e.answer, answer) && !e.blocked) return;
    applyChange(questionId, answer, e.rev + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 서버가 이 문항에 대해 가진 rev를 알려 준다(불러온 직후). */
  const seed = useCallback((questionId: string, serverRev: number) => {
    const e = getEntry(questionId);
    e.rev = Math.max(e.rev, serverRev);
    e.ackedRev = Math.max(e.ackedRev, serverRev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 저장되지 않은 초안을 되살린다(새로고침 뒤). 초안의 rev를 그대로 써서 재전송은 같은 rev가 된다. */
  const restore = useCallback((questionId: string, answer: AnswerValue, rev: number) => {
    applyChange(questionId, answer, Math.max(rev, getEntry(questionId).ackedRev + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 서버에서 다시 읽은 값을 받아들인다(STALE_REV 뒤). 그 문항의 로컬 초안·오류는 버린다. */
  const adopt = useCallback((answers: { questionId: string; rev: number }[]) => {
    for (const a of answers) {
      entries.current.set(a.questionId, { answer: null, rev: a.rev, ackedRev: a.rev, inFlightRev: null, gen: 0, blocked: null });
      drafts.remove(opts.current.examCode, a.questionId);
      setError(a.questionId, null);
    }
    refreshPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compositionStart = useCallback(() => {
    composing.current = true;
  }, []);
  const compositionEnd = useCallback(() => {
    composing.current = false;
    api.current.scheduleDebounce();
  }, []);

  /** 모든 미저장 답안을 지금 보내고 결과를 기다린다(제출 직전). 모두 저장됐으면 true. */
  const flushAll = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        let finished = false;
        const settled = () => halted.current || ![...entries.current.values()].some((e) => e.inFlightRev !== null || (isDirty(e) && !e.blocked));
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(to);
          waiters.current.delete(check);
          resolve(![...entries.current.values()].some((e) => isDirty(e)));
        };
        const check = () => {
          if (settled()) finish();
        };
        const to = setTimeout(finish, FLUSH_WAIT_MS);
        waiters.current.add(check);
        api.current.flush(true);
        check();
      }),
    [],
  );

  // 연결·재연결: 끊긴 동안 쌓인 미저장분을 최신 값으로 한 번 다시 보낸다.
  useEffect(() => {
    alive.current = true;
    if (!socket) return;
    const onConnect = () => {
      backoffN.current = 0;
      for (const e of entries.current.values()) {
        e.gen += 1; // 이전 연결에서 보낸 요청의 응답은 무시한다
        e.inFlightRev = null;
      }
      api.current.flush();
    };
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect', onConnect);
    };
  }, [socket]);

  // 일시정지 등으로 꺼졌다가 켜지면 멈춤 상태를 풀고 다시 보낸다.
  useEffect(() => {
    if (!enabled) return;
    halted.current = false;
    api.current.flush();
  }, [enabled]);

  useEffect(() => {
    const t = timers.current;
    const w = waiters.current;
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(t.debounce);
      clearTimeout(t.force);
      clearTimeout(t.retry);
      for (const f of [...w]) f();
    };
  }, []);

  return useMemo(
    () => ({ savedAt, errors, pending, change, seed, restore, adopt, compositionStart, compositionEnd, flushAll }),
    [savedAt, errors, pending, change, seed, restore, adopt, compositionStart, compositionEnd, flushAll],
  );
}
