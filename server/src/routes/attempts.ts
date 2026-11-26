import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth/staffAuth';
import { AppError } from '../errors';
import { APPROVAL_TYPES, resolveApproval, type ApprovalType } from '../services/entry';
import { safeString } from '../validation';

const MAX_REASON_LENGTH = 500;
const INVALID_INPUT = () => new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
const uuidParam = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const reasonSchema = safeString({ min: 1, max: MAX_REASON_LENGTH }).refine((s) => s.trim().length > 0);
const bodySchema = z.object({ type: z.unknown(), reason: z.unknown(), payload: z.unknown().optional() });

function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** `/api/attempts`에 마운트한다. 이 작업에서는 승인 4종만 처리한다(나머지 조치는 계획 2에서 확장). */
export function createAttemptsRouter(): Router {
  const router = Router();
  router.use(requireStaff);

  router.post(
    '/:id/actions',
    wrap(async (req, res) => {
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) throw INVALID_INPUT();
      const body = bodySchema.safeParse(req.body);
      if (!body.success) throw INVALID_INPUT();
      const { type, reason } = body.data;
      if (typeof type !== 'string') throw INVALID_INPUT();
      if (!(APPROVAL_TYPES as readonly string[]).includes(type)) throw new AppError(400, 'UNSUPPORTED_ACTION', '지원하지 않는 조치입니다.');
      const parsedReason = reasonSchema.safeParse(reason);
      if (!parsedReason.success) throw INVALID_INPUT();

      const attempt = await resolveApproval({ attemptId: id.data, staffId: req.staff!.id, type: type as ApprovalType, reason: parsedReason.data.trim() });
      res.json({ attempt: { id: attempt.id, state: attempt.state } });
    }),
  );

  return router;
}
