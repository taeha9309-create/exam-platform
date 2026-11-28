/**
 * 부하·실시간성 측정(SPEC 9장 성공 기준 2·3, 계획 3 Task 1).
 *
 * 사용(로컬 서버만): DATABASE_URL=postgresql://…/exam_load npm run load-test -- --base http://localhost:3200 [--students 20] [--run-sec 90] [--out 파일.json]
 *
 * 하는 일
 *  1. 전용 DB(exam_load)에 교수자·시험(OPEN)·명단·문항을 시드한다(demo-reset 방식). 데이터베이스 이름이 exam_load가 아니면 시작하지 않는다.
 *  2. 교수자 로그인 → 교수자 소켓 2개가 dashboard:join 후 signal:new 수신 대기.
 *  3. 가상 학생 N명: 입장(confirm)→동의·환경 점검→소켓 연결→대기→(교수자 시작)→ hb·answer:save·signal 반복 → 제출.
 *     일부 학생은 도중에 소켓을 끊었다 다시 붙고(끊긴 동안 입력한 답안은 재연결 뒤 전송), 제출 직전에 서버에 저장된 답안을 확인한다.
 *  4. 실시간성: 학생이 signal을 "보낸 시각"(performance.now())과 교수자 소켓이 signal:new를 "받은 시각"의 차이를 소켓별로 잰다.
 *  5. 합격 기준(load-test-lib.ts evaluate)을 판정해 JSON 요약을 출력·저장하고 종료 코드 0/1을 돌려준다.
 *
 * 입장 시도 제한(IP당 1분 실패 10회)은 "실패만" 세므로 정상 입장 20명은 걸리지 않는다. 제한 값은 바꾸지 않는다.
 * 만든 시험 데이터는 끝에 지운다.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import { hashPassword } from '../server/src/auth/staffAuth';
import { prisma } from '../server/src/db';
import { generateExamCode } from '../server/src/domain/codes';
import { assertLoadDatabase, countMissed, describeEnvironment, evaluate, once, parseLoadArgs, summarizeLatencies, type LoadArgs } from './load-test-lib';

const PASSCODE = '246810';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Question {
  id: string;
  type: 'MCQ' | 'ESSAY';
  choices?: { id: string; text: string }[];
}
interface Expected {
  rev: number;
  choiceId?: string;
  text?: string;
}
type Ack = { ok: boolean; code?: string; savedAt?: string };

// ───────────────────────── 집계 ─────────────────────────
const counters = { http5xx: 0, httpOther4xx: 0, ackInternal: 0, ackBusy: 0, answerAcks: 0, answerAckFail: 0, signalAckFail: 0, reconnects: 0, hbSent: 0 };
const sentAt = new Map<string, number>(); // 신호 키 → 보낸 시각(performance.now)
const sentKeys: string[] = []; // ack ok를 받은 신호 키
const staffReceived: Set<string>[] = [new Set(), new Set()];
const staffServerSignals = [0, 0];
const latencies: number[] = [];
const openSockets = new Set<Socket>();
/** 중단 신호: 시작 실패·예외 때 학생 루프가 더 돌지 않고 끝나게 한다 */
let aborted = false;

// ───────────────────────── HTTP ─────────────────────────
let BASE = '';
async function http(method: string, path: string, opts: { body?: unknown; token?: string; cookie?: string } = {}): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(30_000) });
  if (res.status >= 500) counters.http5xx += 1;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

function connect(auth: object | undefined, cookie?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false, auth: auth ?? {}, extraHeaders: cookie ? { cookie } : undefined, forceNew: true });
    openSockets.add(s); // 예외·중단 때 main의 finally가 열린 소켓을 모두 닫는다
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => {
      s.close();
      reject(new Error(`소켓 연결 실패: ${e.message}`));
    });
  });
}

function emitAck(s: Socket, event: string, payload: unknown, timeoutMs = 10_000): Promise<Ack> {
  return s.timeout(timeoutMs).emitWithAck(event, payload).then(
    (r: Ack) => r,
    () => ({ ok: false, code: 'TIMEOUT' }),
  );
}

// ───────────────────────── 시드 ─────────────────────────
async function seed(n: number, onStaffCreated: (staffId: string) => void) {
  const staffPassword = randomBytes(12).toString('base64url');
  const email = `load-${randomBytes(4).toString('hex')}@exam.local`;
  const passwordHash = await hashPassword(staffPassword);
  const mcq = (prompt: string, wrong: string[]) => ({ type: 'MCQ' as const, prompt, points: 10, choices: ['정답', ...wrong].map((text, i) => ({ id: `c${i + 1}`, text })), correctChoiceId: 'c1' });
  const questions = [
    mcq('객관식 1', ['오답1', '오답2', '오답3']),
    mcq('객관식 2', ['오답1', '오답2', '오답3']),
    mcq('객관식 3', ['오답1', '오답2', '오답3']),
    mcq('객관식 4', ['오답1', '오답2', '오답3']),
    mcq('객관식 5', ['오답1', '오답2', '오답3']),
    { type: 'ESSAY' as const, prompt: '서술형 1', points: 25 },
    { type: 'ESSAY' as const, prompt: '서술형 2', points: 25 },
  ];
  const roster = Array.from({ length: n }, (_, i) => ({ studentNo: `202691${String(i + 1).padStart(3, '0')}`, name: `부하${i + 1}` }));
  const staff = await prisma.staff.create({ data: { email, name: '부하 시험 교수자', passwordHash } });
  onStaffCreated(staff.id); // 이후 시험 생성이 실패해도 main의 finally가 교수자를 지울 수 있게 먼저 알린다
  const exam = await prisma.exam.create({
    data: {
      ownerId: staff.id,
      examCode: generateExamCode(),
      title: '[부하 측정] 임시 시험',
      durationMin: 30,
      status: 'OPEN',
      passcode: PASSCODE,
      questions: { create: questions.map((q, position) => ({ position, type: q.type, prompt: q.prompt, points: q.points, choices: 'choices' in q ? q.choices : undefined, correctChoiceId: 'correctChoiceId' in q ? q.correctChoiceId : null })) },
      roster: { create: roster },
    },
    select: { id: true, examCode: true },
  });
  return { staffId: staff.id, email, staffPassword, examId: exam.id, examCode: exam.examCode, roster };
}

async function cleanup(staffId: string | undefined): Promise<void> {
  if (!staffId) return;
  // 시험을 지우면 문항·명단·응시·답안·신호·조치가 Cascade로 지워진다(demo-reset과 같은 방식). 이 실행이 만든 교수자 한 명의 시험만 지운다.
  await prisma.exam.deleteMany({ where: { ownerId: staffId } });
  await prisma.staff.delete({ where: { id: staffId } });
}

// ───────────────────────── 가상 학생 ─────────────────────────
interface Result {
  studentNo: string;
  submitted: boolean;
  answersPreserved: boolean;
  signalsSent: number;
  answersSent: number;
  reconnected: boolean;
  note?: string;
}

const SIGNAL_PLAN = (k: number): { type: string; durationMs?: number; meta?: object } => {
  // 위반으로 세는 신호(FULLSCREEN_EXIT, 3초 이상 LEAVE)는 학생당 2건뿐이라 5회 자동 잠금에 닿지 않는다.
  switch (k) {
    case 2:
      return { type: 'FULLSCREEN_EXIT' };
    case 4:
      return { type: 'LEAVE', durationMs: 4000 };
  }
  switch (k % 5) {
    case 0:
      return { type: 'LEAVE_START' };
    case 1:
      return { type: 'LEAVE', durationMs: 1500 };
    case 2:
      return { type: 'SIDEBAR_SUSPECT', meta: { deltaInner: 120 } };
    case 3:
      return { type: 'LEAVE_START' };
    default:
      return { type: 'LEAVE', durationMs: 2500 };
  }
};

/** 가상 학생 한 명. 어떤 예외가 나도 던지지 않고 실패 결과를 돌려주며, 입장 집계(gate)는 정확히 한 번 호출한다(안 부르면 교수자 시작이 영원히 대기한다). */
async function runStudent(idx: number, e: { examCode: string; studentNo: string }, args: LoadArgs, gate: { enteredCount: () => void; start: Promise<boolean> }): Promise<Result> {
  const r: Result = { studentNo: e.studentNo, submitted: false, answersPreserved: false, signalsSent: 0, answersSent: 0, reconnected: false };
  const markEntered = once(gate.enteredCount);
  try {
    await runStudentSteps(idx, e, args, { enteredCount: markEntered, start: gate.start }, r);
  } catch (err) {
    r.submitted = false;
    r.note = `예외: ${err instanceof Error ? err.message : 'unknown'}`;
  } finally {
    markEntered();
  }
  return r;
}

async function runStudentSteps(idx: number, e: { examCode: string; studentNo: string }, args: LoadArgs, gate: { enteredCount: () => void; start: Promise<boolean> }, r: Result): Promise<void> {
  const entry = await http('POST', '/api/student/confirm', { body: { examCode: e.examCode, studentNo: e.studentNo, passcode: PASSCODE } });
  if (entry.status !== 200 || !entry.json?.sessionToken) {
    r.note = `입장 실패 HTTP ${entry.status} ${entry.json?.error?.code ?? ''}`;
    gate.enteredCount();
    return;
  }
  const token: string = entry.json.sessionToken;
  const attemptId: string = entry.json.attempt.id;
  const c1 = await http('POST', '/api/student/consent', { token, body: { agree: true } });
  const c2 = await http('POST', '/api/student/env', { token, body: { browser: 'chrome', isExtended: false, fullscreen: true } });
  if (c1.status !== 200 || c2.status !== 200) {
    r.note = `동의·환경 점검 실패 ${c1.status}/${c2.status}`;
    gate.enteredCount();
    return;
  }

  let sock = await connect({ sessionToken: token });
  let active = false;
  const watch = (s: Socket): void => {
    s.on('attempt:state', (p: { state?: string }) => {
      if (p?.state === 'ACTIVE') active = true;
    });
    s.on('exam:started', () => {
      active = true;
    });
    s.on('session:revoked', () => {
      r.note = '세션 폐기 수신';
    });
  };
  watch(sock);
  gate.enteredCount();
  if (!(await gate.start)) {
    r.note = '시험이 시작되지 않아 중단';
    return;
  }
  // 시작 알림(exam:started·attempt:state)을 놓쳤을 때를 대비해 최대 10초 기다린 뒤 HTTP로 확인한다.
  for (let i = 0; i < 100 && !active; i++) await sleep(100);
  const ex = await http('GET', '/api/student/exam', { token });
  if (ex.status !== 200) {
    r.note = `문항 조회 실패 HTTP ${ex.status}`;
    sock.close();
    return;
  }
  const questions: Question[] = ex.json.questions;

  const expected = new Map<string, Expected>();
  let seq = 0;
  let answerCount = 0;
  let signalCount = 0;
  let lastClientAt = 0;
  const startMs = performance.now();
  const endMs = startMs + args.runSec * 1000;
  // 학생마다 시작 시점을 어긋나게 해서(지터) 20명이 같은 순간에 몰리지 않게 한다. 실제 교실의 입력 시점도 제각각이다.
  let nextHb = startMs + (idx % 5) * 1000;
  let nextAnswer = startMs + ((idx * 977) % (args.answerEverySec * 1000));
  let nextSignal = startMs + ((idx * 1231) % (args.signalEverySec * 1000));
  const outage = idx < 4 ? { at: startMs + ((idx + 1) / 5) * args.runSec * 1000, downMs: [3000, 4000, 5000, 12000][idx]!, done: false } : null;

  const makeAnswer = (): { questionId: string; payload: any; value: Expected } => {
    const q = questions[answerCount % questions.length]!;
    const rev = (expected.get(q.id)?.rev ?? 0) + 1;
    answerCount += 1;
    if (q.type === 'MCQ') {
      const choiceId = q.choices![answerCount % q.choices!.length]!.id;
      return { questionId: q.id, payload: { questionId: q.id, choiceId, rev }, value: { rev, choiceId } };
    }
    const text = `학생${idx + 1}의 서술형 답안 ${rev}번째 수정. ${'가나다라마바사 '.repeat(20)}`;
    return { questionId: q.id, payload: { questionId: q.id, text, rev }, value: { rev, text } };
  };
  const sendAnswer = async (a: ReturnType<typeof makeAnswer>): Promise<boolean> => {
    const ack = await emitAck(sock, 'answer:save', a.payload);
    counters.answerAcks += 1;
    if (ack.ok) {
      expected.set(a.questionId, a.value);
      r.answersSent += 1;
      return true;
    }
    counters.answerAckFail += 1;
    if (ack.code === 'INTERNAL') counters.ackInternal += 1;
    if (ack.code === 'BUSY') counters.ackBusy += 1;
    r.note = `answer:save 실패 ${ack.code}`;
    return false;
  };

  while (performance.now() < endMs && !aborted) {
    const t = performance.now();
    if (outage && !outage.done && t >= outage.at) {
      outage.done = true;
      r.reconnected = true;
      counters.reconnects += 1;
      sock.disconnect();
      // 끊긴 동안 학생이 답을 계속 입력한다고 가정: 미전송 답안을 쌓아 두었다가 재연결 뒤 보낸다(클라이언트 큐 동작과 같다).
      const buffered = [makeAnswer(), makeAnswer()];
      await sleep(outage.downMs);
      sock = await connect({ sessionToken: token });
      watch(sock);
      for (const a of buffered) await sendAnswer(a);
      continue;
    }
    if (t >= nextHb) {
      seq += 1;
      sock.emit('hb', { seq });
      counters.hbSent += 1;
      nextHb += 5000;
    }
    if (t >= nextAnswer) {
      await sendAnswer(makeAnswer());
      nextAnswer += args.answerEverySec * 1000;
    }
    if (t >= nextSignal) {
      seq += 1;
      const plan = SIGNAL_PLAN(signalCount);
      signalCount += 1;
      const clientAt = Math.max(Date.now(), lastClientAt + 1);
      lastClientAt = clientAt;
      const key = `${attemptId}:${clientAt}`;
      const payload = { seq, type: plan.type, clientAt, ...(plan.durationMs !== undefined ? { durationMs: plan.durationMs } : {}), ...(plan.meta ? { meta: plan.meta } : {}) };
      sentAt.set(key, performance.now());
      const ack = await emitAck(sock, 'signal', payload);
      if (ack.ok) {
        sentKeys.push(key);
        r.signalsSent += 1;
      } else {
        counters.signalAckFail += 1;
        if (ack.code === 'INTERNAL') counters.ackInternal += 1;
        if (ack.code === 'BUSY') counters.ackBusy += 1;
        r.note = `signal 실패 ${ack.code}`;
      }
      nextSignal += args.signalEverySec * 1000;
    }
    await sleep(100);
  }

  // 제출 직전: 서버에 저장된 답안이 마지막으로 ack를 받은 답안과 같은지 확인한다.
  const check = await http('GET', '/api/student/exam', { token });
  if (check.status === 200) {
    const saved = new Map<string, { rev: number; choiceId?: string; text?: string }>((check.json.answers as any[]).map((a) => [a.questionId, a]));
    // 보낸 답안이 하나도 없으면 every가 빈 비교로 참이 되므로 전제로 answersSent > 0을 요구한다.
    r.answersPreserved = r.answersSent > 0 && [...expected].every(([qid, v]) => {
      const s = saved.get(qid);
      return !!s && s.rev === v.rev && s.choiceId === v.choiceId && s.text === v.text;
    });
  } else {
    r.note = `제출 전 답안 조회 실패 HTTP ${check.status}`;
  }
  const sub = await http('POST', '/api/student/submit', { token });
  r.submitted = sub.status === 200 && sub.json?.state === 'SUBMITTED';
  if (!r.submitted) r.note = `제출 실패 HTTP ${sub.status} ${sub.json?.error?.code ?? sub.json?.state ?? ''}`;
  sock.close();
}

// ───────────────────────── 메인 ─────────────────────────
async function main(): Promise<number> {
  let args: LoadArgs;
  try {
    args = parseLoadArgs(process.argv.slice(2));
    assertLoadDatabase(process.env.DATABASE_URL);
  } catch (e) {
    console.error(`시작할 수 없습니다: ${(e as Error).message}`);
    return 1;
  }
  BASE = args.base;
  const health = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
  if (!health) {
    console.error(`서버에 연결할 수 없습니다: ${BASE}/api/health`);
    return 1;
  }

  let staffId: string | undefined;
  const staffSockets: Socket[] = [];
  let students: Promise<Result>[] = [];
  let openGate: (ok: boolean) => void = () => {};
  const t0 = performance.now();
  try {
    const s = await seed(args.students, (id) => (staffId = id));
    console.log(`시드 완료: 학생 ${args.students}명, 시험 코드 ${s.examCode}`);

    const login = await http('POST', '/api/staff/login', { body: { email: s.email, password: s.staffPassword } });
    const setCookie = login.res.headers.getSetCookie?.()[0]?.split(';')[0];
    if (login.status !== 200 || !setCookie) throw new Error(`교수자 로그인 실패 HTTP ${login.status}`);

    // 교수자 소켓 2개: 소켓별로 받은 신호 키와 지연을 센다.
    const attemptIds = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const sock = await connect(undefined, setCookie);
      // 지연 기준: 학생이 emit하기 직전(performance.now) → 교수자 소켓의 signal:new 핸들러 진입. 서버가 신호를 받은 시각이 아니라
      // 학생 쪽에서 보낸 시각부터 재므로 SPEC 9장의 "서버 수신 → 대시보드 표시"보다 보수적(더 긴) 값이다(클라이언트 전송·ack 대기 전 구간 포함).
      sock.on('signal:new', (p: { attemptId: string; signal: { clientAt: number | null; seq?: number } }) => {
        const at = performance.now();
        const key = p.signal.clientAt === null ? null : `${p.attemptId}:${p.signal.clientAt}`;
        if (key !== null && sentAt.has(key)) {
          if (!staffReceived[i]!.has(key)) {
            staffReceived[i]!.add(key);
            latencies.push(at - sentAt.get(key)!);
          }
        } else {
          staffServerSignals[i]! += 1; // 서버가 만든 신호(DISCONNECT·RECONNECT 등)
        }
        attemptIds.add(p.attemptId);
      });
      const ack = await emitAck(sock, 'dashboard:join', { examId: s.examId });
      if (!ack.ok) throw new Error(`dashboard:join 실패 ${ack.code}`);
      staffSockets.push(sock);
    }

    // 학생 입장·대기. 모두 입장을 마치면 교수자가 시험을 시작한다.
    let entered = 0;
    let allEnteredResolve!: () => void;
    const start = new Promise<boolean>((r) => (openGate = r));
    const allEntered = new Promise<void>((r) => (allEnteredResolve = r));
    const gate = {
      enteredCount: () => {
        entered += 1;
        if (entered >= args.students) allEnteredResolve();
      },
      start,
    };
    students = s.roster.map((rs, idx) => runStudent(idx, { examCode: s.examCode, studentNo: rs.studentNo }, args, gate));
    await allEntered;
    await sleep(500);
    const tEntry = performance.now();
    console.log(`입장 완료(${Math.round(tEntry - t0)}ms). 교수자가 시험을 시작합니다.`);
    const started = await http('POST', `/api/exams/${s.examId}/start`, { cookie: setCookie });
    if (started.status !== 200) throw new Error(`시험 시작 실패 HTTP ${started.status}`);
    openGate(true);
    const results = await Promise.all(students);
    await sleep(3000); // 마지막 신호의 알림이 도착할 시간
    const tEnd = performance.now();

    const staffMissed = staffReceived.map((set) => countMissed(sentKeys, set));
    const lat = summarizeLatencies(latencies);
    const submitted = results.filter((x) => x.submitted).length;
    const answersPreserved = results.filter((x) => x.answersPreserved).length;
    const verdict = evaluate({ students: args.students, submitted, http5xx: counters.http5xx, staffMissed, signalCount: sentKeys.length, p95: lat.p95, answersPreserved, answerAckFail: counters.answerAckFail, signalAckFail: counters.signalAckFail, answersSent: results.reduce((n, x) => n + x.answersSent, 0) });
    if (counters.ackInternal > 0) {
      verdict.failures.push(`소켓 ack INTERNAL ${counters.ackInternal}건(서버 내부 오류)`);
      verdict.pass = false;
    }
    const summary = {
      pass: verdict.pass,
      failures: verdict.failures,
      students: args.students,
      submitted,
      answersPreserved,
      http5xx: counters.http5xx,
      staffMissed,
      signalsSent: sentKeys.length,
      // 한 신호를 교수자 소켓 2개가 각각 받으므로 지연 표본은 소켓별로 센 값의 합이다(한 소켓의 표본은 signalsSent - 누락)
      signalLatencyMs: { p50: lat.p50, p95: lat.p95, max: lat.max, samples: lat.count },
      reconnectedStudents: counters.reconnects,
      details: {
        answerAcks: counters.answerAcks,
        answerAckFail: counters.answerAckFail,
        signalAckFail: counters.signalAckFail,
        ackBusy: counters.ackBusy,
        ackInternal: counters.ackInternal,
        heartbeatsSent: counters.hbSent,
        staffServerSignalsReceived: staffServerSignals,
        studentNotes: results.filter((x) => x.note).map((x) => `${x.studentNo}: ${x.note}`),
      },
      params: { runSec: args.runSec, signalEverySec: args.signalEverySec, answerEverySec: args.answerEverySec, staffSockets: 2 },
      timingMs: { entry: Math.round(tEntry - t0), total: Math.round(tEnd - t0) },
      environment: { node: process.version, platform: `${process.platform} ${process.arch}`, cpu: `${cpus()[0]?.model.trim() ?? 'unknown'} x${cpus().length}`, memoryGB: Math.round(totalmem() / 2 ** 30), ...describeEnvironment(BASE, process.env.DATABASE_URL!) },
      measuredAt: new Date().toISOString(),
    };
    const json = JSON.stringify(summary, null, 2);
    console.log(json);
    if (args.out) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, json + '\n', 'utf8');
      console.log(`결과 저장: ${args.out}`);
    }
    return verdict.pass ? 0 : 1;
  } catch (e) {
    console.error(`측정 중 오류: ${(e as Error).message}`);
    return 1;
  } finally {
    // 시작 실패·예외 때도: 대기 중인 학생을 깨워 중단시키고(aborted), 끝나길 기다린 뒤 모든 소켓을 닫고 시드 데이터를 지운다.
    aborted = true;
    openGate(false);
    await Promise.allSettled(students);
    for (const sock of [...openSockets, ...staffSockets]) sock.close();
    openSockets.clear();
    try {
      await cleanup(staffId);
    } catch (e) {
      console.error(`정리 실패(수동 삭제 필요): ${(e as Error).message}`);
    }
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
