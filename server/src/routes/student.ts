import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { findAttemptByToken } from '../auth/studentSession';
import { prisma } from '../db';
import { attemptDeadline } from '../domain/deadline';
import { AppError } from '../errors';
import { lockExam, runExamTx } from '../services/examLifecycle';
import { submitAttempt } from '../services/submission';
import { confirmEntry, createEntryGuard, recordConsent, recordEnv, studentAttemptView, verifyEntry, type EntryGuardOptions } from '../services/entry';
import { safeString } from '../validation';

const MAX_TOKEN_LENGTH = 128;
const INVALID_INPUT = () => new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
const UNAUTHORIZED = () => new AppError(401, 'UNAUTHORIZED', '인증이 필요합니다.');

/** 모든 필드는 문자열·길이 상한·제어 문자 없음. 객체·배열·숫자는 400. */
const entrySchema = z.object({
  examCode: safeString({ min: 1, max: 16 }),
  studentNo: safeString({ min: 1, max: 32 }),
  passcode: safeString({ min: 1, max: 64 }),
});
const confirmSchema = entrySchema.extend({ sessionToken: safeString({ min: 0, max: MAX_TOKEN_LENGTH }).optional() });

/** 설문: 난이도 1~5 정수, 의견 ≤1000자(줄바꿈 허용). 둘 다 선택이며 추가 필드(응시 ID 등)는 거부한다. */
const surveySchema = z.strictObject({
  difficulty: z.number().int().min(1).max(5).optional(),
  comment: safeString({ min: 0, max: 1000, allowNewlines: true }).optional(),
});

const consentSchema = z.strictObject({ agree: z.boolean() });
const envSchema = z.strictObject({ browser: z.enum(['chrome', 'edge']), isExtended: z.boolean(), fullscreen: z.literal(true) });

function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** requireStudent를 통과한 요청에만 있다. */
      studentAttempt?: NonNullable<Awaited<ReturnType<typeof findAttemptByToken>>>;
    }
  }
}

/**
 * 학생 인증: Authorization: Bearer <세션 토큰>만 본다(쿠키·쿼리·본문은 무시).
 * 세션 토큰(sessionTokenHash)만 통과하고 승인 대기 중인 pendingToken은 통과하지 못한다.
 */
export const requireStudent: RequestHandler = (req, _res, next) => {
  const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
  findAttemptByToken(m?.[1])
    .then((attempt) => {
      if (!attempt) return next(UNAUTHORIZED());
      req.studentAttempt = attempt;
      next();
    })
    .catch(next);
};

export interface StudentRouterOptions {
  /** 입장 실패 한도 설정(테스트용). 생략하면 IP당 1분 10회 실패 */
  entryLimit?: EntryGuardOptions;
}

/** `/api`에 마운트한다: /public/exams/:examCode, /student/entry, /student/confirm, /student/attempt */
export function createStudentRouter(options: StudentRouterOptions = {}): Router {
  // entry와 confirm은 모두 비밀번호를 확인하므로 하나의 한도를 공유한다(둘로 나누면 한도가 두 배가 된다).
  const guard = createEntryGuard(options.entryLimit);
  const router = Router();

  router.get(
    '/public/exams/:examCode',
    wrap(async (req, res) => {
      const code = String(req.params.examCode ?? '');
      const exam = /^[A-Za-z0-9]{1,16}$/.test(code) ? await prisma.exam.findUnique({ where: { examCode: code.toUpperCase() }, select: { title: true, status: true } }) : null;
      if (!exam) throw new AppError(404, 'NOT_FOUND', '시험을 찾을 수 없습니다.');
      res.json({ title: exam.title, status: exam.status });
    }),
  );

  router.post(
    '/student/entry',
    wrap(async (req, res) => {
      const parsed = entrySchema.safeParse(req.body);
      if (!parsed.success) throw INVALID_INPUT();
      const input = { ...parsed.data, studentNo: parsed.data.studentNo.trim(), passcode: parsed.data.passcode.trim() };
      // IP는 req.ip만 쓴다(trust proxy를 켠 경우에만 프록시 헤더가 반영된다).
      const { roster } = await guard.run(req.ip, res, () => verifyEntry(input));
      res.json({ name: roster.name });
    }),
  );

  router.post(
    '/student/confirm',
    wrap(async (req, res) => {
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) throw INVALID_INPUT();
      const { sessionToken, ...rest } = parsed.data;
      const token = sessionToken || undefined;
      const input = { ...rest, studentNo: rest.studentNo.trim(), passcode: rest.passcode.trim() };
      const verified = await guard.run(req.ip, res, () => verifyEntry(input, token));
      let out;
      try {
        out = await confirmEntry(verified, token);
      } catch (err) {
        // 토큰만으로 통과한 요청이 경쟁(승인·거절 직후)으로 ENTRY_FAILED가 되어도 실패 한도에 센다.
        if (err instanceof AppError && err.code === 'ENTRY_FAILED') guard.fail(req.ip);
        throw err;
      }
      if (out.kind === 'session') res.json({ sessionToken: out.sessionToken, attempt: out.attempt });
      else res.json({ status: 'DUPLICATE_PENDING', ...(out.pendingToken ? { pendingToken: out.pendingToken } : {}) });
    }),
  );

  router.get('/student/attempt', requireStudent, (req, res) => {
    const attempt = req.studentAttempt!;
    res.json(studentAttemptView(attempt, attempt.exam));
  });

  // 동의·환경 점검: 학생 세션 토큰 필수. 인증된 학생의 멱등한 쓰기라 별도 빈도 제한은 두지 않는다
  // (값이 같으면 DB 쓰기·알림이 없고, MULTI_MONITOR 신호는 응시당 1건).
  router.post(
    '/student/consent',
    requireStudent,
    wrap(async (req, res) => {
      const parsed = consentSchema.safeParse(req.body);
      if (!parsed.success) throw INVALID_INPUT();
      res.json(await recordConsent(req.studentAttempt!, parsed.data.agree));
    }),
  );

  router.post(
    '/student/env',
    requireStudent,
    wrap(async (req, res) => {
      const parsed = envSchema.safeParse(req.body);
      if (!parsed.success) throw INVALID_INPUT();
      res.json(await recordEnv(req.studentAttempt!, { browser: parsed.data.browser, isExtended: parsed.data.isExtended }));
    }),
  );

  // 응시 화면용 문항·답안. ACTIVE이고 마감 전일 때만(SPEC F-11). 정답(correctChoiceId)·채점 결과·비밀값은 절대 내려주지 않는다.
  // 응답은 허용 목록(allow-list)으로 필드를 직접 조립한다(DB 행을 그대로 넘기지 않는다).
  router.get(
    '/student/exam',
    requireStudent,
    wrap(async (req, res) => {
      const attempt = req.studentAttempt!;
      const deadline = attempt.exam.endsAt ? attemptDeadline(attempt.exam.endsAt, attempt.extraSeconds) : null;
      if (attempt.state !== 'ACTIVE' || attempt.exam.status !== 'RUNNING' || !deadline || Date.now() >= deadline.getTime()) {
        throw new AppError(403, 'NOT_ACTIVE', '응시 중일 때만 문항을 볼 수 있습니다.');
      }
      const [questions, answers] = await Promise.all([
        prisma.question.findMany({ where: { examId: attempt.examId } }),
        prisma.answer.findMany({ where: { attemptId: attempt.id } }),
      ]);
      const byId = new Map(questions.map((q) => [q.id, q]));
      const questionOrder = Array.isArray(attempt.questionOrder) ? (attempt.questionOrder as unknown[]) : [];
      const choiceOrders = (typeof attempt.choiceOrders === 'object' && attempt.choiceOrders !== null && !Array.isArray(attempt.choiceOrders) ? attempt.choiceOrders : {}) as Record<string, unknown>;

      const out = [];
      for (const id of questionOrder) {
        const q = typeof id === 'string' ? byId.get(id) : undefined;
        if (!q) continue;
        if (q.type !== 'MCQ') {
          out.push({ id: q.id, type: q.type, prompt: q.prompt, points: q.points });
          continue;
        }
        const all = (Array.isArray(q.choices) ? q.choices : []) as { id: string; text: string }[];
        const choiceById = new Map(all.map((c) => [c.id, c]));
        const order = Object.hasOwn(choiceOrders, q.id) && Array.isArray(choiceOrders[q.id]) ? (choiceOrders[q.id] as unknown[]) : all.map((c) => c.id);
        const choices = order.flatMap((cid) => {
          const c = typeof cid === 'string' ? choiceById.get(cid) : undefined;
          return c ? [{ id: c.id, text: c.text }] : [];
        });
        out.push({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, choices });
      }
      res.set('Cache-Control', 'no-store');
      res.json({
        questions: out,
        answers: answers.map((a) => ({
          questionId: a.questionId,
          ...(a.choiceId !== null ? { choiceId: a.choiceId } : {}),
          ...(a.text !== null ? { text: a.text } : {}),
          rev: a.rev,
          savedAt: a.savedAt,
        })),
      });
    }),
  );

  // 학생 제출. 이미 제출됐으면 그대로 200(멱등). 시험 시작 전(WAITING)·입장 승인 대기·거절·잠김(종료) 상태는 제출할 수 없다.
  router.post(
    '/student/submit',
    requireStudent,
    wrap(async (req, res) => {
      const attempt = req.studentAttempt!;
      if (attempt.state !== 'ACTIVE' && attempt.state !== 'PAUSED' && attempt.state !== 'SUBMITTED') {
        throw new AppError(403, 'NOT_ACTIVE', '응시 중일 때만 제출할 수 있습니다.');
      }
      const done = await submitAttempt(attempt.id, 'STUDENT');
      res.json({ state: done.state, submittedAt: done.submittedAt });
    }),
  );

  // 종료 설문(F-18). 응시는 본문이 아니라 인증된 세션으로만 정한다.
  // SurveyResponse에는 응시·학번·시각을 남기지 않고(익명, D-015), 중복 방지는 Attempt.surveyDone으로만 한다.
  // 응시 행을 잠근 한 트랜잭션에서 확인·저장·표시를 하므로 동시 이중 제출에도 응답 행은 1개다.
  router.post(
    '/student/survey',
    requireStudent,
    wrap(async (req, res) => {
      const parsed = surveySchema.safeParse(req.body);
      if (!parsed.success) throw INVALID_INPUT();
      const attempt = req.studentAttempt!;
      const comment = parsed.data.comment?.trim() ?? '';
      const difficulty = parsed.data.difficulty ?? null;

      await runExamTx(async (tx) => {
        // 잠금 순서는 항상 시험 → 응시(submitAttempt·조치와 같다). 응답 INSERT의 외래키 검사가 시험 행에 KEY SHARE를 걸므로,
        // 응시 행만 먼저 잠그면 시험 행을 먼저 잠그는 쪽과 교착(40P01)이 난다.
        await lockExam(tx, attempt.examId);
        const rows = await tx.$queryRaw<{ state: string; surveyDone: boolean; sessionTokenHash: string }[]>`
          SELECT "state", "surveyDone", "sessionTokenHash" FROM "Attempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
        const cur = rows[0];
        // 인증 뒤 세션이 폐기·재발급됐다면 이 토큰은 더 이상 유효하지 않다.
        if (!cur || cur.sessionTokenHash !== attempt.sessionTokenHash) throw UNAUTHORIZED();
        if (cur.state !== 'SUBMITTED' && cur.state !== 'TERMINATED') throw new AppError(409, 'NOT_SUBMITTED', '제출이 끝난 뒤에만 설문에 응답할 수 있습니다.');
        if (cur.surveyDone) throw new AppError(409, 'ALREADY_SUBMITTED', '이미 설문에 응답했습니다.');
        // 둘 다 비어 있으면(건너뛰기) 응답 행을 만들지 않는다.
        if (difficulty !== null || comment !== '') {
          await tx.surveyResponse.create({ data: { examId: attempt.examId, difficulty, comment: comment === '' ? null : comment } });
        }
        await tx.attempt.update({ where: { id: attempt.id }, data: { surveyDone: true } });
      });
      res.json({ ok: true });
    }),
  );

  return router;
}
