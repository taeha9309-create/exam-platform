import type { Response } from 'express';
import { AppError } from '../errors';
import { createConcurrencyLimiter, createRateLimiter, type ConcurrencyLimiter, type RateLimiter } from './rateLimit';

/**
 * 교수자 로그인 보호(보안 후속 #36). 세 겹이다.
 *  1) IP별 분당 시도 한도(성공·실패·입력 오류 모두 센다)
 *  2) IP+이메일 조합별 실패 한도(없는 이메일도 똑같이 센다 → 사용자 열거 불가)
 *  3) bcrypt 동시 실행 상한(CPU 독점으로 시험 중 다른 요청이 느려지는 것 방지)
 *
 * 계정 자체를 잠그지 않는다: 한도는 (IP)·(IP+이메일) 기준이라 공격자가 다른 IP에서 시도해도 교수자는 로그인할 수 있다.
 * 상태는 프로세스 메모리에 있다(서버 1대 가정. 재시작하면 초기화된다).
 * 운영에서 보호를 끄는 환경변수는 일부러 만들지 않았다. 설정은 테스트에서 코드로만 주입한다.
 */

export interface LoginProtectionOptions {
  /** 시계(ms). 테스트용 */
  now?: () => number;
  /** IP별 한도. 기본 1분에 20회 */
  ip?: { windowMs: number; max: number };
  /** IP+이메일별 실패 한도. 기본 15분에 5회 */
  account?: { windowMs: number; max: number };
  /** 동시에 실행할 수 있는 비밀번호 검증(bcrypt) 수. 기본 2 */
  maxConcurrentVerifications?: number;
  /** 한도별로 기억하는 키 수 상한. 기본 10000 */
  maxKeys?: number;
}

export interface LoginProtection {
  /** 1단계: 이 IP의 시도를 센다. 한도 초과면 429 오류를 던진다(입력 검증보다 먼저 호출) */
  admitIp(ip: string | undefined, res: Response): void;
  /** 2단계: 이 IP+이메일 조합이 막혀 있으면 429 오류를 던진다. email은 정규화된 값 */
  admitAccount(ip: string | undefined, email: string, res: Response): void;
  /** 3단계: bcrypt 슬롯을 얻는다. 가득 차면 429 오류를 던진다. 반환된 release는 finally에서 호출한다 */
  acquireVerifySlot(res: Response): () => void;
  recordFailure(ip: string | undefined, email: string): void;
  recordSuccess(ip: string | undefined, email: string): void;
}

/** 세 가지 거절이 모두 같은 코드·같은 문구다(어떤 제한인지, 횟수가 얼마인지 드러내지 않는다). */
function tooManyAttempts(res: Response, retryAfterSec: number): AppError {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSec))));
  return new AppError(429, 'TOO_MANY_ATTEMPTS', '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
}

// IP가 없을 때(비정상)는 하나의 키로 묶어 한도를 더 엄격하게 적용한다.
const ipKey = (ip: string | undefined) => ip ?? 'unknown';
// 이메일에는 줄바꿈 등 제어 문자가 입력 검증에서 걸러지므로 '\n' 구분자가 모호해지지 않는다.
const accountKey = (ip: string | undefined, email: string) => `${ipKey(ip)}\n${email}`;

export function createLoginProtection(options: LoginProtectionOptions = {}): LoginProtection {
  const maxKeys = options.maxKeys ?? 10_000;
  const ipLimiter: RateLimiter = createRateLimiter({ ...(options.ip ?? { windowMs: 60_000, max: 20 }), maxKeys, now: options.now });
  const accountLimiter: RateLimiter = createRateLimiter({ ...(options.account ?? { windowMs: 15 * 60_000, max: 5 }), maxKeys, now: options.now });
  const verifySlots: ConcurrencyLimiter = createConcurrencyLimiter(options.maxConcurrentVerifications ?? 2);

  return {
    admitIp(ip, res) {
      const r = ipLimiter.hit(ipKey(ip));
      if (!r.allowed) throw tooManyAttempts(res, r.retryAfterSec);
    },
    admitAccount(ip, email, res) {
      const r = accountLimiter.check(accountKey(ip, email));
      if (!r.allowed) throw tooManyAttempts(res, r.retryAfterSec);
    },
    acquireVerifySlot(res) {
      const release = verifySlots.tryAcquire();
      if (!release) throw tooManyAttempts(res, 1);
      return release;
    },
    recordFailure(ip, email) {
      accountLimiter.hit(accountKey(ip, email));
    },
    recordSuccess(ip, email) {
      accountLimiter.reset(accountKey(ip, email));
    },
  };
}
