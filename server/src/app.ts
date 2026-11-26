import express, { type ErrorRequestHandler, type Express } from 'express';
import cookieParser from 'cookie-parser';

/** 오류 응답 형식은 항상 { error: { code, message } } (계획 1 공통 제약). 화면 문구는 클라이언트가 code로 매핑한다. */
export function apiError(code: string, message: string) {
  return { error: { code, message } };
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ── 라우터 등록 위치 ─────────────────────────────────────────────
  // Task 4~12의 라우터는 이 줄 위에 app.use('/api/...', router)로 추가한다(병합은 Coordinator).
  // ────────────────────────────────────────────────────────────────

  // 위에서 처리되지 않은 /api 요청
  app.use('/api', (_req, res) => {
    res.status(404).json(apiError('NOT_FOUND', '요청한 API를 찾을 수 없습니다.'));
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
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
  app.use(onError);

  return app;
}
