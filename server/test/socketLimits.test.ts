import { EV } from '@exam/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as studentSession from '../src/auth/studentSession';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

type Server = Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];
const servers: Server[] = [];

// 이 환경은 새 DB 연결에 약 2초가 걸려(Windows+Docker) 기본 5초로는 모자란다.
vi.setConfig({ testTimeout: 30_000 });
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

const once = <T = unknown>(s: Socket, ev: string, ms = 6000) =>
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
});

describe('인증 실패 속도 제한(M-2)', () => {
  it('(c) 같은 IP에서 잘못된 토큰 31번째 연결은 DB 호출 없이 거절된다', async () => {
    const sv = await start();
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
    const sv = await start();
    const exam = await makeExam();
    const { token } = await makeAttempt(exam.id);
    for (let i = 0; i < 30; i++) await connectError(open(sv, { auth: { sessionToken: `bad-${i}` } }));
    const spy = vi.spyOn(studentSession, 'findAttemptByToken');
    const err = await connectError(open(sv, { auth: { sessionToken: token } }));
    expect(err.message).toBe('UNAUTHORIZED');
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);

  it('X-Forwarded-For를 바꿔도 한도를 우회할 수 없다', async () => {
    const sv = await start();
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
    const sv = await start();
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
