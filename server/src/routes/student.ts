import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { findAttemptByToken } from '../auth/studentSession';
import { prisma } from '../db';
import { AppError } from '../errors';
import { confirmEntry, createEntryGuard, studentAttemptView, verifyEntry, type EntryGuardOptions } from '../services/entry';
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

  return router;
}
