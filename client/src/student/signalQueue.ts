// 학생 신호 큐(SPEC 5.2). 하트비트·신호가 하나의 seq 카운터를 공유하고, 끊긴 동안 쌓았다가 재연결 시 seq 순서대로 한 건씩 보낸다.
// seq와 미전송 큐는 localStorage에 보관해 새로고침 뒤에도 이어진다. 저장소 접근은 모두 try/catch로 감싸고, 실패하면 메모리로만 동작한다.

import type { ClientSignalType } from '@exam/shared';

export type { ClientSignalType };
/** 'HB'는 하트비트(hb 이벤트). 같은 seq 카운터와 큐를 공유한다. */
export type QueueMsgType = ClientSignalType | 'HB';

export interface QueueMsg {
  seq: number;
  type: QueueMsgType;
  clientAt: number;
  durationMs?: number;
  questionId?: string;
  meta: object;
}

export interface SendResult {
  ok: boolean;
  code?: string;
}

/** 큐 크기 상한. 넘으면 가장 오래된 하트비트부터 버린다(신호는 버리지 않는다). */
export const MAX_QUEUE = 200;

const TYPES: readonly string[] = ['LEAVE', 'LEAVE_START', 'FULLSCREEN_EXIT', 'PASTE', 'DROP', 'SIDEBAR_SUSPECT', 'HB'];

function isMsg(v: unknown): v is QueueMsg {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.seq === 'number' &&
    Number.isSafeInteger(m.seq) &&
    typeof m.type === 'string' &&
    TYPES.includes(m.type) &&
    typeof m.clientAt === 'number' &&
    typeof m.meta === 'object' &&
    m.meta !== null
  );
}

/** key는 `exam:{examCode}` 같은 접두어. 실제 키는 `${key}:seq`, `${key}:signalQueue`. */
export function createSignalQueue(storage: Storage | null, key: string) {
  const seqKey = `${key}:seq`;
  const queueKey = `${key}:signalQueue`;

  let seq = 0;
  let items: QueueMsg[] = [];
  try {
    const rawSeq = storage?.getItem(seqKey);
    const n = rawSeq == null ? 0 : Number(rawSeq);
    if (Number.isSafeInteger(n) && n > 0) seq = n;
    const rawQ = storage?.getItem(queueKey);
    if (rawQ) {
      const parsed: unknown = JSON.parse(rawQ);
      if (Array.isArray(parsed)) items = parsed.filter(isMsg).sort((a, b) => a.seq - b.seq);
    }
  } catch {
    // 저장소를 못 읽으면 처음부터(메모리만)
  }
  // 저장된 큐에 더 큰 seq가 있으면 그 뒤로 잇는다(seq 저장이 실패했던 경우 대비).
  for (const m of items) seq = Math.max(seq, m.seq);

  const persistQueue = () => {
    try {
      storage?.setItem(queueKey, JSON.stringify(items));
    } catch {
      // 용량 초과 등: 메모리 큐로 계속
    }
  };

  let running = false;
  let draining: Promise<void> | null = null;

  return {
    /** 다음 seq를 발급하고 저장한다. 하트비트·신호가 같은 카운터를 쓴다. */
    nextSeq(): number {
      seq += 1;
      try {
        storage?.setItem(seqKey, String(seq));
      } catch {
        // 무시
      }
      return seq;
    },
    enqueue(msg: QueueMsg): void {
      items.push(msg);
      while (items.length > MAX_QUEUE) {
        const i = items.findIndex((m) => m.type === 'HB');
        if (i < 0) break; // 신호만 남았으면 버리지 않는다
        items.splice(i, 1);
      }
      persistQueue();
    },
    /**
     * 맨 앞부터 한 건씩 보낸다. ack가 ok여야 제거하고, 실패하면 거기서 멈춘다(순서 유지, 다음 drain에서 같은 건부터 재시도).
     * 이미 진행 중이면 그 진행을 기다린다(같은 건을 두 번 보내지 않는다).
     * 서버가 INVALID로 거절한 건은 영원히 재시도해도 소용없으므로 버린다.
     */
    drain(send: (msg: QueueMsg) => Promise<SendResult>): Promise<void> {
      if (running && draining) return draining;
      // running은 루프가 끝나는 바로 그 시점(마지막 확인과 같은 동기 구간)에 내려가야, 그 직후 들어온 신호가 놓치지 않고 새 drain을 시작한다.
      running = true;
      draining = (async () => {
        try {
          while (items.length > 0) {
            const head = items[0]!;
            let res: SendResult;
            try {
              res = await send(head);
            } catch {
              res = { ok: false };
            }
            // INVALID·NOT_ACTIVE는 영구 거절(재시도해도 같은 결과)이라 버린다. 그 밖의 실패(BUSY·RATE·시간 초과 등)는 남겨 재시도한다.
            if (!res.ok && res.code !== 'INVALID' && res.code !== 'NOT_ACTIVE') return;
            // 보내는 중에 상한 처리로 head가 빠졌을 수 있으니 seq로 찾아 지운다.
            items = items.filter((m) => m.seq !== head.seq);
            persistQueue();
          }
        } finally {
          running = false;
        }
      })();
      return draining;
    },
    size(): number {
      return items.length;
    },
    /** 테스트·진단용 사본 */
    peek(): QueueMsg[] {
      return items.slice();
    },
  };
}

export type SignalQueue = ReturnType<typeof createSignalQueue>;
