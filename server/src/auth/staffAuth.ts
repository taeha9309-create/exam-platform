import { compare, hash } from 'bcryptjs';
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { AppError } from '../errors';

export const STAFF_COOKIE = 'staff_token';
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12시간(ADR-004)
const BCRYPT_COST = 10;
const MIN_PROD_SECRET_LENGTH = 32;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** requireStaff를 통과한 요청에만 있다. */
      staff?: { id: string; name: string; email: string };
    }
  }
}

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, BCRYPT_COST);
}

export function verifyPassword(pw: string, passwordHash: string): Promise<boolean> {
  return compare(pw, passwordHash);
}

/**
 * 서명 비밀키. 없으면 기본값으로 조용히 동작하지 않고 오류를 낸다.
 * 운영(NODE_ENV=production)에서는 32자 이상이어야 한다. 개발·테스트는 .env.example의 짧은 개발용 값을 허용한다.
 * 오류 메시지에는 비밀키 값을 넣지 않는다.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
  if (process.env.NODE_ENV === 'production' && secret.length < MIN_PROD_SECRET_LENGTH) {
    throw new Error(`운영 환경의 JWT_SECRET은 ${MIN_PROD_SECRET_LENGTH}자 이상이어야 합니다.`);
  }
  return secret;
}

/** 알고리즘을 HS256으로 고정하고, 페이로드에는 subject(staffId)만 넣는다. */
export function signStaffToken(staffId: string): string {
  return jwt.sign({}, getJwtSecret(), { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS, subject: staffId });
}

/** 위조·변조·만료·다른 키·다른 알고리즘(alg none 포함)은 모두 null. 비밀키 설정 오류만 예외로 던진다. */
export function verifyStaffToken(token: string): { staffId: string } | null {
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub === '') return null;
    return { staffId: payload.sub };
  } catch {
    return null;
  }
}

/** 로그인 쿠키와 로그아웃(삭제) 쿠키가 같은 속성을 쓰도록 한 곳에서 만든다. Secure는 운영에서만. */
export function staffCookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' };
}

export function setStaffCookie(res: Response, staffId: string): void {
  res.cookie(STAFF_COOKIE, signStaffToken(staffId), { ...staffCookieOptions(), maxAge: TOKEN_TTL_SECONDS * 1000 });
}

export function clearStaffCookie(res: Response): void {
  res.clearCookie(STAFF_COOKIE, staffCookieOptions());
}

export interface AuthenticatedStaff {
  id: string;
  name: string;
  email: string;
}

/**
 * 교수자 인증의 단일 구현(HTTP requireStaff와 Socket.IO가 함께 쓴다).
 * raw(쿠키 값, 타입 미확인) → 문자열인지 검사 → HS256 서명·만료 검증 → DB에서 교수자 재조회(삭제된 계정은 거부).
 * 실패하면 null. 비밀키 설정 오류나 DB 오류만 예외로 던진다.
 */
export async function authenticateStaff(raw: unknown): Promise<AuthenticatedStaff | null> {
  const verified = typeof raw === 'string' ? verifyStaffToken(raw) : null;
  if (!verified) return null;
  return prisma.staff.findUnique({ where: { id: verified.staffId }, select: { id: true, name: true, email: true } });
}

/**
 * 교수자 전용 API 보호. 토큰은 쿠키로만 받고(헤더·쿼리·본문 무시),
 * 토큰이 유효해도 DB에서 교수자를 다시 조회한다(삭제된 계정은 거부).
 */
export const requireStaff: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  authenticateStaff(req.cookies?.[STAFF_COOKIE])
    .then((staff) => {
      if (!staff) return next(new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다.'));
      req.staff = staff;
      next();
    })
    .catch(next);
};
