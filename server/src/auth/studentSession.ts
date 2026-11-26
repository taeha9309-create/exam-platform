import { createHash, randomBytes } from 'node:crypto';
import type { Attempt, Exam } from '@prisma/client';
import { prisma } from '../db';

/** 세션 토큰의 최대 길이. 생성 토큰은 43자(base64url 32바이트)이므로 이보다 긴 값은 해시하지 않고 거부한다. */
const MAX_TOKEN_LENGTH = 128;

/** 학생 세션 토큰 생성: 암호학적 난수 32바이트(256비트)를 base64url로. 원문은 학생 브라우저에만 보낸다(ADR-005). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 서버에는 토큰의 SHA-256 해시(hex)만 저장한다. 원문을 로그·DB에 남기지 않는다. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 토큰으로 응시를 찾는다. 없거나 형식이 틀리면 null.
 * 토큰 자체를 비교하지 않고 sha256 해시를 DB 유니크 인덱스의 조회 키로 쓰므로, 비교 시간으로 토큰을 알아내는
 * 타이밍 공격(상수 시간 비교 문제)이 성립하지 않는다. 토큰은 256비트 난수라 해시를 추측할 수도 없다.
 */
export async function findAttemptByToken(token: unknown): Promise<(Attempt & { exam: Exam }) | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  return prisma.attempt.findUnique({ where: { sessionTokenHash: hashToken(token) }, include: { exam: true } });
}
