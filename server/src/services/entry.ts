import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type Attempt, type Exam, type RosterEntry } from '@prisma/client';
import type { Response } from 'express';
import { generateToken, hashToken } from '../auth/studentSession';
import { prisma } from '../db';
import { nextState } from '../domain/attemptMachine';
import { buildOrders } from '../domain/shuffle';
import { AppError } from '../errors';
import { attemptStatePayload, broadcast, getIo } from '../realtime/broadcast';
import { normalizeIpKey } from '../security/loginProtection';
import { createRateLimiter, type RateLimiterOptions } from '../security/rateLimit';
import { lockExam, runExamTx } from './examLifecycle';

/**
 * 학생 입장(F-07)·세션(2.3)·승인(F-14) 서비스.
 *
 * 보안 요점
 *  - 사용자 열거 방지: 없는 시험 코드·명단 밖 학번·틀린 비밀번호는 모두 같은 401 ENTRY_FAILED.
 *  - 비밀번호 무차별 대입 방지: IP당 "실패만" 센다(입장 성공은 세지 않는다). 같은 IP의 비밀번호 확인은 한 줄로 세워(직렬화)
 *    동시에 수백 건을 쏴서 한도를 넘겨 추측하는 우회를 막는다.
 *  - 토큰은 해시만 저장한다. 응답·로그에 해시·비밀번호·정답이 나가지 않는다.
 *  - 응시 생성·승인은 시험 행 잠금(FOR UPDATE) 트랜잭션 안에서 상태를 확인하고 바꾼다.
 */

const ENTRY_FAILED = () => new AppError(401, 'ENTRY_FAILED', '학번 또는 시험 비밀번호가 올바르지 않습니다.');
const NOT_ENTERABLE = () => new AppError(403, 'EXAM_NOT_ENTERABLE', '지금은 입장할 수 없는 시험입니다.');
const ENTRY_CLOSED = () => new AppError(403, 'ENTRY_CLOSED', '입장이 마감되었습니다.');
const ENTRY_REJECTED = () => new AppError(403, 'ENTRY_REJECTED', '입장이 거절되었습니다.');
const ATTEMPT_FINISHED = () => new AppError(409, 'ATTEMPT_FINISHED', '이미 종료된 응시입니다.');
const NOT_FOUND_ATTEMPT = () => new AppError(404, 'NOT_FOUND', '응시를 찾을 수 없습니다.');
const ALREADY_PENDING = () => new AppError(409, 'APPROVAL_ALREADY_PENDING', '이미 감독관 승인을 기다리는 접속 요청이 있습니다.');
const INVALID_STATE = () => new AppError(409, 'INVALID_STATE', '현재 상태에서는 처리할 수 없는 요청입니다.');

const TERMINAL = new Set(['SUBMITTED', 'TERMINATED', 'REJECTED']);
/** 거절된 중복 접속 요청 표시: pendingTokenHash를 이 접두어 + 원래 해시로 바꿔 두면, 대기 중이던 브라우저가 폴링할 때 "거절됨"을 알 수 있다. */
const REJECTED_PREFIX = 'rejected:';

// ───────────────────────── 입장 실패 한도 ─────────────────────────

export interface EntryGuardOptions extends Partial<RateLimiterOptions> {
  /** 같은 IP에서 줄 서서 기다릴 수 있는 확인 요청 수 상한 (넘으면 바로 429). 기본 200 */
  maxQueued?: number;
}

export interface EntryGuard {
  /**
   * 이 IP의 비밀번호·명단 확인 `verify`를 "IP당 한 번에 하나씩" 실행한다.
   * 이미 한도를 넘었으면 verify(DB 조회)를 실행하지 않고 429를 던진다. verify가 ENTRY_FAILED로 실패하면 실패를 센다(성공은 세지 않는다).
   */
  run<T>(ip: string | undefined, res: Response, verify: () => Promise<T>): Promise<T>;
  /** guard.run 밖에서 난 ENTRY_FAILED(예: 토큰만으로 통과한 뒤 경쟁으로 실패)도 실패로 센다. */
  fail(ip: string | undefined): void;
}

/**
 * 기본: IP(IPv6는 /64)당 1분에 실패 10회(SPEC 2.4·F-07). 로그인 제한기와 별도 인스턴스다.
 * 주의: 교실 학생 전원이 같은 NAT 공인 IP일 수 있다. 그래서 정상 입장 성공은 세지 않고 "실패"만 센다.
 * 한 교실에서 비밀번호를 잘못 친 학생이 10번 넘게 몰리면 그 교실이 1분간 막힐 수 있다(수용한 위험).
 * 상태는 프로세스 메모리에 있다(서버 1대 가정). 테스트에서 코드로만 설정을 주입하며, 운영에서 끄는 환경변수는 없다.
 */
export function createEntryGuard(options: EntryGuardOptions = {}): EntryGuard {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 10, maxKeys: 10_000, ...options });
  const maxQueued = options.maxQueued ?? 200;
  const tails = new Map<string, Promise<void>>();
  const queued = new Map<string, number>();

  const tooMany = (res: Response, retryAfterSec: number) => {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSec))));
    return new AppError(429, 'TOO_MANY_ATTEMPTS', '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  };

  return {
    fail(ip) {
      limiter.hit(normalizeIpKey(ip));
    },
    async run(ip, res, verify) {
      const key = normalizeIpKey(ip);
      // 1) 메모리 조회만으로 거절(DB 없음)
      const pre = limiter.check(key);
      if (!pre.allowed) throw tooMany(res, pre.retryAfterSec);
      const waiting = queued.get(key) ?? 0;
      if (waiting >= maxQueued) throw tooMany(res, 1);

      // 2) 같은 IP의 확인을 한 줄로 세운다
      queued.set(key, waiting + 1);
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const tail = prev.then(() => mine);
      tails.set(key, tail);
      const finish = () => {
        release();
        const left = (queued.get(key) ?? 1) - 1;
        if (left <= 0) {
          queued.delete(key);
          if (tails.get(key) === tail) tails.delete(key);
        } else queued.set(key, left);
      };

      await prev;
      try {
        // 내 차례에 다시 확인: 앞선 요청들이 실패로 한도를 채웠을 수 있다
        const now = limiter.check(key);
        if (!now.allowed) throw tooMany(res, now.retryAfterSec);
        try {
          return await verify();
        } catch (err) {
          if (err instanceof AppError && err.code === 'ENTRY_FAILED') limiter.hit(key);
          throw err;
        }
      } finally {
        finish();
      }
    },
  };
}

// ───────────────────────── 자격 확인 ─────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest();
/** 시험 비밀번호가 없는(있을 수 없는) 경우에도 같은 비교를 하기 위한 무작위 값 */
const DUMMY = randomBytes(8).toString('hex');

/** 길이가 달라도 안전한 상수 시간 비교: 양쪽을 SHA-256(고정 32바이트)으로 만든 뒤 timingSafeEqual */
function passcodeMatches(given: string, actual: string | null): boolean {
  const eq = timingSafeEqual(sha(given), sha(actual ?? DUMMY));
  return eq && actual !== null;
}

export interface EntryInput {
  examCode: string;
  studentNo: string;
  passcode: string;
}

export interface Verified {
  exam: Exam;
  roster: RosterEntry;
  /** 비밀번호로 확인되었는가(false면 유효한 토큰 소지로 확인된 것) */
  viaPasscode: boolean;
}

/**
 * 시험 상태(OPEN/RUNNING) → 비밀번호 → 명단 학번 (SPEC F-07).
 * DRAFT/ENDED는 403 EXAM_NOT_ENTERABLE: 시험 코드는 비밀이 아니며 상태는 공개 API(/api/public/exams/:code)로도 이미 보인다.
 * 이 구분은 비밀번호 추측에 쓸 정보를 주지 않으므로(DRAFT는 비밀번호가 아직 없다) 실패 횟수에 세지 않는다.
 * 없는 코드·명단 밖 학번·틀린 비밀번호는 같은 401이고, 비밀번호 비교는 항상 수행한다.
 * `token`(세션 또는 대기 토큰)이 이 학생의 응시와 맞으면 비밀번호 없이도 통과한다(비밀번호를 재발급해도 이어하기·승인 대기 확인이 되도록).
 */
export async function verifyEntry(input: EntryInput, token?: string): Promise<Verified> {
  const exam = await prisma.exam.findUnique({ where: { examCode: input.examCode.toUpperCase() } });
  if (exam && (exam.status === 'DRAFT' || exam.status === 'ENDED')) throw NOT_ENTERABLE();
  const roster = exam ? await prisma.rosterEntry.findUnique({ where: { examId_studentNo: { examId: exam.id, studentNo: input.studentNo } } }) : null;
  const passOk = passcodeMatches(input.passcode, exam?.passcode ?? null);

  let tokenOk = false;
  if (exam && roster && token) {
    const attempt = await prisma.attempt.findUnique({ where: { rosterEntryId: roster.id }, select: { sessionTokenHash: true, pendingTokenHash: true } });
    if (attempt) {
      const h = hashToken(token);
      tokenOk = h === attempt.sessionTokenHash || h === attempt.pendingTokenHash || attempt.pendingTokenHash === REJECTED_PREFIX + h;
    }
  }
  if (!exam || !roster || !(passOk || tokenOk)) throw ENTRY_FAILED();
  return { exam, roster, viaPasscode: passOk };
}

// ───────────────────────── 응시 화면용 값 ─────────────────────────

/** 학생에게 보내는 응시 상태. 해시·비밀번호·정답은 절대 넣지 않는다. */
export function studentAttemptView(attempt: Attempt, exam: Pick<Exam, 'endsAt'>) {
  return { ...attemptStatePayload(attempt, exam), needs: { consent: attempt.consentAt === null, env: attempt.envCheckedAt === null } };
}

// ───────────────────────── confirm ─────────────────────────

export type ConfirmResult =
  | { kind: 'session'; sessionToken: string; attempt: ReturnType<typeof studentAttemptView> & { id: string } }
  | { kind: 'pending'; pendingToken?: string };

type Post = (() => void | Promise<void>)[];

/** 커밋이 끝난 뒤의 실시간 알림. Socket.IO가 없으면(테스트 등) 건너뛰고, 실패해도 확정된 변경을 되돌리지 않는다. */
async function notifyAll(post: Post): Promise<void> {
  try {
    getIo();
  } catch {
    return;
  }
  for (const send of post) {
    try {
      await send();
    } catch (err) {
      console.error('실시간 알림 전송 실패', err);
    }
  }
}

/**
 * 같은 시험의 confirm을 이 프로세스 안에서 한 줄로 세운다. DB 잠금(FOR UPDATE)만 쓰면 기다리는 요청마다 DB 연결을 붙잡고 있어
 * 교실 단위 동시 입장(수십 명)에서 연결 풀이 바닥나 수 초씩 지연된다. 줄은 메모리에서 서고, 정확성은 여전히 DB 잠금이 보장한다
 * (서버가 여러 대여도 안전). 키 수는 동시에 입장 중인 시험 수로 제한되고, 줄이 비면 항목을 지운다.
 */
const examChains = new Map<string, Promise<unknown>>();
async function inExamQueue<T>(examId: string, fn: () => Promise<T>): Promise<T> {
  const prev = examChains.get(examId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  examChains.set(examId, tail);
  try {
    return await run;
  } finally {
    if (examChains.get(examId) === tail) examChains.delete(examId);
  }
}

/** 줄 세우기 없이 한 번 실행한다(DB 잠금만으로의 안전성을 테스트하려고 export). 라우트는 confirmEntry를 쓴다. */
export async function confirmOnce(verified: Verified, token: string | undefined): Promise<{ result: ConfirmResult; post: Post }> {
  const { roster, viaPasscode } = verified;
  const h = token ? hashToken(token) : null;
  const post: Post = [];

  const result = await runExamTx(async (tx): Promise<ConfirmResult> => {
    // 시험 행을 잠가 같은 시험의 입장·승인·시작·종료가 한 줄로 처리된다.
    const { status } = await lockExam(tx, verified.exam.id);
    if (status !== 'OPEN' && status !== 'RUNNING') throw NOT_ENTERABLE();
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: verified.exam.id } });
    const attempt = await tx.attempt.findUnique({ where: { rosterEntryId: roster.id } });

    if (!attempt) {
      // 응시 없음: 새로 만든다. 토큰 소지만으로 확인된 요청이라면 여기까지 올 수 없다(토큰이 맞는 응시가 있어야 하므로).
      if (!viaPasscode) throw ENTRY_FAILED();
      let state: 'WAITING' | 'PENDING_APPROVAL';
      if (status === 'OPEN') state = 'WAITING';
      else if (exam.lockNewEntry) throw ENTRY_CLOSED(); // 신규 응시 생성에만 적용
      else state = 'PENDING_APPROVAL';

      const questions = await tx.question.findMany({ where: { examId: exam.id }, orderBy: { position: 'asc' }, select: { id: true, type: true, choices: true } });
      const orders = buildOrders(
        questions.map((q) => ({ id: q.id, type: q.type, choices: Array.isArray(q.choices) ? (q.choices as { id: string }[]) : null })),
        exam.shuffle,
      );
      const sessionToken = generateToken();
      const created = await tx.attempt.create({
        data: {
          examId: exam.id,
          rosterEntryId: roster.id,
          state,
          isLate: state === 'PENDING_APPROVAL',
          sessionTokenHash: hashToken(sessionToken),
          questionOrder: orders.questionOrder,
          choiceOrders: orders.choiceOrders,
        },
      });
      post.push(() => (state === 'PENDING_APPROVAL' ? broadcast.toStaff(exam.id, 'approval:pending', { attemptId: created.id, kind: 'LATE' }) : broadcast.waitingCount(exam.id)));
      return { kind: 'session', sessionToken, attempt: { id: created.id, ...studentAttemptView(created, exam) } };
    }

    // 응시 있음 + 같은 토큰: 이어하기(새 토큰을 만들지 않고 받은 토큰을 그대로 돌려준다). 종료된 응시도 종료 화면을 볼 수 있다.
    if (token && h === attempt.sessionTokenHash) {
      return { kind: 'session', sessionToken: token, attempt: { id: attempt.id, ...studentAttemptView(attempt, exam) } };
    }
    // 종료·제출·거절된 응시에는 새 세션도 승인 요청도 만들지 않는다(승인해도 끝난 응시를 이어받게 되므로).
    if (TERMINAL.has(attempt.state)) throw ATTEMPT_FINISHED();
    // 승인 대기 중인 같은 브라우저의 폴링
    if (h && attempt.pendingTokenHash === h) return { kind: 'pending' };
    if (h && attempt.pendingTokenHash === REJECTED_PREFIX + h) throw ENTRY_REJECTED();

    // 다른 토큰·토큰 없음: 중복 접속 요청. 토큰 소지로만 확인된 요청은 여기까지 올 수 없지만 방어한다.
    if (!viaPasscode) throw ENTRY_FAILED();
    // 이미 대기 요청이 있으면(거절 표시가 아닌 값) 덮어쓰지 않는다: 비밀번호만 아는 다른 학생이 진짜 사용자의 대기 요청을
    // 가로채 감독관 승인을 자기 토큰으로 넘기거나, 성공 경로로 감독관 알림을 무제한 만드는 것을 막는다.
    // 대기 토큰 소지자는 위에서 이미 폴링으로 처리되었다. DB 쓰기·알림 없이 거절한다.
    if (attempt.pendingTokenHash && !attempt.pendingTokenHash.startsWith(REJECTED_PREFIX)) throw ALREADY_PENDING();
    const pendingToken = generateToken();
    await tx.attempt.update({ where: { id: attempt.id }, data: { pendingTokenHash: hashToken(pendingToken) } });
    post.push(() => broadcast.toStaff(exam.id, 'approval:pending', { attemptId: attempt.id, kind: 'DUPLICATE' }));
    return { kind: 'pending', pendingToken };
  });
  return { result, post };
}

/** 본인 확인 완료(P-02 [맞습니다]) 및 폴링. Attempt.rosterEntryId @unique + 시험 행 잠금으로 응시가 둘 생기지 않는다. */
export async function confirmEntry(verified: Verified, token: string | undefined): Promise<ConfirmResult> {
  let out: { result: ConfirmResult; post: Post };
  try {
    out = await inExamQueue(verified.exam.id, () => confirmOnce(verified, token));
  } catch (err) {
    // 잠금으로 이미 막히지만, 그래도 유니크 위반이 나면 이미 만들어진 응시를 다시 읽어 이어하기·중복 접속 경로로 처리한다.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') out = await inExamQueue(verified.exam.id, () => confirmOnce(verified, token));
    else throw err;
  }
  await notifyAll(out.post);
  return out.result;
}

// ───────────────────────── 승인 처리(F-14) ─────────────────────────

export const APPROVAL_TYPES = ['APPROVE_ENTRY', 'REJECT_ENTRY', 'APPROVE_SESSION', 'REJECT_SESSION'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export interface ApprovalInput {
  attemptId: string;
  staffId: string;
  type: ApprovalType;
  reason: string;
}

/**
 * 승인·거절. 시험 행과 응시를 잠근 트랜잭션 안에서 상태를 확인하고, 응시 변경과 ProctorAction 기록을 한 번에 커밋한다.
 * approval:resolved·session:revoked는 커밋 뒤에 보낸다.
 */
export async function resolveApproval(input: ApprovalInput): Promise<Attempt> {
  const found = await prisma.attempt.findUnique({ where: { id: input.attemptId }, select: { examId: true } });
  if (!found) throw NOT_FOUND_ATTEMPT();
  const isEntry = input.type === 'APPROVE_ENTRY' || input.type === 'REJECT_ENTRY';
  const approved = input.type === 'APPROVE_ENTRY' || input.type === 'APPROVE_SESSION';

  const { updated, exam } = await runExamTx(async (tx) => {
    await lockExam(tx, found.examId);
    const attempt = await tx.attempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt) throw NOT_FOUND_ATTEMPT();
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: found.examId } });

    let updated: Attempt;
    if (isEntry) {
      if (attempt.state !== 'PENDING_APPROVAL') throw INVALID_STATE();
      const next = nextState(attempt.state, approved ? 'APPROVE' : 'REJECT', { ready: false, examRunning: exam.status === 'RUNNING' });
      updated = await tx.attempt.update({ where: { id: attempt.id }, data: { state: next } });
    } else {
      const pending = attempt.pendingTokenHash;
      if (!pending || pending.startsWith(REJECTED_PREFIX) || TERMINAL.has(attempt.state)) throw INVALID_STATE();
      updated = await tx.attempt.update({
        where: { id: attempt.id },
        data: approved ? { sessionTokenHash: pending, pendingTokenHash: null } : { pendingTokenHash: REJECTED_PREFIX + pending },
      });
    }
    await tx.proctorAction.create({ data: { attemptId: attempt.id, staffId: input.staffId, type: input.type, reason: input.reason, payload: {} } });
    return { updated, exam };
  });

  await notifyAll([
    () => broadcast.toStaff(exam.id, 'approval:resolved', { attemptId: updated.id, kind: isEntry ? 'LATE' : 'DUPLICATE', approved }),
    ...(isEntry ? [() => broadcast.attemptState(updated, exam), () => broadcast.waitingCount(exam.id)] : []),
    // 기존 토큰은 DB에서 이미 무효다. 여기서는 기존 소켓에 session:revoked를 보내고 연결을 끊는다.
    ...(input.type === 'APPROVE_SESSION' ? [() => broadcast.revokeSession(updated.id)] : []),
  ]);
  return updated;
}
