import { EV } from '@exam/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as studentSession from '../src/auth/studentSession';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';
import { stripIpPort } from '../src/realtime/socket';

type Server = Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];
const servers: Server[] = [];

// 이 환경은 새 DB 연결에 약 2초가 걸려(Windows+Docker) 기본 5초로는 모자란다.
vi.setConfig({ testTimeout: 30_000 });
// 첫 테스트가 DB 연결을 여는 데 걸리는 시간(약 2초 x 동시 연결)이 이벤트 대기 한도를 잡아먹지 않도록 풀을 미리 데운다(불안정 테스트의 원인).
beforeAll(async () => {
  await Promise.all(Array.from({ length: 8 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
}, 60_000);
beforeEach(resetDb);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets.splice(0)) s.close();
  for (const sv of servers.splice(0)) await sv.close();
});

async function start(options?: Parameters<typeof startTestServer>[0]): Promise<Server> {
  const sv = await startTestServer(options);
  servers.push(sv);
  return sv;
}

function open(sv: Server, opts: { auth?: Record<string, unknown>; cookie?: string; headers?: Record<string, string> } = {}): Socket {
  const extraHeaders: Record<string, string> = { ...opts.headers };
  if (opts.cookie) extraHeaders.Cookie = opts.cookie;
  const s = connect(sv.url, { auth: opts.auth, extraHeaders, transports: ['polling'], reconnection: false, forceNew: true });
  sockets.push(s);
  return s;
}

const once = <T = unknown>(s: Socket, ev: string, ms = 15_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });
const connected = (s: Socket) => once(s, 'connect');
const connectError = (s: Socket) => once<Error>(s, 'connect_error');
const quiet = (s: Socket, ev: string, ms = 500) =>
  new Promise<boolean>((resolve) => {
    let got = false;
    s.on(ev, () => (got = true));
    setTimeout(() => resolve(!got), ms);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expOf = (cookie: string) => (JSON.parse(Buffer.from(cookie.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number }).exp;

async function makeAttempt(examId: string, rosterIndex = 0, token = generateToken()) {
  const roster = await prisma.rosterEntry.findMany({ where: { examId }, orderBy: { studentNo: 'asc' } });
  const attempt = await prisma.attempt.create({
    data: { examId, rosterEntryId: roster[rosterIndex]!.id, sessionTokenHash: hashToken(token), questionOrder: [], choiceOrders: {} },
  });
  return { attempt, token };
}

const join = (s: Socket, examId: string) => s.timeout(3000).emitWithAck(EV.DASHBOARD_JOIN, { examId }) as Promise<{ ok: boolean; code?: string }>;

describe('교수자 소켓 재검증(M-1)', () => {
  it('(a) join 뒤 계정을 삭제하면 재확인 주기 안에 연결이 끊긴다', async () => {
    const sv = await start({ staffRecheckMs: 50 });
    const exam = await makeExam();
    const staff = await makeStaff();
    const s = open(sv, { cookie: staffCookie(staff.id) });
    await connected(s);
    expect((await join(s, exam.id)).ok).toBe(true);
    const closed = once(s, 'disconnect', 3000);
    await prisma.staff.delete({ where: { id: staff.id } });
    expect(await closed).toBe('io server disconnect');
  });

  it('계정이 살아 있으면 재확인이 여러 번 돌아도 연결이 유지된다', async () => {
    const sv = await start({ staffRecheckMs: 50 });
    const staff = await makeStaff();
    const s = open(sv, { cookie: staffCookie(staff.id) });
    await connected(s);
    expect(await quiet(s, 'disconnect', 400)).toBe(true);
    expect(s.connected).toBe(true);
  });

  it('(b) 토큰 exp 시각(서버 시계)이 되면 이미 붙은 소켓이 끊긴다', async () => {
    const staff = await makeStaff();
    const cookie = staffCookie(staff.id); // exp = 실제 시각 + 12시간
    let offsetMs = 0;
    const sv = await start({ now: () => Date.now() + offsetMs, staffRecheckMs: 3_600_000 });
    const s = open(sv, { cookie });
    await connected(s);
    expect(await quiet(s, 'disconnect', 300)).toBe(true);
    s.close();
    // 가짜 시계를 exp 400ms 전으로 옮기고 새로 연결한다: 그 연결은 곧 끊겨야 한다.
    offsetMs = expOf(cookie) * 1000 - Date.now() - 400;
    const s2 = open(sv, { cookie });
    await connected(s2);
    expect(await once(s2, 'disconnect', 3000)).toBe('io server disconnect');
  });

  it('(b2) 서버 시계가 exp를 넘었으면 타이머가 아니라 재확인 주기에도 끊긴다', async () => {
    const staff = await makeStaff();
    const cookie = staffCookie(staff.id);
    let offsetMs = 0;
    const sv = await start({ now: () => Date.now() + offsetMs, staffRecheckMs: 50 });
    const s = open(sv, { cookie });
    await connected(s);
    const closed = once(s, 'disconnect', 3000);
    offsetMs = expOf(cookie) * 1000 - Date.now() + 1000;
    expect(await closed).toBe('io server disconnect');
  });

  it('연결이 끊기면 재확인 타이머가 정리된다(이후 DB 조회 없음)', async () => {
    const sv = await start({ staffRecheckMs: 40 });
    const staff = await makeStaff();
    const s = open(sv, { cookie: staffCookie(staff.id) });
    await connected(s);
    await sleep(150);
    s.close();
    await sleep(400); // 서버가 disconnect를 처리하고 진행 중이던 조회가 끝날 시간
    const spy = vi.spyOn(prisma.staff, 'findUnique');
    await sleep(300);
    expect(spy).not.toHaveBeenCalled();
  });

  it('연결이 끊기면 만료 타이머와 재확인 타이머가 모두 해제된다(남지 않는다)', async () => {
    // 서버가 만든 타이머 핸들을 가로챈다: 재확인 주기(고유한 값 1234ms)의 interval, 만료(약 12시간)의 timeout.
    const intervals: Array<{ _destroyed?: boolean }> = [];
    const expiries: Array<{ _destroyed?: boolean }> = [];
    const realSetInterval = globalThis.setInterval;
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const h = realSetInterval(fn, ms);
      if (ms === 1234) intervals.push(h as unknown as { _destroyed?: boolean });
      return h;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const h = realSetTimeout(fn, ms);
      if (typeof ms === 'number' && ms > 11 * 3600_000) expiries.push(h as unknown as { _destroyed?: boolean });
      return h;
    }) as typeof setTimeout);
    const sv = await start({ staffRecheckMs: 1234 });
    const staff = await makeStaff();
    const s = open(sv, { cookie: staffCookie(staff.id) });
    await connected(s);
    expect(intervals).toHaveLength(1);
    expect(expiries).toHaveLength(1);
    expect(intervals[0]!._destroyed).toBeFalsy();
    expect(expiries[0]!._destroyed).toBeFalsy();
    s.close();
    await sleep(500);
    expect(intervals[0]!._destroyed).toBe(true);
    expect(expiries[0]!._destroyed).toBe(true);
  });
});

describe('인증 실패 속도 제한(M-2)', () => {
  it('(c) 같은 IP에서 잘못된 토큰 31번째 연결은 DB 호출 없이 거절된다', async () => {
    const sv = await start({ studentAuthFailMax: 30 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 30; i++) {
      const err = await connectError(open(sv, { auth: { sessionToken: `bad-${i}` } }));
      expect(err.message).toBe('UNAUTHORIZED');
    }
    expect(spy).toHaveBeenCalledTimes(30);
    const err = await connectError(open(sv, { auth: { sessionToken: 'bad-31' } }));
    expect(err.message).toBe('UNAUTHORIZED');
    expect(spy).toHaveBeenCalledTimes(30);
  }, 60_000);

  it('한도를 넘으면 유효한 토큰도 같은 고정 메시지로 거절되고 DB를 조회하지 않는다', async () => {
    const sv = await start({ studentAuthFailMax: 30 });
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    for (let i = 0; i < 30; i++) await connectError(open(sv, { auth: { sessionToken: `bad-${i}` } }));
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    const err = await connectError(open(sv, { auth: { sessionToken: token } }));
    expect(err.message).toBe('UNAUTHORIZED');
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);

  it('X-Forwarded-For를 바꿔도 한도를 우회할 수 없다', async () => {
    const sv = await start({ studentAuthFailMax: 30 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 30; i++) {
      await connectError(open(sv, { auth: { sessionToken: `bad-${i}` }, headers: { 'X-Forwarded-For': `10.0.0.${i}` } }));
    }
    await connectError(open(sv, { auth: { sessionToken: 'bad-x' }, headers: { 'X-Forwarded-For': '203.0.113.99' } }));
    expect(spy).toHaveBeenCalledTimes(30);
  }, 60_000);

  it('교수자 인증 실패(쿠키 없음)도 같은 한도에 포함된다', async () => {
    const sv = await start();
    const staff = await makeStaff();
    for (let i = 0; i < 30; i++) await connectError(open(sv));
    const spy = vi.spyOn(prisma.staff, 'findUnique');
    await connectError(open(sv, { cookie: staffCookie(staff.id) }));
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);

  it('성공한 연결은 세지 않는다: 같은 IP에서 성공 연결이 40번을 넘어도 막히지 않는다', async () => {
    const sv = await start({ studentAuthFailMax: 30 });
    const exam = await makeExam();
    // 명단 3명뿐이므로 응시 3개를 라운드마다 연결했다 닫는다(주체당 한도 3을 넘지 않는다).
    const attempts = await Promise.all([0, 1, 2].map((i) => makeAttempt(exam.id, i)));
    for (let round = 0; round < 14; round++) {
      const batch = attempts.map((a) => open(sv, { auth: { sessionToken: a.token } }));
      await Promise.all(batch.map(connected));
      for (const b of batch) b.close();
    }
    // 42번 성공한 뒤에도 잘못된 토큰은 DB까지 간다(= 한도에 걸리지 않았다)
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    await connectError(open(sv, { auth: { sessionToken: 'bad' } }));
    expect(spy).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe('프록시 뒤 클라이언트 IP(trustProxy)', () => {
  const fail = (sv: Server, xff: string, i: number) => connectError(open(sv, { auth: { sessionToken: `bad-${xff}-${i}` }, headers: { 'X-Forwarded-For': xff } }));

  it('(a) trustProxy 1: 오른쪽 값이 다른 클라이언트는 한도가 따로 계산된다', async () => {
    const sv = await start({ trustProxy: 1, studentAuthFailMax: 30 });
    for (let i = 0; i < 30; i++) await fail(sv, '198.51.100.1', i);
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    await fail(sv, '198.51.100.2', 0);
    expect(spy).toHaveBeenCalledTimes(1); // B는 DB까지 간다(거절되지 않음)
  }, 60_000);

  it('(b) 같은 오른쪽 값에서는 31번째가 DB 없이 거절된다', async () => {
    const sv = await start({ trustProxy: 1, studentAuthFailMax: 30 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 30; i++) await fail(sv, '198.51.100.1', i);
    await fail(sv, '198.51.100.1', 31);
    expect(spy).toHaveBeenCalledTimes(30);
  }, 60_000);

  it('(c) 왼쪽에 위조해 끼운 값은 무시된다', async () => {
    const sv = await start({ trustProxy: 1, studentAuthFailMax: 30 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 30; i++) await fail(sv, `10.9.9.${i}, 198.51.100.1`, i);
    await fail(sv, '203.0.113.7, 198.51.100.1', 31);
    expect(spy).toHaveBeenCalledTimes(30);
  }, 60_000);

  it('(d) trustProxy 미지정이면 X-Forwarded-For를 무시한다', async () => {
    const sv = await start({ studentAuthFailMax: 30 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 30; i++) await fail(sv, `198.51.100.${i}`, i);
    await fail(sv, '198.51.100.200', 31);
    expect(spy).toHaveBeenCalledTimes(30);
  }, 60_000);

  it('trustProxy 1인데 헤더가 없으면 소켓 주소로 대체한다', async () => {
    const sv = await start({ trustProxy: 1, studentAuthFailMax: 30 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 30; i++) await connectError(open(sv, { auth: { sessionToken: `bad-${i}` } }));
    await connectError(open(sv, { auth: { sessionToken: 'bad-31' } }));
    expect(spy).toHaveBeenCalledTimes(30);
  }, 60_000);
});

describe('주체당 동시 소켓 수(M-2)', () => {
  it('(d) 같은 학생 토큰으로 4번째 소켓을 열면 가장 오래된 첫 소켓이 끊긴다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const { attempt, token } = await makeAttempt(exam.id);
    const list: Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = open(sv, { auth: { sessionToken: token } });
      await connected(s);
      list.push(s);
    }
    expect(list.every((s) => s.connected)).toBe(true);
    const first = once(list[0]!, 'disconnect', 3000);
    const s4 = open(sv, { auth: { sessionToken: token } });
    await connected(s4);
    expect(await first).toBe('io server disconnect');
    expect(list[1]!.connected && list[2]!.connected && s4.connected).toBe(true);
    // 소켓이 끊겨도 응시 상태는 그대로다.
    const row = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row.state).toBe('WAITING');
  });

  it('학생 탭 3개까지는 아무도 끊기지 않는다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const list = [0, 1, 2].map(() => open(sv, { auth: { sessionToken: token } }));
    await Promise.all(list.map(connected));
    expect((await Promise.all(list.map((s) => quiet(s, 'disconnect', 400)))).every(Boolean)).toBe(true);
  });

  it('다른 학생의 소켓은 서로의 한도에 영향을 주지 않는다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const a = await makeAttempt(exam.id, 0);
    const b = await makeAttempt(exam.id, 1);
    const sb = open(sv, { auth: { sessionToken: b.token } });
    await connected(sb);
    for (let i = 0; i < 4; i++) await connected(open(sv, { auth: { sessionToken: a.token } }));
    expect(sb.connected).toBe(true);
  });

  it('같은 교수자 계정의 4번째 소켓이 첫 소켓을 끊는다', async () => {
    const sv = await start();
    const staff = await makeStaff();
    const cookie = staffCookie(staff.id);
    const list: Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = open(sv, { cookie });
      await connected(s);
      list.push(s);
    }
    const first = once(list[0]!, 'disconnect', 3000);
    const s4 = open(sv, { cookie });
    await connected(s4);
    expect(await first).toBe('io server disconnect');
    expect(s4.connected && list[1]!.connected && list[2]!.connected).toBe(true);
  });

  it('일부가 끊기면 슬롯이 반환되어 살아 있는 가장 오래된 소켓이 억울하게 끊기지 않는다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const [a, b, c] = [0, 1, 2].map(() => open(sv, { auth: { sessionToken: token } }));
    await connected(a!);
    await connected(b!);
    await connected(c!);
    b!.close();
    c!.close();
    await sleep(400); // 서버가 b, c의 disconnect를 처리할 시간
    const d = open(sv, { auth: { sessionToken: token } });
    await connected(d);
    expect(await quiet(a!, 'disconnect', 500)).toBe(true); // 살아 있는 소켓은 a, d 둘뿐이라 한도(3) 이내
    expect(a!.connected).toBe(true);
  });

  it('끊긴 뒤 다시 연결하면 슬롯이 반환되어 있다(기록 누수 없음)', async () => {
    const sv = await start();
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    for (let round = 0; round < 3; round++) {
      const list = [0, 1, 2].map(() => open(sv, { auth: { sessionToken: token } }));
      await Promise.all(list.map(connected));
      for (const s of list) s.close();
      await sleep(200);
    }
    const fresh = [0, 1, 2].map(() => open(sv, { auth: { sessionToken: token } }));
    await Promise.all(fresh.map(connected));
    expect((await Promise.all(fresh.map((s) => quiet(s, 'disconnect', 300)))).every(Boolean)).toBe(true);
  });
});

describe('기존 방어 회귀', () => {
  it('학생 토큰이 틀리면 교수자 쿠키가 있어도 거부되고 메시지는 고정이다', async () => {
    const sv = await start();
    const staff = await makeStaff();
    const err = await connectError(open(sv, { auth: { sessionToken: 'nope' }, cookie: staffCookie(staff.id) }));
    expect(err.message).toBe('UNAUTHORIZED');
  });

  it('JSONP 핸드셰이크와 다른 Origin은 여전히 거부된다', async () => {
    const sv = await start();
    const staff = await makeStaff();
    const res = await fetch(`${sv.url}/socket.io/?EIO=4&transport=polling&j=0`, { headers: { Cookie: staffCookie(staff.id) } });
    expect(res.status).toBe(403);
    const err = await connectError(open(sv, { cookie: staffCookie(staff.id), headers: { Origin: 'https://evil.example' } }));
    expect(err.message).toMatch(/./);
  });

  it('answer:save는 학생 소켓에서 계속 ack로 답한다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    const s = open(sv, { auth: { sessionToken: token } });
    await connected(s);
    const res = (await s.timeout(3000).emitWithAck(EV.ANSWER_SAVE, {})) as { ok: boolean };
    expect(typeof res.ok).toBe('boolean');
  });
});

/** 원시 웹소켓(Engine.IO v4)으로 연결해 Socket.IO CONNECT 패킷(`40{auth}`)을 직접 보낸다. */
const rawSockets: WebSocket[] = [];
afterEach(() => {
  for (const w of rawSockets.splice(0)) w.close();
});
async function rawConnect(sv: Server): Promise<{ ws: WebSocket; frames: string[] }> {
  const ws = new WebSocket(`${sv.url.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`);
  rawSockets.push(ws);
  const frames: string[] = [];
  ws.addEventListener('message', (e) => frames.push(String(e.data)));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return { ws, frames };
}
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout in until');
    await sleep(20);
  }
}

describe('인증 버스트 상한(경쟁 조건)', () => {
  it('연결 하나에서 CONNECT를 100번 한꺼번에 보내도 DB 조회는 한도 이하다', async () => {
    const sv = await start({ studentAuthFailMax: 10 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    const { ws, frames } = await rawConnect(sv);
    for (let i = 0; i < 100; i++) ws.send(`40{"sessionToken":"bad${i}"}`);
    await until(() => frames.filter((f) => f.startsWith('44')).length >= 100);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
    expect(frames.filter((f) => f.startsWith('44')).every((f) => f.includes('UNAUTHORIZED'))).toBe(true);
  });

  it('같은 IP에서 서로 다른 연결 50개가 동시에 잘못된 토큰으로 붙어도 DB 조회는 한도 이하다', async () => {
    const sv = await start({ studentAuthFailMax: 10 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    const errs = await Promise.all(Array.from({ length: 50 }, (_, i) => connectError(open(sv, { auth: { sessionToken: `bad-${i}` } }))));
    expect(errs.every((e) => e.message === 'UNAUTHORIZED')).toBe(true);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('정상 학생 20명이 동시에 올바른 토큰으로 입장해도 거절되지 않고, 진행 중 카운트는 반환된다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const extra = Array.from({ length: 20 }, (_, i) => ({ examId: exam.id, studentNo: `2026${String(100 + i)}`, name: `추가${i}` }));
    await prisma.rosterEntry.createMany({ data: extra });
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => makeAttempt(exam.id, i)));
    const list = attempts.map((a) => open(sv, { auth: { sessionToken: a.token } }));
    await Promise.all(list.map(connected));
    expect(list.every((s) => s.connected)).toBe(true);
    // 진행 중 카운트가 반환되었다면 그 뒤 잘못된 토큰도 DB까지 간다(= 거절 판단에 남은 카운트가 없다)
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    await connectError(open(sv, { auth: { sessionToken: 'bad' } }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('학생 토큰 실패와 교수자 쿠키 실패 한도 분리', () => {
  it('교수자 쿠키 실패 30건을 채워도 정상 학생 토큰 연결은 성공한다', async () => {
    const sv = await start();
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    for (let i = 0; i < 30; i++) await connectError(open(sv));
    await connectError(open(sv)); // 31번째 교수자 실패는 거절 상태
    const s = open(sv, { auth: { sessionToken: token } });
    await connected(s);
    expect(s.connected).toBe(true);
  });

  it('학생 토큰 실패 한도를 채워도 정상 교수자 쿠키 연결은 성공한다', async () => {
    const sv = await start({ studentAuthFailMax: 5 });
    const staff = await makeStaff();
    for (let i = 0; i < 5; i++) await connectError(open(sv, { auth: { sessionToken: `bad-${i}` } }));
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    await connectError(open(sv, { auth: { sessionToken: 'bad-6' } }));
    expect(spy).not.toHaveBeenCalled();
    const s = open(sv, { cookie: staffCookie(staff.id) });
    await connected(s);
    expect(s.connected).toBe(true);
  });

  it('학생 토큰 실패 기본 한도는 200회: 201번째는 DB 호출 없이 거절된다', async () => {
    const sv = await start();
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 20 }, (_, i) => connectError(open(sv, { auth: { sessionToken: `bad-${batch}-${i}` } }))));
    }
    expect(spy).toHaveBeenCalledTimes(200);
    const err = await connectError(open(sv, { auth: { sessionToken: 'bad-201' } }));
    expect(err.message).toBe('UNAUTHORIZED');
    expect(spy).toHaveBeenCalledTimes(200);
  }, 120_000);
});

describe('stripIpPort', () => {
  it.each([
    ['1.2.3.4:5678', '1.2.3.4'],
    ['1.2.3.4', '1.2.3.4'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
    ['garbage:xyz', 'garbage:xyz'],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(stripIpPort(input)).toBe(expected);
  });

  it('XFF에 포트가 붙어 있어도 같은 클라이언트는 같은 키로 집계된다', async () => {
    const sv = await start({ trustProxy: 1, studentAuthFailMax: 5 });
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    for (let i = 0; i < 5; i++) {
      await connectError(open(sv, { auth: { sessionToken: `bad-${i}` }, headers: { 'X-Forwarded-For': `198.51.100.1:${40000 + i}` } }));
    }
    await connectError(open(sv, { auth: { sessionToken: 'bad-x' }, headers: { 'X-Forwarded-For': '198.51.100.1:55555' } }));
    expect(spy).toHaveBeenCalledTimes(5);
  });
});
