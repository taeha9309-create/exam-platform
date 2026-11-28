import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth/staffAuth';
import { AppError } from '../errors';
import { ACTION_TYPES, applyAction, getTimeline, type ActionInput, type ActionType } from '../services/actions';
import { APPROVAL_TYPES, resolveApproval, type ApprovalType } from '../services/entry';
import { safeString } from '../validation';

const MAX_REASON_LENGTH = 500;
const INVALID_INPUT = () => new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
const uuidParam = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/**
 * 사유(WARN은 학생 화면에 그대로 표시되는 메시지). 1~500자, 제어 문자(줄바꿈·탭 포함)와 짝 없는 서로게이트 거부, 공백만은 불가.
 * 한 줄 문장만 허용한다(줄바꿈을 허용하면 학생 화면 레이아웃을 흔들 수 있다). 저장은 앞뒤 공백만 제거하고 원문을 그대로 둔다.
 */
const reasonSchema = safeString({ min: 1, max: MAX_REASON_LENGTH }).refine((s) => s.trim().length > 0);
/** payload는 조치별로 엄격하게(알 수 없는 키 거부). minutes는 정수 1~60(소수·문자열·null 거부). */
const addTimePayload = z.strictObject({ minutes: z.number().int().min(1).max(60) });
const resumePayload = z.strictObject({ addPausedTime: z.boolean().optional() });
const emptyPayload = z.strictObject({});
const bodySchema = z.object({ type: z.unknown(), reason: z.unknown().optional(), payload: z.unknown().optional() });

function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** `/api/attempts`에 마운트한다. 승인 4종(F-14)과 감독관 조치 6종(F-16)을 type으로 분기하고, 학생 타임라인(F-15)을 준다. */
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
      if ((ACTION_TYPES as readonly string[]).includes(type)) {
        // 실행자는 인증된 계정(req.staff)뿐이다. 본문의 staffId 같은 값은 읽지 않는다.
        const input = parseActionInput(type as ActionType, reason, body.data.payload);
        res.json({ attempt: await applyAction(id.data, req.staff!.id, input) });
        return;
      }
      if (!(APPROVAL_TYPES as readonly string[]).includes(type)) throw new AppError(400, 'UNSUPPORTED_ACTION', '지원하지 않는 조치입니다.');
      const parsedReason = reasonSchema.safeParse(reason);
      if (!parsedReason.success) throw INVALID_INPUT();

      const attempt = await resolveApproval({ attemptId: id.data, staffId: req.staff!.id, type: type as ApprovalType, reason: parsedReason.data.trim() });
      res.json({ attempt: { id: attempt.id, state: attempt.state } });
    }),
  );

  router.get(
    '/:id/timeline',
    wrap(async (req, res) => {
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) throw INVALID_INPUT();
      res.json(await getTimeline(id.data));
    }),
  );

  return router;
}

/** 조치 요청 본문 검증. ACK만 사유가 선택(주면 같은 검증)이고, 나머지는 사유 필수. */
function parseActionInput(type: ActionType, reason: unknown, payload: unknown): ActionInput {
  let parsedReason: string | undefined;
  if (reason === undefined && type === 'ACK') {
    parsedReason = undefined;
  } else {
    const r = reasonSchema.safeParse(reason);
    if (!r.success) throw INVALID_INPUT();
    parsedReason = r.data.trim();
  }
  const payloadSchema = type === 'ADD_TIME' ? addTimePayload : type === 'RESUME' ? resumePayload : emptyPayload;
  const p = payloadSchema.safeParse(payload === undefined ? (type === 'ADD_TIME' ? undefined : {}) : payload);
  if (!p.success) throw INVALID_INPUT();
  return { type, reason: parsedReason, payload: p.data };
}
