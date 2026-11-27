import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { Attempt, Exam } from '@prisma/client';
import type { Server } from 'socket.io';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { onError } from '../src/app';
import { generateToken, hashToken } from '../src/auth/studentSession';
import { prisma } from '../src/db';
import { setIo } from '../src/realtime/broadcast';
import { createAttemptsRouter } from '../src/routes/attempts';
import { applyAction, MAX_EXTRA_SECONDS } from '../src/services/actions';
import { saveAnswer } from '../src/services/submission';
import { staffCookie } from './helpers/auth';
import { makeExam, makeStaff, resetDb } from './helpers/db';

let app: Express;
let cookie: string;
let staffId: string;
let emitted: { room: string; event: string; payload: unknown }[];

function installFakeIo(): void {
  emitted = [];
  const make = (rooms: string[]): unknown => ({
    to: (r: string) => make([...rooms, r]),
    emit: (event: string, payload: unknown) => {
      for (const room of rooms) emitted.push({ room, event, payload });
    },
    disconnectSockets: () => undefined,
  });
  setIo({ to: (r: string) => make([r]), in: (r: string) => make([r]) } as unknown as Server);
}

beforeEach(async () => {
  await resetDb();
  installFakeIo();
  const staff = await makeStaff({ name: '김교수' });
  staffId = staff.id;
  cookie = staffCookie(staff.id);
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/attempts', createAttemptsRouter());
  app.use(onError);
});

const ENDS_AT = () => new Date(Date.now() + 600_000);
interface Fx {
  exam: Exam;
  attempt: Attempt;
  token: string;
  mcqId: string;
}
async function fixture(over: { state?: Attempt['state']; pausedAt?: Date | null; extraSeconds?: number; studentNo?: string } = {}, exam?: Exam): Promise<Fx> {
  const e = exam ?? (await makeExam({ ownerId: staffId, status: 'RUNNING', passcode: '123456', startedAt: new Date(), endsAt: ENDS_AT() }));
  const qs = await prisma.question.findMany({ where: { examId: e.id }, orderBy: { position: 'asc' } });
  const roster = await prisma.rosterEntry.findFirstOrThrow({ where: { examId: e.id, ...(over.studentNo ? { studentNo: over.studentNo } : { attempt: null }) }, orderBy: { studentNo: 'asc' } });
  const token = generateToken();
  const attempt = await prisma.attempt.create({
    data: {
      examId: e.id,
      rosterEntryId: roster.id,
      state: over.state ?? 'ACTIVE',
      sessionTokenHash: hashToken(token),
      pausedAt: over.pausedAt ?? null,
      extraSeconds: over.extraSeconds ?? 0,
      consentAt: new Date(),
      envCheckedAt: new Date(),
      questionOrder: qs.map((q) => q.id),
      choiceOrders: { [qs[0]!.id]: ['c1', 'c2', 'c3'] },
    },
  });
  return { exam: e, attempt, token, mcqId: qs[0]!.id };
}

const act = (id: string, b: Record<string, unknown>, c: string | null = cookie) => {
  const r = request(app).post(`/api/attempts/${id}/actions`);
  return (c ? r.set('Cookie', c) : r).send(b);
};
const events = (event: string) => emitted.filter((e) => e.event === event);
const recorded = (attemptId: string) => prisma.proctorAction.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' } });
const row = (id: string) => prisma.attempt.findUniqueOrThrow({ where: { id } });

describe('F-16 기록 (a)', () => {
  it('각 조치를 1회씩 실행하면 실행자·시각·사유가 모두 기록된다', async () => {
    const f = await fixture();
    const steps: [Record<string, unknown>, string][] = [
      [{ type: 'WARN', reason: '화면을 보세요' }, 'WARN'],
      [{ type: 'PAUSE', reason: '현장 확인' }, 'PAUSE'],
      [{ type: 'RESUME', reason: '확인 완료' }, 'RESUME'],
      [{ type: 'ADD_TIME', reason: '본인 요청', payload: { minutes: 5 } }, 'ADD_TIME'],
      [{ type: 'ACK' }, 'ACK'],
      [{ type: 'TERMINATE', reason: '시험 중단' }, 'TERMINATE'],
    ];
    for (const [b] of steps) expect((await act(f.attempt.id, b)).status).toBe(200);
    const rows = await recorded(f.attempt.id);
    expect(rows.map((r) => r.type)).toEqual(steps.map(([, t]) => t));
    for (const r of rows) {
      expect(r.staffId).toBe(staffId);
      expect(r.createdAt).toBeInstanceOf(Date);
    }
    expect(rows[0]!.reason).toBe('화면을 보세요');
    expect(rows[3]!.payload).toEqual({ minutes: 5 });
    expect(rows[4]!.reason).toBe('');
  });

  it('실행자는 항상 인증된 계정이다(본문의 staffId는 무시)', async () => {
    const other = await makeStaff();
    const f = await fixture();
    await act(f.attempt.id, { type: 'PAUSE', reason: '확인', staffId: other.id });
    expect((await recorded(f.attempt.id))[0]!.staffId).toBe(staffId);
  });

  it('다른 교수자의 시험 응시에도 조치할 수 있다(D-016)', async () => {
    const f = await fixture();
    const other = await makeStaff({ name: '이교수' });
    expect((await act(f.attempt.id, { type: 'PAUSE', reason: '확인' }, staffCookie(other.id))).status).toBe(200);
    expect((await recorded(f.attempt.id))[0]!.staffId).toBe(other.id);
  });
});

describe('사유 검증 (b)', () => {
  it('PAUSE는 사유 없이·공백만·500자 초과·제어 문자·줄바꿈이면 400, 기록 없음', async () => {
    const f = await fixture();
    for (const reason of [undefined, '', '   ', 'a'.repeat(501), 'a\u0000b', 'a\nb', 5, null]) {
      const res = await act(f.attempt.id, { type: 'PAUSE', ...(reason === undefined ? {} : { reason }) });
      expect(res.status).toBe(400);
    }
    expect(await recorded(f.attempt.id)).toHaveLength(0);
    expect((await row(f.attempt.id)).state).toBe('ACTIVE');
    expect((await act(f.attempt.id, { type: 'PAUSE', reason: 'a'.repeat(500) })).status).toBe(200);
  });

  it('WARN 메시지는 500자까지 원문 그대로 저장되고 그대로 학생에게 간다(HTML도 변형하지 않음)', async () => {
    const f = await fixture();
    const msg = '<b>주의</b> & "확인"';
    expect((await act(f.attempt.id, { type: 'WARN', reason: msg })).status).toBe(200);
    expect((await recorded(f.attempt.id))[0]!.reason).toBe(msg);
    expect(events('proctor:warning')[0]).toEqual({ room: `attempt:${f.attempt.id}`, event: 'proctor:warning', payload: { message: msg } });
  });

  it('ACK는 사유 없이 200이고 unackedSeverity가 NONE', async () => {
    const f = await fixture();
    await prisma.attempt.update({ where: { id: f.attempt.id }, data: { unackedSeverity: 'ALERT' } });
    const res = await act(f.attempt.id, { type: 'ACK' });
    expect(res.status).toBe(200);
    expect(res.body.attempt.unackedSeverity).toBe('NONE');
    expect((await row(f.attempt.id)).unackedSeverity).toBe('NONE');
    expect(await act(f.attempt.id, { type: 'ACK', reason: 'a\u0000' })).toMatchObject({ status: 400 });
  });

  it('알 수 없는 type·승인 type이 아닌 값은 400', async () => {
    const f = await fixture();
    expect((await act(f.attempt.id, { type: 'AUTO_PAUSE', reason: '시스템' })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 'NOPE', reason: '시스템' })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 5, reason: '시스템' })).status).toBe(400);
  });
});

describe('PAUSE·RESUME (c)', () => {
  it('PAUSE → 학생이 PAUSED를 받고 answer:save가 NOT_ACTIVE, RESUME 뒤에는 저장된다', async () => {
    const f = await fixture();
    const res = await act(f.attempt.id, { type: 'PAUSE', reason: '현장 확인' });
    expect(res.status).toBe(200);
    expect(res.body.attempt).toMatchObject({ state: 'PAUSED', locked: false });
    expect(res.body.attempt.pausedAt).toEqual(expect.any(Number));
    expect(events('attempt:state')[0]).toMatchObject({ room: `attempt:${f.attempt.id}`, payload: { state: 'PAUSED' } });
    expect((await row(f.attempt.id)).pausedAt).not.toBeNull();

    const payload = { questionId: f.mcqId, choiceId: 'c1', rev: 1 };
    expect(await saveAnswer(f.attempt.id, hashToken(f.token), payload, new Date())).toEqual({ ok: false, code: 'NOT_ACTIVE' });

    emitted.length = 0;
    expect((await act(f.attempt.id, { type: 'RESUME', reason: '확인 완료' })).body.attempt).toMatchObject({ state: 'ACTIVE', pausedAt: null });
    expect(events('attempt:state')[0]).toMatchObject({ payload: { state: 'ACTIVE' } });
    expect((await row(f.attempt.id)).pausedAt).toBeNull();
    expect(await saveAnswer(f.attempt.id, hashToken(f.token), payload, new Date())).toMatchObject({ ok: true });
  });
});

describe('ADD_TIME (d)', () => {
  it('10분 → 그 응시의 extraSeconds만 600 늘고 deadline이 같은 만큼 늘며 알림이 간다', async () => {
    const a = await fixture({ studentNo: '20260001' });
    const b = await fixture({ studentNo: '20260002' }, a.exam);
    const res = await act(a.attempt.id, { type: 'ADD_TIME', reason: '본인 요청', payload: { minutes: 10 } });
    expect(res.status).toBe(200);
    expect((await row(a.attempt.id)).extraSeconds).toBe(600);
    expect((await row(b.attempt.id)).extraSeconds).toBe(0);
    expect(res.body.attempt.extraSeconds).toBe(600);
    expect(res.body.attempt.deadline).toBe(a.exam.endsAt!.getTime() + 600_000);
    expect(events('attempt:state')).toHaveLength(1);
    expect(events('attempt:state')[0]).toMatchObject({ room: `attempt:${a.attempt.id}`, payload: { extraSeconds: 600, deadline: a.exam.endsAt!.getTime() + 600_000 } });
  });

  it.each([0, 61, 1.5, '10', -1, null, 1e12, Number.MAX_SAFE_INTEGER, true])('minutes=%s는 400, 변경·기록 없음', async (minutes) => {
    const f = await fixture();
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes } })).status).toBe(400);
    expect((await row(f.attempt.id)).extraSeconds).toBe(0);
    expect(await recorded(f.attempt.id)).toHaveLength(0);
  });

  it('payload 없음·알 수 없는 키·배열은 400, 1과 60은 허용', async () => {
    const f = await fixture();
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가' })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 5, extra: 1 } })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: [5] })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 'PAUSE', reason: '추가', payload: { minutes: 5 } })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 1 } })).status).toBe(200);
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 60 } })).status).toBe(200);
    expect((await row(f.attempt.id)).extraSeconds).toBe(3660);
  });

  it('누적 상한(24시간)을 넘기면 409 EXTRA_TIME_LIMIT이고 기록·알림이 없다', async () => {
    const f = await fixture({ extraSeconds: MAX_EXTRA_SECONDS - 300 });
    const res = await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 10 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTRA_TIME_LIMIT');
    expect((await row(f.attempt.id)).extraSeconds).toBe(MAX_EXTRA_SECONDS - 300);
    expect(await recorded(f.attempt.id)).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 5 } })).status).toBe(200);
  });

  it('종착·대기 상태 응시에는 409', async () => {
    for (const state of ['SUBMITTED', 'TERMINATED', 'WAITING'] as const) {
      const f = await fixture({ state });
      expect((await act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 5 } })).status).toBe(409);
    }
  });
});

describe('잠겨 있던 시간 추가 (e)', () => {
  it('RESUME + addPausedTime:true → RESUME과 ADD_TIME이 모두 기록되고 minutes = 올림(경과 분)', async () => {
    const pausedAt = new Date(Date.now() - 7 * 60_000 - 20_000); // 7분 20초 전 → 8분
    const f = await fixture({ state: 'PAUSED', pausedAt });
    const res = await act(f.attempt.id, { type: 'RESUME', reason: '확인 완료', payload: { addPausedTime: true } });
    expect(res.status).toBe(200);
    const rows = await recorded(f.attempt.id);
    expect(rows.map((r) => r.type).sort()).toEqual(['ADD_TIME', 'RESUME']);
    const add = rows.find((r) => r.type === 'ADD_TIME')!;
    expect(add.payload).toEqual({ minutes: 8, fromPause: true });
    expect(add.staffId).toBe(staffId);
    const after = await row(f.attempt.id);
    expect(after.pausedAt).toBeNull();
    expect(after.state).toBe('ACTIVE');
    expect(after.extraSeconds).toBe(480);
    expect(res.body.attempt.deadline).toBe(f.exam.endsAt!.getTime() + 480_000);
    expect(events('attempt:state')).toHaveLength(1);
  });

  it('applyAction에 now를 주입하면 정확한 올림·최소 1분·최대 60분이 적용된다', async () => {
    const base = new Date('2026-11-27T10:00:00.000Z');
    const cases: [number, number][] = [
      [60_000, 1],
      [60_001, 2],
      [1, 1],
      [0, 1],
      [-5_000, 1], // 시계가 거꾸로 가도 최소 1분
      [3_600_000, 60],
      [10 * 3_600_000, 60],
    ];
    for (const [elapsed, minutes] of cases) {
      const f = await fixture({ state: 'PAUSED', pausedAt: base });
      await applyAction(f.attempt.id, staffId, { type: 'RESUME', reason: '확인', payload: { addPausedTime: true } }, new Date(base.getTime() + elapsed));
      expect((await row(f.attempt.id)).extraSeconds, `elapsed=${elapsed}`).toBe(minutes * 60);
      await prisma.attempt.deleteMany({ where: { id: f.attempt.id } });
    }
  });

  it('addPausedTime 없이 RESUME하면 시간이 늘지 않고 ADD_TIME도 없다', async () => {
    const f = await fixture({ state: 'PAUSED', pausedAt: new Date(Date.now() - 120_000) });
    await act(f.attempt.id, { type: 'RESUME', reason: '확인' });
    expect((await recorded(f.attempt.id)).map((r) => r.type)).toEqual(['RESUME']);
    expect((await row(f.attempt.id)).extraSeconds).toBe(0);
  });

  it('pausedAt이 null인 PAUSED 응시의 addPausedTime은 무시된다(RESUME만 기록)', async () => {
    const f = await fixture({ state: 'PAUSED', pausedAt: null });
    expect((await act(f.attempt.id, { type: 'RESUME', reason: '확인', payload: { addPausedTime: true } })).status).toBe(200);
    expect((await recorded(f.attempt.id)).map((r) => r.type)).toEqual(['RESUME']);
    expect((await row(f.attempt.id)).extraSeconds).toBe(0);
  });

  it('addPausedTime이 불리언이 아니거나 알 수 없는 키면 400', async () => {
    const f = await fixture({ state: 'PAUSED', pausedAt: new Date() });
    expect((await act(f.attempt.id, { type: 'RESUME', reason: '확인', payload: { addPausedTime: 'true' } })).status).toBe(400);
    expect((await act(f.attempt.id, { type: 'RESUME', reason: '확인', payload: { minutes: 5 } })).status).toBe(400);
    expect((await row(f.attempt.id)).state).toBe('PAUSED');
  });

  it('누적 상한을 넘기는 잠금 시간 추가는 409이고 RESUME도 일어나지 않는다(전부 아니면 전무)', async () => {
    const f = await fixture({ state: 'PAUSED', pausedAt: new Date(Date.now() - 600_000), extraSeconds: MAX_EXTRA_SECONDS });
    const res = await act(f.attempt.id, { type: 'RESUME', reason: '확인', payload: { addPausedTime: true } });
    expect(res.status).toBe(409);
    expect((await row(f.attempt.id)).state).toBe('PAUSED');
    expect(await recorded(f.attempt.id)).toHaveLength(0);
  });

  it('자동 잠금 응시는 locked:true로 요약되고 RESUME 후 false', async () => {
    const f = await fixture({ state: 'PAUSED', pausedAt: new Date() });
    await prisma.proctorAction.create({ data: { attemptId: f.attempt.id, staffId: null, type: 'AUTO_PAUSE', reason: '시스템 자동 일시정지(위반 5회)' } });
    const tl = await request(app).get(`/api/attempts/${f.attempt.id}/timeline`).set('Cookie', cookie);
    expect(tl.body.attempt.locked).toBe(true);
    expect(tl.body.actions[0]).toMatchObject({ type: 'AUTO_PAUSE', staffName: null });
    const res = await act(f.attempt.id, { type: 'RESUME', reason: '확인' });
    expect(res.body.attempt.locked).toBe(false);
  });
});

describe('WARN (f)', () => {
  it('proctor:warning이 학생 방에만 가고 응시 상태·시각은 그대로이다', async () => {
    const f = await fixture();
    const before = await row(f.attempt.id);
    expect((await act(f.attempt.id, { type: 'WARN', reason: '화면을 유지하세요' })).status).toBe(200);
    expect(events('proctor:warning')).toEqual([{ room: `attempt:${f.attempt.id}`, event: 'proctor:warning', payload: { message: '화면을 유지하세요' } }]);
    expect(events('attempt:state')).toHaveLength(0);
    expect(await row(f.attempt.id)).toEqual(before);
  });

  it('종착·승인 대기 응시에는 409이고 알림이 없다', async () => {
    for (const state of ['SUBMITTED', 'TERMINATED', 'REJECTED', 'PENDING_APPROVAL'] as const) {
      const f = await fixture({ state });
      expect((await act(f.attempt.id, { type: 'WARN', reason: '경고' })).status).toBe(409);
    }
    expect(emitted).toHaveLength(0);
  });
});

describe('TERMINATE (g)', () => {
  it('ACTIVE에서 TERMINATED가 되고 객관식 답안이 제출과 같은 규칙으로 채점된다', async () => {
    const f = await fixture();
    const essay = await prisma.question.findFirstOrThrow({ where: { examId: f.exam.id, type: 'ESSAY' } });
    await prisma.answer.create({ data: { attemptId: f.attempt.id, questionId: f.mcqId, choiceId: 'c1', rev: 1 } });
    await prisma.answer.create({ data: { attemptId: f.attempt.id, questionId: essay.id, text: '서술', rev: 1 } });
    const res = await act(f.attempt.id, { type: 'TERMINATE', reason: '시험 중단' });
    expect(res.status).toBe(200);
    expect(res.body.attempt.state).toBe('TERMINATED');
    expect((await row(f.attempt.id)).state).toBe('TERMINATED');
    const answers = await prisma.answer.findMany({ where: { attemptId: f.attempt.id } });
    expect(answers.find((a) => a.questionId === f.mcqId)!.awardedPoints).toBe(2);
    expect(answers.find((a) => a.questionId === essay.id)!.awardedPoints).toBeNull();
    expect(events('attempt:state')[0]).toMatchObject({ payload: { state: 'TERMINATED' } });
  });

  it('오답은 0점으로 채점되고 PAUSED에서도 종료된다', async () => {
    const f = await fixture({ state: 'PAUSED', pausedAt: new Date() });
    await prisma.answer.create({ data: { attemptId: f.attempt.id, questionId: f.mcqId, choiceId: 'c2', rev: 1 } });
    expect((await act(f.attempt.id, { type: 'TERMINATE', reason: '시험 중단' })).status).toBe(200);
    expect((await prisma.answer.findFirstOrThrow({ where: { attemptId: f.attempt.id } })).awardedPoints).toBe(0);
  });

  it('종착이거나 대기 상태면 409 INVALID_STATE이고 기록·알림이 없다', async () => {
    for (const state of ['SUBMITTED', 'TERMINATED', 'REJECTED', 'WAITING', 'PENDING_APPROVAL'] as const) {
      const f = await fixture({ state });
      const res = await act(f.attempt.id, { type: 'TERMINATE', reason: '시험 중단' });
      expect(res.status, state).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
      expect((await row(f.attempt.id)).state).toBe(state);
    }
    expect(await prisma.proctorAction.count()).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});

describe('인증·입력·상태 거부 (h)', () => {
  it('무인증·학생 토큰은 401', async () => {
    const f = await fixture();
    expect((await act(f.attempt.id, { type: 'PAUSE', reason: '확인' }, null)).status).toBe(401);
    const student = await request(app).post(`/api/attempts/${f.attempt.id}/actions`).set('Authorization', `Bearer ${f.token}`).send({ type: 'PAUSE', reason: '확인' });
    expect(student.status).toBe(401);
    expect((await request(app).get(`/api/attempts/${f.attempt.id}/timeline`)).status).toBe(401);
    expect((await request(app).get(`/api/attempts/${f.attempt.id}/timeline`).set('Authorization', `Bearer ${f.token}`)).status).toBe(401);
    expect((await row(f.attempt.id)).state).toBe('ACTIVE');
  });

  it('잘못된 id는 400, 없는 응시는 404', async () => {
    expect((await act('not-a-uuid', { type: 'PAUSE', reason: '확인' })).status).toBe(400);
    expect((await act('00000000-0000-4000-8000-000000000000', { type: 'PAUSE', reason: '확인' })).status).toBe(404);
    expect((await request(app).get('/api/attempts/xyz/timeline').set('Cookie', cookie)).status).toBe(400);
    expect((await request(app).get('/api/attempts/00000000-0000-4000-8000-000000000000/timeline').set('Cookie', cookie)).status).toBe(404);
  });

  it('허용되지 않는 상태 조합은 409이며 기록·알림이 없다', async () => {
    const active = await fixture({ state: 'ACTIVE' });
    const paused = await fixture({ state: 'PAUSED', pausedAt: new Date() });
    const done = await fixture({ state: 'SUBMITTED' });
    const waiting = await fixture({ state: 'WAITING' });
    const cases: [string, Record<string, unknown>][] = [
      [active.attempt.id, { type: 'RESUME', reason: '확인' }],
      [paused.attempt.id, { type: 'PAUSE', reason: '확인' }],
      [done.attempt.id, { type: 'PAUSE', reason: '확인' }],
      [done.attempt.id, { type: 'RESUME', reason: '확인' }],
      [waiting.attempt.id, { type: 'PAUSE', reason: '확인' }],
    ];
    for (const [id, b] of cases) {
      const res = await act(id, b);
      expect(res.status, JSON.stringify(b)).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    }
    expect(await prisma.proctorAction.count()).toBe(0);
    expect(emitted).toHaveLength(0);
    expect((await row(paused.attempt.id)).pausedAt).not.toBeNull();
  });

  it('알림 전송이 실패해도 상태 변경은 유지되고 200', async () => {
    const f = await fixture();
    setIo({
      to: () => {
        throw new Error('소켓 오류');
      },
    } as unknown as Server);
    const res = await act(f.attempt.id, { type: 'PAUSE', reason: '확인' });
    expect(res.status).toBe(200);
    expect((await row(f.attempt.id)).state).toBe('PAUSED');
    expect(await recorded(f.attempt.id)).toHaveLength(1);
  });
});

describe('동시성 (i)', () => {
  it('같은 응시에 PAUSE 두 건이 동시에 오면 하나만 200, 하나는 409, 기록 1건', async () => {
    const f = await fixture();
    const res = await Promise.all([act(f.attempt.id, { type: 'PAUSE', reason: '하나' }), act(f.attempt.id, { type: 'PAUSE', reason: '둘' })]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await recorded(f.attempt.id)).toHaveLength(1);
    expect(events('attempt:state')).toHaveLength(1);
  });

  it('동시 ADD_TIME 5건은 모두 반영된다(손실 갱신 없음)', async () => {
    const f = await fixture();
    const res = await Promise.all(Array.from({ length: 5 }, () => act(f.attempt.id, { type: 'ADD_TIME', reason: '추가', payload: { minutes: 2 } })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await row(f.attempt.id)).extraSeconds).toBe(600);
  });

  it('PAUSE와 TERMINATE가 동시에 와도 상태가 모순되지 않는다', async () => {
    const f = await fixture();
    await Promise.all([act(f.attempt.id, { type: 'PAUSE', reason: '하나' }), act(f.attempt.id, { type: 'TERMINATE', reason: '둘' })]);
    const after = await row(f.attempt.id);
    expect(after.state).toBe('TERMINATED'); // 어느 순서든 TERMINATE는 항상 성공하고, 종착 뒤의 PAUSE는 409
    const types = (await recorded(f.attempt.id)).map((r) => r.type);
    expect(types[types.length - 1]).toBe('TERMINATE');
    expect(types.length).toBeLessThanOrEqual(2);
  });
});

describe('GET /timeline (j)', () => {
  it('신호를 시간순으로, 조치에 staffName을 담고 비밀 값이 없다', async () => {
    const f = await fixture({ studentNo: '20260001' });
    const t0 = Date.now();
    await prisma.signal.create({ data: { attemptId: f.attempt.id, type: 'PASTE', severity: 'WARN', receivedAt: new Date(t0 + 2000), meta: { chars: 5 } } });
    await prisma.signal.create({ data: { attemptId: f.attempt.id, type: 'LEAVE_START', severity: 'WARN', receivedAt: new Date(t0 + 1000) } });
    await prisma.signal.create({ data: { attemptId: f.attempt.id, type: 'LEAVE', severity: 'ALERT', receivedAt: new Date(t0 + 3000), durationMs: 20000 } });
    await act(f.attempt.id, { type: 'WARN', reason: '경고' });
    await prisma.proctorAction.create({ data: { attemptId: f.attempt.id, staffId: null, type: 'AUTO_PAUSE', reason: '시스템 자동 일시정지(위반 5회)', createdAt: new Date(Date.now() + 5000) } });

    const res = await request(app).get(`/api/attempts/${f.attempt.id}/timeline`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.signals.map((s: { type: string }) => s.type)).toEqual(['LEAVE_START', 'PASTE', 'LEAVE']);
    expect(res.body.signals[1]).toMatchObject({ severity: 'WARN', meta: { chars: 5 }, clientAt: null, durationMs: null, questionId: null });
    expect(res.body.truncated).toBe(false);
    expect(res.body.actions.map((a: { type: string }) => a.type)).toEqual(['WARN', 'AUTO_PAUSE']);
    expect(res.body.actions[0]).toMatchObject({ staffName: '김교수', reason: '경고', payload: {}, createdAt: expect.any(Number) });
    expect(res.body.actions[1].staffName).toBeNull();
    expect(res.body.attempt).toMatchObject({ attemptId: f.attempt.id, studentNo: '20260001', name: '학생1', state: 'ACTIVE', ready: true, away: false, lastSignal: { type: 'LEAVE' } });
    expect(Object.keys(res.body.attempt).sort()).toEqual(
      ['attemptId', 'studentNo', 'name', 'state', 'ready', 'consentDeclined', 'violationCount', 'unackedSeverity', 'locked', 'connected', 'away', 'extraSeconds', 'deadline', 'pausedAt', 'lastSignal'].sort(),
    );

    const text = JSON.stringify(res.body) + JSON.stringify((await act(f.attempt.id, { type: 'ACK' })).body);
    expect(text).not.toContain('123456'); // passcode
    expect(text).not.toContain(hashToken(f.token));
    expect(text).not.toContain(f.token);
    expect(text).not.toMatch(/sessionTokenHash|pendingTokenHash|passcode|correctChoiceId|choiceOrders|questionOrder/);
  });

  it('LEAVE_START 뒤 LEAVE 전이면 away:true', async () => {
    const f = await fixture();
    await prisma.signal.create({ data: { attemptId: f.attempt.id, type: 'LEAVE_START', severity: 'WARN' } });
    const res = await request(app).get(`/api/attempts/${f.attempt.id}/timeline`).set('Cookie', cookie);
    expect(res.body.attempt.away).toBe(true);
  });

  it('신호가 500개를 넘으면 가장 최근 500개를 오름차순으로 주고 truncated:true', async () => {
    const f = await fixture();
    const base = Date.now() - 1_000_000;
    await prisma.signal.createMany({
      data: Array.from({ length: 503 }, (_, i) => ({ attemptId: f.attempt.id, type: 'HEARTBEAT_GAP' as const, severity: 'WARN' as const, receivedAt: new Date(base + i * 1000), durationMs: i })),
    });
    const res = await request(app).get(`/api/attempts/${f.attempt.id}/timeline`).set('Cookie', cookie);
    expect(res.body.truncated).toBe(true);
    expect(res.body.signals).toHaveLength(500);
    expect(res.body.signals[0].durationMs).toBe(3);
    expect(res.body.signals[499].durationMs).toBe(502);
  });

  it('다른 응시의 신호·조치는 섞이지 않는다', async () => {
    const a = await fixture({ studentNo: '20260001' });
    const b = await fixture({ studentNo: '20260002' }, a.exam);
    await prisma.signal.create({ data: { attemptId: b.attempt.id, type: 'PASTE', severity: 'WARN' } });
    await act(b.attempt.id, { type: 'PAUSE', reason: '다른 응시' });
    const res = await request(app).get(`/api/attempts/${a.attempt.id}/timeline`).set('Cookie', cookie);
    expect(res.body.signals).toHaveLength(0);
    expect(res.body.actions).toHaveLength(0);
  });
});

describe('기존 승인 처리는 그대로', () => {
  it('APPROVE_ENTRY는 사유가 필수이고 {attempt:{id,state}}를 돌려준다', async () => {
    const f = await fixture({ state: 'PENDING_APPROVAL' });
    expect((await act(f.attempt.id, { type: 'APPROVE_ENTRY' })).status).toBe(400);
    const res = await act(f.attempt.id, { type: 'APPROVE_ENTRY', reason: '지각 확인' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempt: { id: f.attempt.id, state: 'WAITING' } });
  });
});
