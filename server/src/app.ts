import express, { type ErrorRequestHandler, type Express } from 'express';
import cookieParser from 'cookie-parser';
import { AppError } from './errors';
import { createAttemptsRouter } from './routes/attempts';
import { createExamsRouter } from './routes/exams';
import { createStudentRouter } from './routes/student';
import { createStaffRouter, type StaffRouterOptions } from './routes/staff';
import { originCheck } from './security/originCheck';
import { registerClient } from './static';

/** 오류 응답 형식은 항상 { error: { code, message } } (계획 1 공통 제약). 화면 문구는 클라이언트가 code로 매핑한다. */
export function apiError(code: string, message: string) {
  return { error: { code, message } };
}

/** 공통 오류 처리. AppError는 자신의 status·code로, 그 밖은 아래 규칙으로 응답한다. */
export const onError: ErrorRequestHandler = (err, _req, res, next) => {
  // 이미 응답이 나가기 시작했다면 다시 쓸 수 없으므로 Express 기본 처리에 맡긴다.
  if (res.headersSent) return next(err);
  if (err instanceof AppError) {
    res.status(err.status).json(apiError(err.code, err.message));
    return;
  }
  const status: number = typeof err?.status === 'number' ? err.status : 500;
  if (err?.type === 'entity.too.large') {
    res.status(413).json(apiError('PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.'));
  } else if (err?.type === 'entity.parse.failed') {
    res.status(400).json(apiError('INVALID_JSON', '요청 본문이 올바른 JSON이 아닙니다.'));
  } else if (status >= 400 && status < 500) {
    res.status(status).json(apiError('BAD_REQUEST', '잘못된 요청입니다.'));
  } else {
    // 내부 오류의 상세 내용(스택·메시지)은 응답에 노출하지 않는다.
    console.error(err);
    res.status(500).json(apiError('INTERNAL', '서버 오류가 발생했습니다.'));
  }
};

export interface AppOptions {
  /** 빌드된 화면 폴더(client/dist). 없거나 index.html이 없으면 API만 제공한다 */
  clientDist?: string;
  /** 앞단 프록시 수(Railway는 1). 설정하면 X-Forwarded-For에서 클라이언트 IP를 읽는다. 프록시가 없는데 켜면 IP를 위조당할 수 있다 */
  trustProxy?: number;
  /** 교수자 라우터 설정. 생략하면 엄격한 기본 로그인 제한이 적용된다(테스트에서만 느슨하게 주입한다) */
  staff?: StaffRouterOptions;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);

  // 기본 보안 헤더: 다른 사이트가 시험 화면을 iframe으로 감싸는 것(클릭재킹)과 MIME 추측을 막는다
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // CSRF 방어: /api 전체의 상태 변경 요청에 Origin 검사(본문 해석보다 먼저)
  app.use('/api', originCheck);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/staff', createStaffRouter(options.staff));

  app.use('/api/exams', createExamsRouter());

  app.use('/api', createStudentRouter());
  app.use('/api/attempts', createAttemptsRouter());

  // ── 라우터 등록 위치 ─────────────────────────────────────────────
  // Task 4~12의 라우터는 이 줄 위에 app.use('/api/...', router)로 추가한다(병합은 Coordinator).
  // ────────────────────────────────────────────────────────────────

  // 위에서 처리되지 않은 /api 요청
  app.use('/api', (_req, res) => {
    res.status(404).json(apiError('NOT_FOUND', '요청한 API를 찾을 수 없습니다.'));
  });

  // 빌드된 화면(운영). API 처리 뒤에 등록해야 /api 요청이 화면으로 새지 않는다
  if (options.clientDist) registerClient(app, options.clientDist);

  // 그 밖에 처리되지 않은 요청(화면 폴더가 없을 때의 /, GET이 아닌 화면 경로 요청 등)
  app.use((_req, res) => {
    res.status(404).json(apiError('NOT_FOUND', '요청한 주소를 찾을 수 없습니다.'));
  });

  app.use(onError);

  return app;
}
