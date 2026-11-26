import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { clearStaffCookie, getJwtSecret, hashPassword, requireStaff, setStaffCookie, verifyPassword } from '../auth/staffAuth';
import { prisma } from '../db';
import { AppError } from '../errors';

const loginSchema = z.object({
  email: z.string().max(254),
  password: z.string().min(1).max(128),
});

// 없는 이메일에도 bcrypt 비교를 한 번 하게 해서 "계정이 있는가"가 응답 시간으로 드러나는 것을 줄인다.
// 어떤 비밀번호와도 일치하지 않는 임의 해시(cost 10)다.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-never-matches-' + Math.random());
  return dummyHash;
}

const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');

/** Express 4는 async 핸들러의 오류를 잡지 못하므로 next로 넘긴다. */
function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createStaffRouter(): Router {
  getJwtSecret(); // 서버 시작(앱 생성) 때 비밀키 설정이 잘못되었으면 바로 실패시킨다.
  const router = Router();

  router.post(
    '/login',
    wrap(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
      const email = parsed.data.email.trim().toLowerCase();

      const staff = await prisma.staff.findUnique({ where: { email } });
      const passwordOk = await verifyPassword(parsed.data.password, staff?.passwordHash ?? (await getDummyHash()));
      if (!staff || !passwordOk) throw INVALID_CREDENTIALS();

      setStaffCookie(res, staff.id);
      res.json({ staff: { id: staff.id, name: staff.name, email: staff.email } });
    }),
  );

  // 이미 만료되었거나 쿠키가 없는 상태에서도 로그아웃 화면이 막히지 않도록 인증 없이 쿠키를 지운다(멱등).
  router.post('/logout', (_req, res) => {
    clearStaffCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireStaff, (req, res) => {
    const { id, name, email } = req.staff!;
    res.json({ staff: { id, name, email } });
  });

  return router;
}
