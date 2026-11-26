import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors';

/**
 * CSRF 방어: 상태를 바꾸는 /api 요청(GET·HEAD·OPTIONS 제외)은 요청을 보낸 페이지의 출처(Origin, 없으면 Referer)가
 * 서버 자신의 출처와 같아야 한다. 로그인 쿠키는 SameSite=Lax라 교차 사이트 POST에는 붙지 않지만,
 * 같은 사이트의 다른 서브도메인이나 본문이 없는 상태 변경 POST(시험 시작·종료·조치)까지 쿠키만으로 막기에는 부족해 겹쳐서 둔다.
 *
 * 규칙(반드시 지킬 것): GET·HEAD·OPTIONS 요청은 검사하지 않는다. 따라서 **상태를 바꾸는 GET 라우트를 만들지 않는다.**
 *
 * - Origin 헤더가 있으면 그것만 본다. 없으면 Referer의 출처를 본다. 둘 다 없으면 허용한다
 *   (브라우저는 교차 출처 POST에 Origin을 항상 붙이므로, 헤더가 없는 요청은 브라우저가 아닌 클라이언트(curl·테스트)로 본다.
 *   이런 요청은 사용자의 쿠키를 자동으로 싣고 오는 CSRF 공격이 될 수 없다).
 * - 자기 출처는 `${req.protocol}://${host 헤더}`다. app.set('trust proxy')가 켜져 있으면 req.protocol이 X-Forwarded-Proto를 따른다.
 * - 비교는 문자열 전체 일치(스킴·호스트·포트)다. 접두사·부분 일치를 쓰지 않아 exam.example.evil.com 같은 도메인으로 우회되지 않는다.
 * - 환경변수 ALLOWED_ORIGINS(쉼표 구분, 선택)에 적은 출처도 허용한다. 개발 중 Vite(http://localhost:5173)가 /api를 백엔드(localhost:3000)로
 *   프록시하면 브라우저 Origin(5173)과 백엔드가 보는 Host(3000)가 달라지므로 ALLOWED_ORIGINS=http://localhost:5173 로 허용한다.
 *   운영에서는 같은 출처로 화면을 제공하므로 설정하지 않는다. 값은 요청마다 읽는다.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** URL의 출처(소문자 스킴://호스트[:기본 포트 생략]). 형식이 잘못되었거나 출처가 없으면(null 등) null */
function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.origin === 'null') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  for (const part of (process.env.ALLOWED_ORIGINS ?? '').split(',')) {
    const o = originOf(part.trim());
    if (o) out.add(o);
  }
  return out;
}

export function originCheck(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');
  if (originHeader === undefined && refererHeader === undefined) return next();

  const requestOrigin = originHeader !== undefined ? originOf(originHeader) : originOf(refererHeader as string);
  const host = req.get('host');
  const self = host ? originOf(`${req.protocol}://${host}`) : null;

  if (requestOrigin && (requestOrigin === self || allowedOrigins().has(requestOrigin))) return next();
  next(new AppError(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 출처의 요청입니다.'));
}
