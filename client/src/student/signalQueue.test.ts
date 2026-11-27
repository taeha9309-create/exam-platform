import { beforeEach, describe, expect, it } from 'vitest';
import { createSignalQueue, MAX_QUEUE, type QueueMsg } from './signalQueue';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const msg = (seq: number, type: QueueMsg['type'] = 'PASTE'): QueueMsg => ({ seq, type, clientAt: 1000 + seq, meta: {} });

let storage: Storage;
beforeEach(() => {
  storage = memStorage();
});

describe('createSignalQueue', () => {
  it('seq를 1씩 올려 발급하고 새 인스턴스(새로고침)에서도 이어진다', () => {
    const q1 = createSignalQueue(storage, 'exam:EX');
    expect([q1.nextSeq(), q1.nextSeq(), q1.nextSeq()]).toEqual([1, 2, 3]);
    const q2 = createSignalQueue(storage, 'exam:EX');
    expect(q2.nextSeq()).toBe(4);
  });

  it('시험 코드가 다르면 seq·큐가 섞이지 않는다', () => {
    const a = createSignalQueue(storage, 'exam:A');
    a.enqueue(msg(a.nextSeq()));
    const b = createSignalQueue(storage, 'exam:B');
    expect(b.nextSeq()).toBe(1);
    expect(b.size()).toBe(0);
  });

  it('미전송 신호가 새 인스턴스에도 남아 있다', () => {
    const q1 = createSignalQueue(storage, 'exam:EX');
    q1.enqueue(msg(q1.nextSeq(), 'LEAVE_START'));
    q1.enqueue(msg(q1.nextSeq(), 'LEAVE'));
    const q2 = createSignalQueue(storage, 'exam:EX');
    expect(q2.size()).toBe(2);
    expect(q2.peek().map((m) => m.seq)).toEqual([1, 2]);
  });

  it('drain은 seq 순서대로 한 건씩, 앞 건의 ack가 와야 다음을 보낸다', async () => {
    const q = createSignalQueue(storage, 'exam:EX');
    for (let i = 0; i < 3; i++) q.enqueue(msg(q.nextSeq()));
    const calls: number[] = [];
    const resolvers: ((r: { ok: boolean }) => void)[] = [];
    const p = q.drain(
      (m) =>
        new Promise((res) => {
          calls.push(m.seq);
          resolvers.push(res);
        }),
    );
    expect(calls).toEqual([1]);
    expect(q.size()).toBe(3); // ack 전에는 지우지 않는다
    resolvers[0]!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(q.size()).toBe(2);
    expect(calls).toEqual([1, 2]);
    resolvers[1]!({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    resolvers[2]!({ ok: true });
    await p;
    expect(calls).toEqual([1, 2, 3]);
    expect(q.size()).toBe(0);
  });

  it('실패하면 멈추고 순서를 유지한 채 남기며, 다음 drain은 같은 건부터 다시 보낸다', async () => {
    const q = createSignalQueue(storage, 'exam:EX');
    for (let i = 0; i < 3; i++) q.enqueue(msg(q.nextSeq()));
    const seen: number[] = [];
    await q.drain(async (m) => {
      seen.push(m.seq);
      return { ok: m.seq === 1 };
    });
    expect(seen).toEqual([1, 2]);
    expect(q.peek().map((m) => m.seq)).toEqual([2, 3]);
    const seen2: number[] = [];
    await q.drain(async (m) => {
      seen2.push(m.seq);
      return { ok: true };
    });
    expect(seen2).toEqual([2, 3]);
    expect(q.size()).toBe(0);
  });

  it('send가 던져도 실패로 처리하고 남긴다', async () => {
    const q = createSignalQueue(storage, 'exam:EX');
    q.enqueue(msg(q.nextSeq()));
    await q.drain(async () => {
      throw new Error('boom');
    });
    expect(q.size()).toBe(1);
  });

  it('진행 중 drain을 또 부르면 같은 건을 두 번 보내지 않는다', async () => {
    const q = createSignalQueue(storage, 'exam:EX');
    q.enqueue(msg(q.nextSeq()));
    let n = 0;
    const send = async () => {
      n++;
      return { ok: true };
    };
    await Promise.all([q.drain(send), q.drain(send)]);
    expect(n).toBe(1);
  });

  it('서버가 INVALID로 거절한 건은 버려 큐가 막히지 않는다', async () => {
    const q = createSignalQueue(storage, 'exam:EX');
    q.enqueue(msg(q.nextSeq()));
    q.enqueue(msg(q.nextSeq()));
    await q.drain(async (m) => (m.seq === 1 ? { ok: false, code: 'INVALID' } : { ok: true }));
    expect(q.size()).toBe(0);
  });

  it('상한을 넘으면 가장 오래된 하트비트부터 버리고 신호는 버리지 않는다', () => {
    const q = createSignalQueue(storage, 'exam:EX');
    q.enqueue(msg(q.nextSeq(), 'PASTE')); // seq 1: 신호
    for (let i = 0; i < MAX_QUEUE + 5; i++) q.enqueue(msg(q.nextSeq(), 'HB'));
    expect(q.size()).toBe(MAX_QUEUE);
    const seqs = q.peek().map((m) => m.seq);
    expect(seqs[0]).toBe(1); // 신호 유지
    expect(seqs[1]).toBe(8); // 오래된 하트비트(2~7)가 버려짐
  });

  it('신호만 상한을 넘어도 버리지 않는다', () => {
    const q = createSignalQueue(storage, 'exam:EX');
    for (let i = 0; i < MAX_QUEUE + 3; i++) q.enqueue(msg(q.nextSeq(), 'PASTE'));
    expect(q.size()).toBe(MAX_QUEUE + 3);
  });

  it('저장소가 없거나 항상 던져도 메모리로 동작한다', async () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    for (const st of [null, broken]) {
      const q = createSignalQueue(st, 'exam:EX');
      expect(q.nextSeq()).toBe(1);
      q.enqueue(msg(2));
      expect(q.size()).toBe(1);
      await q.drain(async () => ({ ok: true }));
      expect(q.size()).toBe(0);
    }
  });

  it('깨진 저장값은 무시한다', () => {
    storage.setItem('exam:EX:signalQueue', '{not json');
    storage.setItem('exam:EX:seq', 'abc');
    const q = createSignalQueue(storage, 'exam:EX');
    expect(q.size()).toBe(0);
    expect(q.nextSeq()).toBe(1);
  });
});
