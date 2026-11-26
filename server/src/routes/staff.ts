import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { clearStaffCookie, getJwtSecret, hashPassword, requireStaff, setStaffCookie, verifyPassword } from '../auth/staffAuth';
import { prisma } from '../db';
import { AppError } from '../errors';
import { createLoginProtection, type LoginProtectionOptions } from '../security/loginProtection';

// NUL(\u0000)을 포함한 제어 문자는 PostgreSQL이 문자열로 받지 못해 500과 로그 범람을 만든다 → 입력 단계에서 400으로 거른다.
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
const loginSchema = z.object({
  email: z.string().max(254).regex(NO_CONTROL_CHARS),
  // 128자는 bcrypt 입력 크기(DoS) 상한이다. bcrypt는 72바이트 뒤를 비교하지 않지만, 계정 생성 단계(create-staff)가
  // 72바이트 이하만 허용하므로 로그인에서 보안상 문제가 되지 않는다.
  password: z.string().min(1).max(128).regex(NO_CONTROL_CHARS),
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

export interface StaffRouterOptions {
  /** 로그인 시도 제한 설정. 생략하면 엄격한 기본값(IP 분당 20회, IP+이메일 15분 5회 실패, 동시 bcrypt 2건) */
  loginProtection?: LoginProtectionOptions;
}

export function createStaffRouter(options: StaffRouterOptions = {}): Router {
  getJwtSecret();
  const protection = createLoginProtection(options.loginProtection); // 서버 시작(앱 생성) 때 비밀키 설정이 잘못되었으면 바로 실패시킨다.
  // 더미 해시를 시작 시점에 미리 계산한다. 처음 쓸 때 계산하면 서버 시작 직후 없는 이메일로 첫 로그인한 요청만
  // 해시 계산이 추가되어 느려지고, 그 시간 차이로 "계정이 없다"가 드러난다.
  void getDummyHash().catch(() => undefined);
  const router = Router();

  router.post(
    '/login',
    wrap(async (req, res) => {
      // 1) IP 한도: 입력 검증보다 먼저. 잘못된 입력도 공짜가 아니다.
      protection.admitIp(req.ip, res);

      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
      const email = parsed.data.email.trim().toLowerCase();

      // 2) IP+이메일 실패 한도, 3) bcrypt 동시 상한. 둘 다 DB 조회·bcrypt보다 앞이라 거절된 요청은 비용이 거의 없다.
      protection.admitAccount(req.ip, email, res);
      const release = protection.acquireVerifySlot(res);
      try {
        const staff = await prisma.staff.findUnique({ where: { email } });
        const passwordOk = await verifyPassword(parsed.data.password, staff?.passwordHash ?? (await getDummyHash()));
        if (!staff || !passwordOk) {
          protection.recordFailure(req.ip, email); // 없는 이메일도 똑같이 센다
          throw INVALID_CREDENTIALS();
        }
        protection.recordSuccess(req.ip, email);
        setStaffCookie(res, staff.id);
        res.json({ staff: { id: staff.id, name: staff.name, email: staff.email } });
      } finally {
        release();
      }
    }),
  );

  // SPEC 7.1: 교수자 인증 필요. 인증 없이 쿠키를 지우게 하면 다른 사이트의 폼 POST만으로 시험 중인 감독관을
  // 강제 로그아웃시킬 수 있다(SameSite=Lax 쿠키는 교차 사이트 POST에 붙지 않으므로 인증을 요구하면 막힌다).
  // 쿠키 만료와 토큰 만료가 같아서 "만료 후 로그아웃이 막히는" 문제는 없다. 클라이언트는 401을 로그아웃 완료로 처리한다.
  router.post('/logout', requireStaff, (_req, res) => {
    clearStaffCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireStaff, (req, res) => {
    const { id, name, email } = req.staff!;
    res.json({ staff: { id, name, email } });
  });

  return router;
}
