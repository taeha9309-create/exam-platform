import { Prisma, type ExamStatus } from '@prisma/client';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth/staffAuth';
import { prisma } from '../db';
import { generateExamCode } from '../domain/codes';
import { parseQuestionsInput } from '../domain/questions';
import { MAX_ROSTER_CSV_LENGTH, parseRosterCsv } from '../domain/roster';
import { AppError } from '../errors';
import { safeString } from '../validation';

const MAX_TITLE_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 2000;
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 300;
const EXAM_CODE_RETRIES = 5;

const INVALID_INPUT = () => new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', '시험을 찾을 수 없습니다.');

/** 세부 오류(어느 문항·몇 번째 줄인지)를 함께 돌려주는 400. 형식은 { error: { code, message, details } } (공통 오류 형식의 확장) */
function sendInvalidWithDetails(res: Response, details: unknown): void {
  res.status(400).json({ error: { code: 'INVALID_INPUT', message: '입력값이 올바르지 않습니다.', details } });
}

const uuidParam = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const title = safeString({ min: 1, max: MAX_TITLE_LENGTH }).refine((s) => s.trim().length > 0);
const instructions = safeString({ min: 0, max: MAX_INSTRUCTIONS_LENGTH, allowNewlines: true });
const durationMin = z.number().int().min(MIN_DURATION_MIN).max(MAX_DURATION_MIN);

const createSchema = z.strictObject({ title, instructions: instructions.optional(), durationMin });
const patchSchema = z
  .strictObject({
    title: title.optional(),
    instructions: instructions.optional(),
    durationMin: durationMin.optional(),
    pasteMode: z.enum(['RECORD', 'BLOCK']).optional(),
    shuffle: z.boolean().optional(),
    lockNewEntry: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined));
const questionsBodySchema = z.object({ questions: z.unknown() });
const rosterBodySchema = z.object({ csv: safeString({ min: 0, max: MAX_ROSTER_CSV_LENGTH, allowNewlines: true }) });

/** Express 4는 async 핸들러의 오류를 잡지 못하므로 next로 넘긴다. */
function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function parseId(req: Request): string {
  const parsed = uuidParam.safeParse(req.params.id);
  if (!parsed.success) throw INVALID_INPUT();
  return parsed.data;
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw INVALID_INPUT();
  return parsed.data;
}

type Tx = Prisma.TransactionClient;

/**
 * 시험 행을 잠그고(SELECT ... FOR UPDATE) 상태를 읽는다. 상태 확인과 변경 사이에 다른 요청(예: 입장 열기)이
 * 끼어들어 "DRAFT였는데 저장 직전에 OPEN이 된" 경쟁 상태를 막는다. 반드시 트랜잭션 안에서 호출한다.
 */
async function lockExam(tx: Tx, id: string): Promise<{ status: ExamStatus }> {
  const rows = await tx.$queryRaw<{ status: ExamStatus }[]>`SELECT "status" FROM "Exam" WHERE "id" = ${id} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw NOT_FOUND();
  return row;
}

const NOT_DRAFT = () => new AppError(409, 'NOT_DRAFT', '준비 중인 시험에서만 문항과 명단을 수정할 수 있습니다.');

const examInclude = {
  owner: { select: { name: true } },
  _count: { select: { roster: true, attempts: true } },
} satisfies Prisma.ExamInclude;

type ExamWithCounts = Prisma.ExamGetPayload<{ include: typeof examInclude }>;

function summaryOf(e: ExamWithCounts) {
  return {
    id: e.id,
    examCode: e.examCode,
    title: e.title,
    instructions: e.instructions,
    durationMin: e.durationMin,
    status: e.status,
    passcode: e.passcode,
    lockNewEntry: e.lockNewEntry,
    pasteMode: e.pasteMode,
    shuffle: e.shuffle,
    startedAt: e.startedAt,
    endsAt: e.endsAt,
    endedAt: e.endedAt,
    createdAt: e.createdAt,
    ownerName: e.owner.name,
    rosterCount: e._count.roster,
    attemptCount: e._count.attempts,
  };
}

async function loadDetail(id: string) {
  const e = await prisma.exam.findUnique({
    where: { id },
    include: { ...examInclude, questions: { orderBy: { position: 'asc' } }, roster: { orderBy: { studentNo: 'asc' } } },
  });
  if (!e) throw NOT_FOUND();
  return {
    ...summaryOf(e),
    questions: e.questions.map((q) => ({ id: q.id, position: q.position, type: q.type, prompt: q.prompt, points: q.points, choices: q.choices, correctChoiceId: q.correctChoiceId })),
    roster: e.roster.map((r) => ({ id: r.id, studentNo: r.studentNo, name: r.name })),
  };
}

/** 모든 교수자 계정이 모든 시험에 접근한다(D-016). ownerId는 "만든 사람" 표시용이다. */
export function createExamsRouter(): Router {
  const router = Router();
  router.use(requireStaff);

  router.get(
    '/',
    wrap(async (_req, res) => {
      const exams = await prisma.exam.findMany({ include: examInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      res.json({
        exams: exams.map((e) => ({
          id: e.id,
          title: e.title,
          status: e.status,
          ownerName: e.owner.name,
          rosterCount: e._count.roster,
          attemptCount: e._count.attempts,
          createdAt: e.createdAt,
        })),
      });
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const body = parseBody(createSchema, req.body);
      for (let attempt = 0; attempt < EXAM_CODE_RETRIES; attempt++) {
        try {
          const exam = await prisma.exam.create({
            data: { ownerId: req.staff!.id, examCode: generateExamCode(), title: body.title.trim(), instructions: body.instructions ?? '', durationMin: body.durationMin },
            include: examInclude,
          });
          res.status(201).json({ exam: summaryOf(exam) });
          return;
        } catch (err) {
          // 시험 코드가 우연히 겹친 경우(유일 제약 위반)만 새 코드로 다시 시도한다
          const isCodeCollision = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
          if (!isCodeCollision) throw err;
        }
      }
      throw new Error('시험 코드를 만들지 못했습니다.');
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      res.json({ exam: await loadDetail(parseId(req)) });
    }),
  );

  router.patch(
    '/:id',
    wrap(async (req, res) => {
      const id = parseId(req);
      const body = parseBody(patchSchema, req.body);
      const onlyLock = Object.entries(body).every(([k, v]) => v === undefined || k === 'lockNewEntry');
      await prisma.$transaction(async (tx) => {
        const { status } = await lockExam(tx, id);
        if (status === 'ENDED') {
          throw onlyLock
            ? new AppError(409, 'INVALID_TRANSITION', '종료된 시험은 수정할 수 없습니다.')
            : new AppError(409, 'ALREADY_STARTED', '이미 시작된 시험은 설정을 바꿀 수 없습니다.');
        }
        // 설정은 RUNNING 전까지. lockNewEntry(신규 입장 차단)만 진행 중에도 바꿀 수 있다(F-06).
        if (status === 'RUNNING' && !onlyLock) {
          throw new AppError(409, 'ALREADY_STARTED', '이미 시작된 시험은 설정을 바꿀 수 없습니다.');
        }
        await tx.exam.update({
          where: { id },
          data: { ...body, title: body.title === undefined ? undefined : body.title.trim() },
        });
      });
      res.json({ exam: await loadDetail(id) });
    }),
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const id = parseId(req);
      await prisma.$transaction(async (tx) => {
        const { status } = await lockExam(tx, id);
        if (status !== 'DRAFT' && status !== 'ENDED') {
          throw new AppError(409, 'INVALID_TRANSITION', '준비 중이거나 종료된 시험만 삭제할 수 있습니다.');
        }
        await tx.exam.delete({ where: { id } }); // 문항·명단·응시는 onDelete: Cascade
      });
      res.json({ ok: true });
    }),
  );

  router.put(
    '/:id/questions',
    wrap(async (req, res) => {
      const id = parseId(req);
      const body = parseBody(questionsBodySchema, req.body);
      const parsed = parseQuestionsInput(body.questions);
      if (!parsed.ok) return sendInvalidWithDetails(res, parsed.errors);
      const { questions } = parsed;
      await prisma.$transaction(async (tx) => {
        const { status } = await lockExam(tx, id);
        if (status !== 'DRAFT') throw NOT_DRAFT();
        // 전체 교체: 기존 문항을 지우고 position 순서대로 다시 만든다(한 트랜잭션이라 중간 상태가 보이지 않는다)
        await tx.question.deleteMany({ where: { examId: id } });
        await tx.question.createMany({
          data: questions.map((q, position) => ({
            examId: id,
            position,
            type: q.type,
            prompt: q.prompt,
            points: q.points,
            choices: q.choices ?? Prisma.DbNull,
            correctChoiceId: q.correctChoiceId ?? null,
          })),
        });
      });
      const saved = await prisma.question.findMany({ where: { examId: id }, orderBy: { position: 'asc' } });
      res.json({
        questions: saved.map((q) => ({ id: q.id, position: q.position, type: q.type, prompt: q.prompt, points: q.points, choices: q.choices, correctChoiceId: q.correctChoiceId })),
      });
    }),
  );

  router.put(
    '/:id/roster',
    wrap(async (req, res) => {
      const id = parseId(req);
      const body = parseBody(rosterBodySchema, req.body);
      const parsed = parseRosterCsv(body.csv);
      if (!parsed.ok) return sendInvalidWithDetails(res, parsed.errors);
      await prisma.$transaction(async (tx) => {
        const { status } = await lockExam(tx, id);
        if (status !== 'DRAFT') throw NOT_DRAFT();
        await tx.rosterEntry.deleteMany({ where: { examId: id } });
        await tx.rosterEntry.createMany({ data: parsed.entries.map((e) => ({ examId: id, studentNo: e.studentNo, name: e.name })) });
      });
      res.json({ rosterCount: parsed.entries.length });
    }),
  );

  return router;
}
