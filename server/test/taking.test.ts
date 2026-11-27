import { EV } from '@exam/shared';
import type { Attempt, Exam, Question, SubmitReason } from '@prisma/client';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { startDeadlineTicker, TICK_INTERVAL_MS, tickDeadlines } from '../src/jobs/deadlineTicker';
import { ANSWER_SAVE_BURST } from '../src/realtime/socket';
import { endExam } from '../src/services/examLifecycle';
import { saveAnswer, submitAttempt } from '../src/services/submission';
import { staffCookie } from './helpers/auth';
import { makeExam, resetDb } from './helpers/db';
import { startTestServer } from './helpers/server';

let server: Awaited<ReturnType<typeof startTestServer>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  // 새 DB 연결을 여는 데 시간이 걸리는 환경을 위해 연결을 미리 연다(realtime.test.ts와 같은 보정).
  await Promise.all(Array.from({ length: 6 }, () => prisma.attempt.findUnique({ where: { sessionTokenHash: 'warmup' } })));
});
afterAll(async () => {
  await server.close();
});
beforeEach(resetDb);
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

const PASS = '123456';
interface Ack {
  ok: boolean;
  code?: string;
  savedAt?: string;
}

interface Fixture {
  exam: Exam;
  mcq: Question; // c1(정답) c2 c3, 2점
  essay: Question; // 5점
  mcq2: Question; // d1(정답) d2, 3점
}

async function fixture(over: Partial<Omit<Exam, 'id' | 'createdAt'>> = {}): Promise<Fixture> {
  const exam = await makeExam({ status: 'RUNNING', passcode: PASS, startedAt: new Date(), endsAt: new Date(Date.now() + 600_000), ...over });
  await prisma.question.create({
    data: { examId: exam.id, position: 2, type: 'MCQ', prompt: '객관식2', points: 3, choices: [{ id: 'd1', text: '하' }, { id: 'd2', text: '나' }], correctChoiceId: 'd1' },
  });
  const qs = await prisma.question.findMany({ where: { examId: exam.id }, orderBy: { position: 'asc' } });
  return { exam, mcq: qs[0]!, essay: qs[1]!, mcq2: qs[2]! };
}

async function attemptFor(f: Fixture, over: { state?: Attempt['state']; extraSeconds?: number; studentNo?: string; questionOrder?: string[]; choiceOrders?: Record<string, string[]> } = {}) {
  const token = generateToken();
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: f.exam.id, ...(over.studentNo ? { studentNo: over.studentNo } : { attempt: null }) } });
  const attempt = await prisma.attempt.create({
    data: {
      examId: f.exam.id,
      rosterEntryId: roster.id,
      state: over.state ?? 'ACTIVE',
      sessionTokenHash: hashToken(token),
      extraSeconds: over.extraSeconds ?? 0,
      questionOrder: over.questionOrder ?? [f.mcq.id, f.essay.id, f.mcq2.id],
      choiceOrders: over.choiceOrders ?? { [f.mcq.id]: ['c1', 'c2', 'c3'], [f.mcq2.id]: ['d1', 'd2'] },
    },
  });
  return { attempt, token };
}

function open(auth?: Record<string, unknown>, cookie?: string): Socket {
  const s = connect(server.url, { auth, extraHeaders: cookie ? { Cookie: cookie } : {}, transports: ['polling'], reconnection: false, forceNew: true });
  sockets.push(s);
  return s;
}
const connected = (s: Socket) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
    s.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    s.once('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
async function studentSocket(token: string): Promise<Socket> {
  const s = open({ sessionToken: token });
  await connected(s);
  return s;
}
const save = (s: Socket, payload: unknown) => s.timeout(8000).emitWithAck(EV.ANSWER_SAVE, payload) as Promise<Ack>;
const answerRow = (attemptId: string, questionId: string) => prisma.answer.findUnique({ where: { attemptId_questionId: { attemptId, questionId } } });
const getExam = (token: string) => request(server.url).get('/api/student/exam').set('Authorization', `Bearer ${token}`);
const postSubmit = (token: string) => request(server.url).post('/api/student/submit').set('Authorization', `Bearer ${token}`).send({});

describe('GET /api/student/exam', () => {
  it('ACTIVE가 아닌 응시는 403 NOT_ACTIVE', async () => {
    for (const state of ['WAITING', 'PAUSED', 'SUBMITTED', 'TERMINATED'] as const) {
      const f = await fixture();
      const { token } = await attemptFor(f, { state, studentNo: undefined });
      const res = await getExam(token);
      expect(res.status, state).toBe(403);
      expect(res.body.error.code).toBe('NOT_ACTIVE');
    }
  });

  it('인증이 없거나 잘못되면 401', async () => {
    expect((await request(server.url).get('/api/student/exam')).status).toBe(401);
    expect((await getExam('nope')).status).toBe(401);
  });

  it('마감이 지난 ACTIVE(티커 전)도 403', async () => {
    const f = await fixture({ endsAt: new Date(Date.now() - 1000) });
    const { token } = await attemptFor(f);
    expect((await getExam(token)).status).toBe(403);
  });

  it('응답 어디에도 정답·배점 결과·비밀번호·해시가 없고, 허용된 키만 있다', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    await prisma.answer.create({ data: { attemptId: attempt.id, questionId: f.mcq.id, choiceId: 'c1', rev: 1, awardedPoints: 2 } });
    const res = await getExam(token);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const bad of ['correctChoiceId', 'awardedPoints', 'passcode', 'sessionTokenHash', 'pendingTokenHash', hashToken(token), PASS]) {
      expect(text, bad).not.toContain(bad);
    }
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(res.body);
    expect([...keys].sort()).toEqual(['answers', 'choiceId', 'choices', 'id', 'points', 'prompt', 'questions', 'rev', 'savedAt', 'text', 'type', 'questionId'].sort());
    expect(res.body.answers).toHaveLength(1);
    expect(Object.keys(res.body.answers[0]).sort()).toEqual(['choiceId', 'questionId', 'rev', 'savedAt']);
  });

  it('두 학생의 questionOrder·choiceOrders가 저장값대로 반환된다', async () => {
    const f = await fixture();
    const a = await attemptFor(f, { questionOrder: [f.mcq.id, f.essay.id, f.mcq2.id], choiceOrders: { [f.mcq.id]: ['c1', 'c2', 'c3'], [f.mcq2.id]: ['d1', 'd2'] } });
    const b = await attemptFor(f, { questionOrder: [f.mcq2.id, f.mcq.id, f.essay.id], choiceOrders: { [f.mcq.id]: ['c3', 'c1', 'c2'], [f.mcq2.id]: ['d2', 'd1'] } });
    const ra = (await getExam(a.token)).body;
    const rb = (await getExam(b.token)).body;
    expect(ra.questions.map((q: { id: string }) => q.id)).toEqual([f.mcq.id, f.essay.id, f.mcq2.id]);
    expect(rb.questions.map((q: { id: string }) => q.id)).toEqual([f.mcq2.id, f.mcq.id, f.essay.id]);
    expect(rb.questions[1].choices.map((c: { id: string }) => c.id)).toEqual(['c3', 'c1', 'c2']);
    expect(rb.questions[0].choices.map((c: { id: string }) => c.id)).toEqual(['d2', 'd1']);
    expect(rb.questions[2]).toEqual({ id: f.essay.id, type: 'ESSAY', prompt: '서술형', points: 5 });
  });

  it('저장한 답안이 복구된다(객관식은 choiceId, 서술형은 text)', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    expect((await save(s, { questionId: f.mcq.id, choiceId: 'c2', rev: 1 })).ok).toBe(true);
    expect((await save(s, { questionId: f.essay.id, text: '답안\n두 번째 줄', rev: 1 })).ok).toBe(true);
    const res = await getExam(token);
    const byQ = Object.fromEntries(res.body.answers.map((a: { questionId: string }) => [a.questionId, a]));
    expect(byQ[f.mcq.id]).toMatchObject({ choiceId: 'c2', rev: 1 });
    expect(byQ[f.mcq.id]).not.toHaveProperty('text');
    expect(byQ[f.essay.id]).toMatchObject({ text: '답안\n두 번째 줄', rev: 1 });
    expect(attempt.id).toBeTruthy();
  });
});

describe('answer:save 입력 검증', () => {
  it('정상 저장은 {ok:true, savedAt}만 돌려준다', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    const ack = await save(s, { questionId: f.mcq.id, choiceId: 'c3', rev: 0 });
    expect(Object.keys(ack).sort()).toEqual(['ok', 'savedAt']);
    expect(new Date(ack.savedAt!).toISOString()).toBe(ack.savedAt);
    expect((await answerRow(attempt.id, f.mcq.id))?.choiceId).toBe('c3');
  });

  it('rev: 2 저장 뒤 rev: 1은 STALE_REV이고 값은 유지된다', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    expect((await save(s, { questionId: f.essay.id, text: '둘', rev: 2 })).ok).toBe(true);
    expect(await save(s, { questionId: f.essay.id, text: '하나', rev: 1 })).toEqual({ ok: false, code: 'STALE_REV' });
    const row = await answerRow(attempt.id, f.essay.id);
    expect(row).toMatchObject({ text: '둘', rev: 2 });
  });

  it('같은 rev는 내용이 같으면 멱등 성공(savedAt 유지), 내용이 다르면 STALE_REV', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    const first = await save(s, { questionId: f.essay.id, text: '값', rev: 3 });
    const again = await save(s, { questionId: f.essay.id, text: '값', rev: 3 });
    expect(again).toEqual(first);
    expect(await save(s, { questionId: f.essay.id, text: '다른 값', rev: 3 })).toEqual({ ok: false, code: 'STALE_REV' });
    expect((await answerRow(attempt.id, f.essay.id))?.text).toBe('값');
  });

  it('서술형 5000자는 허용, 5001자는 TOO_LONG(UTF-16이 아니라 글자 수 기준)', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    expect((await save(s, { questionId: f.essay.id, text: 'a'.repeat(5000), rev: 1 })).ok).toBe(true);
    expect(await save(s, { questionId: f.essay.id, text: 'a'.repeat(5001), rev: 2 })).toEqual({ ok: false, code: 'TOO_LONG' });
    // 이모지 5000개는 UTF-16으로 10000이지만 글자 수로는 5000 → 허용
    expect((await save(s, { questionId: f.essay.id, text: '😀'.repeat(5000), rev: 3 })).ok).toBe(true);
    expect(await save(s, { questionId: f.essay.id, text: '😀'.repeat(5001), rev: 4 })).toEqual({ ok: false, code: 'TOO_LONG' });
    expect([...((await answerRow(attempt.id, f.essay.id))?.text ?? '')].length).toBe(5000);
  });

  it('줄바꿈·탭은 허용하고 NUL 등 제어 문자와 짝 없는 서로게이트는 INVALID', async () => {
    const f = await fixture();
    const { token } = await attemptFor(f);
    const s = await studentSocket(token);
    expect((await save(s, { questionId: f.essay.id, text: '가\r\n나\t다', rev: 1 })).ok).toBe(true);
    for (const text of ['a\u0000b', 'a\u0007b', 'a\u007fb', 'a\ud800b', 'a\udc00', '\ud83d']) {
      expect(await save(s, { questionId: f.essay.id, text, rev: 2 }), JSON.stringify(text)).toEqual({ ok: false, code: 'INVALID' });
    }
  });

  it('잘못된 모양·타입·문항·보기는 모두 INVALID이고 아무것도 저장되지 않는다', async () => {
    const f = await fixture();
    const other = await fixture(); // 다른 시험
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    const q = f.mcq.id;
    const e = f.essay.id;
    const bad: unknown[] = [
      null,
      'x',
      42,
      [],
      [{ questionId: q, choiceId: 'c1', rev: 1 }],
      {},
      { questionId: q, choiceId: 'c1' }, // rev 없음
      { choiceId: 'c1', rev: 1 }, // questionId 없음
      { questionId: other.mcq.id, choiceId: 'c1', rev: 1 }, // 다른 시험 문항
      { questionId: other.essay.id, text: 'x', rev: 1 },
      { questionId: '00000000-0000-0000-0000-000000000000', choiceId: 'c1', rev: 1 }, // 없는 문항
      { questionId: q, choiceId: 'd1', rev: 1 }, // 다른 문항의 보기
      { questionId: f.mcq2.id, choiceId: 'c1', rev: 1 },
      { questionId: q, choiceId: 'zzz', rev: 1 },
      { questionId: q, choiceId: 'c1', text: 'x', rev: 1 }, // 객관식에 text
      { questionId: q, text: 'x', rev: 1 },
      { questionId: q, rev: 1 },
      { questionId: e, choiceId: 'c1', rev: 1 }, // 서술형에 choiceId
      { questionId: e, choiceId: 'c1', text: 'x', rev: 1 },
      { questionId: e, rev: 1 },
      { questionId: e, text: null, rev: 1 },
      { questionId: e, text: 123, rev: 1 },
      { questionId: e, text: { a: 1 }, rev: 1 },
      { questionId: e, text: ['x'], rev: 1 },
      { questionId: q, choiceId: null, rev: 1 },
      { questionId: q, choiceId: { $ne: 1 }, rev: 1 },
      { questionId: q, choiceId: ['c1'], rev: 1 },
      { questionId: q, choiceId: 5, rev: 1 },
      { questionId: { a: 1 }, choiceId: 'c1', rev: 1 },
      { questionId: [q], choiceId: 'c1', rev: 1 },
      { questionId: q, choiceId: 'c1', rev: -1 },
      { questionId: q, choiceId: 'c1', rev: 1.5 },
      { questionId: q, choiceId: 'c1', rev: 2 ** 53 },
      { questionId: q, choiceId: 'c1', rev: 2 ** 31 }, // INT 범위 밖
      { questionId: q, choiceId: 'c1', rev: 1e300 },
      { questionId: q, choiceId: 'c1', rev: '1' },
      { questionId: q, choiceId: 'c1', rev: null },
      { questionId: q, choiceId: 'c1', rev: [1] },
      { questionId: q, choiceId: 'c1', rev: 1, extra: 1 }, // 알 수 없는 필드
      { questionId: q, choiceId: 'c1', rev: 1, attemptId: attempt.id },
      JSON.parse('{"questionId":"' + q + '","choiceId":"c1","rev":1,"__proto__":{"x":1}}'),
      { questionId: 'x'.repeat(200), choiceId: 'c1', rev: 1 },
    ];
    for (const payload of bad) {
      expect(await save(s, payload), JSON.stringify(payload)).toEqual({ ok: false, code: 'INVALID' });
    }
    expect(await prisma.answer.count({ where: { attemptId: attempt.id } })).toBe(0);
  });

  it('payload 없이 ack만 보내도 INVALID이고 서버는 계속 동작한다', async () => {
    const f = await fixture();
    const { token } = await attemptFor(f);
    const s = await studentSocket(token);
    expect(await (s.timeout(8000).emitWithAck(EV.ANSWER_SAVE) as Promise<Ack>)).toEqual({ ok: false, code: 'INVALID' });
    s.emit(EV.ANSWER_SAVE, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }); // ack 없이 보내도 죽지 않는다
    expect((await save(s, { questionId: f.mcq.id, choiceId: 'c1', rev: 2 })).ok).toBe(true);
  });
});

describe('answer:save 권한·상태', () => {
  it.each(['PAUSED', 'SUBMITTED', 'TERMINATED', 'WAITING'] as const)('%s 상태에서는 NOT_ACTIVE', async (state) => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f, { state });
    const s = await studentSocket(token);
    expect(await save(s, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 })).toEqual({ ok: false, code: 'NOT_ACTIVE' });
    expect(await prisma.answer.count({ where: { attemptId: attempt.id } })).toBe(0);
  });

  it('교수자 소켓은 answer:save를 쓸 수 없다', async () => {
    const f = await fixture();
    const staff = await prisma.staff.findFirstOrThrow({ where: { id: f.exam.ownerId } });
    const s = open(undefined, staffCookie(staff.id));
    await connected(s);
    expect(await save(s, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    expect(await prisma.answer.count()).toBe(0);
  });

  it('세션이 폐기되면(토큰 해시 변경) 연결이 남아 있어도 저장이 거부되고 연결이 끊긴다', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    expect((await save(s, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 })).ok).toBe(true);
    await prisma.attempt.update({ where: { id: attempt.id }, data: { sessionTokenHash: hashToken('new-token-by-approval') } });
    const closed = new Promise<void>((resolve) => s.once('disconnect', () => resolve()));
    expect(await save(s, { questionId: f.mcq.id, choiceId: 'c2', rev: 2 })).toEqual({ ok: false, code: 'NOT_ACTIVE' });
    await closed;
    expect((await answerRow(attempt.id, f.mcq.id))?.choiceId).toBe('c1');
  });

  it('소켓당 저장 속도 제한: 폭주하면 BUSY, 한도 안의 정상 저장은 영향 없음', async () => {
    const f = await fixture();
    const { token } = await attemptFor(f);
    const s = await studentSocket(token);
    const burst = await Promise.all(Array.from({ length: ANSWER_SAVE_BURST + 60 }, () => save(s, { bad: true })));
    const limited = burst.filter((r) => r.code === 'BUSY').length;
    expect(limited).toBeGreaterThanOrEqual(30);
    expect(burst.filter((r) => r.code === 'INVALID').length).toBeLessThanOrEqual(ANSWER_SAVE_BURST + 30);
    // 다른 소켓(다른 학생)은 영향이 없다
    const other = await attemptFor(f);
    const s2 = await studentSocket(other.token);
    expect((await save(s2, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 })).ok).toBe(true);
  });
});

describe('마감·제출·경쟁', () => {
  it('마감 1초 전 저장은 성공, 마감 뒤(티커 후) 저장은 NOT_ACTIVE, 제출된 답은 마감 전 값', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    const { attempt } = await attemptFor(f);
    const before = new Date(endsAt.getTime() - 1000);
    const after = new Date(endsAt.getTime() + 1000);
    expect((await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }, before)).ok).toBe(true);
    expect(await tickDeadlines(after)).toBe(1);
    const res = await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c2', rev: 2 }, after);
    expect(res).toMatchObject({ ok: false, code: 'NOT_ACTIVE' });
    const done = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(done).toMatchObject({ state: 'SUBMITTED', submitReason: 'TIMEOUT' });
    const row = await answerRow(attempt.id, f.mcq.id);
    expect(row).toMatchObject({ choiceId: 'c1', rev: 1, awardedPoints: 2 });
  });

  it('티커가 아직 돌지 않아도 마감 시각(now >= deadline) 이후 저장은 서버 시계로 거부', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    const { attempt } = await attemptFor(f);
    const r = await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }, endsAt);
    expect(r).toMatchObject({ ok: false, code: 'NOT_ACTIVE' });
    expect(await prisma.answer.count()).toBe(0);
  });

  it('추가 시간(extraSeconds)이 있으면 마감이 늦춰진다', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    const { attempt } = await attemptFor(f, { extraSeconds: 60 });
    const t = new Date(endsAt.getTime() + 30_000);
    expect(await tickDeadlines(t)).toBe(0);
    expect((await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }, t)).ok).toBe(true);
    expect(await tickDeadlines(new Date(endsAt.getTime() + 60_000))).toBe(1);
  });

  it('PAUSED 응시도 마감이 지나면 TIMEOUT으로 제출된다', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    const { attempt } = await attemptFor(f, { state: 'PAUSED' });
    expect(await tickDeadlines(new Date(endsAt.getTime() + 1))).toBe(1);
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } })).state).toBe('SUBMITTED');
  });

  it('동시 저장: 가장 큰 rev가 이기고 값과 rev가 항상 짝이 맞는다', async () => {
    const f = await fixture();
    const { attempt } = await attemptFor(f);
    const revs = Array.from({ length: 25 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    const results = await Promise.all(revs.map((rev) => saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.essay.id, text: `v${rev}`, rev }, new Date())));
    expect(results.some((r) => r.ok)).toBe(true);
    const row = await answerRow(attempt.id, f.essay.id);
    expect(row).toMatchObject({ rev: 25, text: 'v25' });
    expect(await prisma.answer.count({ where: { attemptId: attempt.id } })).toBe(1);
  });

  it('저장과 제출이 동시에 와도 제출 이후에는 저장이 반영되지 않고 채점은 최종 저장값과 일치', async () => {
    const f = await fixture();
    const { attempt } = await attemptFor(f);
    await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }, new Date());
    const saves = Array.from({ length: 10 }, (_, i) => saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: i % 2 ? 'c1' : 'c2', rev: i + 2 }, new Date()));
    const [sub, ...results] = await Promise.all([submitAttempt(attempt.id, 'STUDENT'), ...saves]);
    expect(sub.state).toBe('SUBMITTED');
    const row = (await answerRow(attempt.id, f.mcq.id))!;
    // 마지막으로 성공한 저장이 최종값이고, 채점은 그 값 기준
    const okRevs = results.flatMap((r, i) => (r.ok ? [i + 2] : []));
    expect(row.rev).toBe(Math.max(1, ...okRevs));
    expect(row.awardedPoints).toBe(row.choiceId === 'c1' ? 2 : 0);
    // 제출 뒤 저장은 거부
    expect(await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c3', rev: 99 }, new Date())).toMatchObject({ ok: false, code: 'NOT_ACTIVE' });
    expect((await answerRow(attempt.id, f.mcq.id))?.rev).toBe(row.rev);
  });

  it('endExam과 저장이 동시에 와도 종료 뒤 저장은 거부되고 채점이 최종값과 일치', async () => {
    const f = await fixture();
    const { attempt } = await attemptFor(f);
    const saves = Array.from({ length: 10 }, (_, i) => saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: i % 2 ? 'c1' : 'c2', rev: i + 1 }, new Date()));
    await Promise.all([endExam(f.exam.id), ...saves]);
    const done = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(done).toMatchObject({ state: 'SUBMITTED', submitReason: 'EXAM_ENDED' });
    const row = await answerRow(attempt.id, f.mcq.id);
    if (row) expect(row.awardedPoints).toBe(row.choiceId === 'c1' ? 2 : 0);
    expect(await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c3', rev: 99 }, new Date())).toMatchObject({ ok: false, code: 'NOT_ACTIVE' });
  });

  it('제출 시 객관식은 채점(정답=배점, 오답=0), 서술형은 채점하지 않고, 미답 행은 만들지 않는다', async () => {
    const f = await fixture();
    const { attempt, token } = await attemptFor(f);
    const s = await studentSocket(token);
    await save(s, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 });
    await save(s, { questionId: f.mcq2.id, choiceId: 'd2', rev: 1 });
    await save(s, { questionId: f.essay.id, text: '서술', rev: 1 });
    const res = await postSubmit(token);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('SUBMITTED');
    expect(await answerRow(attempt.id, f.mcq.id)).toMatchObject({ awardedPoints: 2 });
    expect(await answerRow(attempt.id, f.mcq2.id)).toMatchObject({ awardedPoints: 0 });
    expect((await answerRow(attempt.id, f.essay.id))?.awardedPoints).toBeNull();
    expect(await prisma.answer.count({ where: { attemptId: attempt.id } })).toBe(3);
    const done = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(done.submitReason).toBe('STUDENT');
    expect(done.submittedAt).not.toBeNull();
  });

  it('submitAttempt를 두 번 불러도 submittedAt·채점이 바뀌지 않는다', async () => {
    const f = await fixture();
    const { attempt } = await attemptFor(f);
    await saveAnswer(attempt.id, attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }, new Date());
    const a = await submitAttempt(attempt.id, 'STUDENT', new Date('2030-01-01T00:00:00Z'));
    const b = await submitAttempt(attempt.id, 'TIMEOUT', new Date('2031-01-01T00:00:00Z'));
    expect(b.submittedAt).toEqual(a.submittedAt);
    expect(b.submitReason).toBe('STUDENT');
    expect(a.submittedAt).toEqual(new Date('2030-01-01T00:00:00Z'));
    expect((await answerRow(attempt.id, f.mcq.id))?.awardedPoints).toBe(2);
  });

  it('동시에 제출해도 한 번만 처리된다(submittedAt 하나)', async () => {
    const f = await fixture();
    const { attempt } = await attemptFor(f);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => submitAttempt(attempt.id, 'STUDENT', new Date(1_900_000_000_000 + i * 1000))));
    expect(new Set(results.map((r) => r.submittedAt?.getTime())).size).toBe(1);
  });

  it('POST /api/student/submit: 두 번째 호출도 200(멱등), 인증 없으면 401, 대기 중이면 403', async () => {
    const f = await fixture();
    const { token } = await attemptFor(f);
    const first = await postSubmit(token);
    const second = await postSubmit(token);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.submittedAt).toBe(first.body.submittedAt);
    expect((await request(server.url).post('/api/student/submit').send({})).status).toBe(401);
    const waiting = await attemptFor(f, { state: 'WAITING' });
    const w = await postSubmit(waiting.token);
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('NOT_ACTIVE');
    expect((await getExam(token)).status).toBe(403);
  });

  it('endExam은 같은 제출 로직으로 채점·EXAM_ENDED 기록, PENDING_APPROVAL은 REJECTED, 종착은 불변', async () => {
    const f = await fixture();
    const act = await attemptFor(f);
    const pend = await attemptFor(f, { state: 'PENDING_APPROVAL' });
    const done = await attemptFor(f, { state: 'TERMINATED' });
    await saveAnswer(act.attempt.id, act.attempt.sessionTokenHash, { questionId: f.mcq.id, choiceId: 'c1', rev: 1 }, new Date());
    await endExam(f.exam.id);
    const get = (id: string) => prisma.attempt.findUniqueOrThrow({ where: { id } });
    expect(await get(act.attempt.id)).toMatchObject({ state: 'SUBMITTED', submitReason: 'EXAM_ENDED' });
    expect((await answerRow(act.attempt.id, f.mcq.id))?.awardedPoints).toBe(2);
    expect(await get(pend.attempt.id)).toMatchObject({ state: 'REJECTED', submitReason: null });
    expect(await get(done.attempt.id)).toMatchObject({ state: 'TERMINATED', submittedAt: null });
  });
});

describe('tickDeadlines', () => {
  it('모든 응시가 종착이고 now > endsAt이면 RUNNING 시험을 ENDED로 바꾼다', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    await attemptFor(f);
    await attemptFor(f, { state: 'TERMINATED' });
    const after = new Date(endsAt.getTime() + 1000);
    expect(await tickDeadlines(after)).toBe(1);
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: f.exam.id } });
    expect(exam.status).toBe('ENDED');
    expect(exam.endedAt).toEqual(after);
  });

  it('종착이 아닌 응시(대기 중 등)가 있거나 아직 endsAt 전이면 ENDED로 바꾸지 않는다', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    await attemptFor(f, { state: 'WAITING' });
    await tickDeadlines(new Date(endsAt.getTime() + 1000));
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: f.exam.id } })).status).toBe('RUNNING');
    const g = await fixture({ endsAt });
    await attemptFor(g, { state: 'SUBMITTED' });
    await tickDeadlines(new Date(endsAt.getTime() - 1000));
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: g.exam.id } })).status).toBe('RUNNING');
  });

  it('잠금 없는 사전 걸러내기가 있어도 없어도 결과가 같다(종료 가능한 시험만 ENDED)', async () => {
    for (const prefilter of [true, false]) {
      const endsAt = new Date(Date.now() + 600_000);
      const waiting = await fixture({ endsAt });
      await attemptFor(waiting, { state: 'WAITING' });
      const pending = await fixture({ endsAt });
      await attemptFor(pending, { state: 'PENDING_APPROVAL' });
      const finished = await fixture({ endsAt });
      await attemptFor(finished, { state: 'SUBMITTED' });
      await tickDeadlines(new Date(endsAt.getTime() + 1000), { prefilter });
      const status = async (id: string) => (await prisma.exam.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(waiting.exam.id), `prefilter=${prefilter}`).toBe('RUNNING');
      expect(await status(pending.exam.id), `prefilter=${prefilter}`).toBe('RUNNING');
      expect(await status(finished.exam.id), `prefilter=${prefilter}`).toBe('ENDED');
    }
  });

  it('한 응시의 실패가 다른 응시 처리를 막지 않는다', async () => {
    const endsAt = new Date(Date.now() + 600_000);
    const f = await fixture({ endsAt });
    const a = await attemptFor(f);
    const b = await attemptFor(f);
    const failFor = a.attempt.id;
    const submit = (id: string, reason: SubmitReason, now: Date) => (id === failFor ? Promise.reject(new Error('boom')) : submitAttempt(id, reason, now));
    const n = await tickDeadlines(new Date(endsAt.getTime() + 1000), { submit, log: () => {} });
    expect(n).toBe(1);
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: b.attempt.id } })).state).toBe('SUBMITTED');
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attempt.id } })).state).toBe('ACTIVE');
  });
});

describe('startDeadlineTicker', () => {
  it('기본 점검 주기는 250ms 이하다(F-11: 마감 후 1초 안)', () => {
    expect(TICK_INTERVAL_MS).toBeLessThanOrEqual(250);
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('이전 실행이 끝나지 않으면 겹쳐 실행하지 않는다', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const ticker = startDeadlineTicker({
      intervalMs: 5,
      tick: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(40);
        running--;
        return 0;
      },
      log: () => {},
    });
    await sleep(150);
    await ticker.stop();
    expect(maxRunning).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('예외가 나도 로그만 남기고 다음 틱에 계속하며, stop 뒤에는 더 실행되지 않는다', async () => {
    let calls = 0;
    const logged: unknown[] = [];
    const ticker = startDeadlineTicker({
      intervalMs: 5,
      tick: async () => {
        calls++;
        throw new Error('db down');
      },
      log: (...a) => logged.push(a),
    });
    await sleep(80);
    await ticker.stop();
    const at = calls;
    expect(at).toBeGreaterThanOrEqual(2);
    expect(logged.length).toBe(at);
    await sleep(40);
    expect(calls).toBe(at);
  });
});
