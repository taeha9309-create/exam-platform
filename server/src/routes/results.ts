import { randomInt } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth/staffAuth';
import { prisma } from '../db';
import { AppError } from '../errors';
import { runExamTx } from '../services/examLifecycle';

const INVALID_INPUT = () => new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
const uuidParam = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** 정수만. zod 4의 int()는 안전한 정수 범위만 통과시킨다(NaN·무한대·소수·문자열은 거부). 상한은 문항 배점과 비교한다. */
const gradeSchema = z.strictObject({ points: z.number().int().min(0) });

/** 제출된 응시(채점·설문 대상)의 상태. 진행 중 답안은 아직 바뀔 수 있다. */
const FINAL_STATES = new Set(['SUBMITTED', 'TERMINATED']);

function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** 암호학적 난수로 Fisher–Yates 셔플(새 배열). Math.random은 예측 가능하므로 쓰지 않는다. */
export function secureShuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface SurveyRow {
  difficulty: number | null;
  comment: string | null;
}

/**
 * 설문 요약. 의견은 shuffle로 섞어 DB에 쌓인 순서(=제출 순서)가 새지 않게 한다(F-18, G4).
 * 운영에서는 secureShuffle을 쓰고, 테스트에서는 결정적인 함수를 주입한다.
 * count는 응답 행 수(난이도만 남기거나 의견만 남긴 응답 포함), distribution·average는 난이도가 있는 응답만 센다.
 */
export function buildSurveySummary(rows: SurveyRow[], shuffle: <T>(xs: T[]) => T[]): { count: number; distribution: number[]; average: number | null; comments: string[] } {
  const distribution = [0, 0, 0, 0, 0];
  let sum = 0;
  let rated = 0;
  const comments: string[] = [];
  for (const r of rows) {
    if (r.difficulty !== null && Number.isInteger(r.difficulty) && r.difficulty >= 1 && r.difficulty <= 5) {
      distribution[r.difficulty - 1]! += 1;
      sum += r.difficulty;
      rated += 1;
    }
    if (r.comment !== null && r.comment !== '') comments.push(r.comment);
  }
  return { count: rows.length, distribution, average: rated === 0 ? null : Math.round((sum / rated) * 100) / 100, comments: shuffle(comments) };
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', '시험을 찾을 수 없습니다.');

/**
 * `/api`에 마운트한다. 학생 라우터와 같은 접두사이므로 router.use(requireStaff)를 쓰지 않고
 * 라우트마다 requireStaff를 붙인다(학생 API가 교수자 인증에 막히지 않도록).
 * 모든 교수자 계정이 모든 시험에 접근한다(D-016).
 */
export function createResultsRouter(): Router {
  const router = Router();

  router.get(
    '/exams/:id/results',
    requireStaff,
    wrap(async (req, res) => {
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) throw INVALID_INPUT();
      const exam = await prisma.exam.findUnique({ where: { id: id.data }, select: { id: true } });
      if (!exam) throw NOT_FOUND();

      // 시험 크기와 무관하게 고정된 개수(5개)의 쿼리: 문항, 응시(+명단), 답안, 신호 집계, 조치 집계.
      const [questions, attempts, answers, signals, actions] = await Promise.all([
        prisma.question.findMany({ where: { examId: exam.id }, select: { id: true, type: true, points: true, position: true }, orderBy: { position: 'asc' } }),
        // 토큰 해시 등은 select로 아예 읽지 않는다.
        prisma.attempt.findMany({ where: { examId: exam.id }, select: { id: true, state: true, rosterEntry: { select: { studentNo: true, name: true } } } }),
        prisma.answer.findMany({ where: { attempt: { examId: exam.id } }, select: { id: true, attemptId: true, questionId: true, choiceId: true, text: true, awardedPoints: true } }),
        prisma.signal.groupBy({ by: ['attemptId', 'severity'], where: { attempt: { examId: exam.id } }, _count: { _all: true } }),
        prisma.proctorAction.groupBy({ by: ['attemptId'], where: { attempt: { examId: exam.id } }, _count: { _all: true } }),
      ]);

      const typeOf = new Map(questions.map((q) => [q.id, q.type]));
      const answersByAttempt = new Map<string, typeof answers>();
      for (const a of answers) {
        const list = answersByAttempt.get(a.attemptId);
        if (list) list.push(a);
        else answersByAttempt.set(a.attemptId, [a]);
      }
      const signalCounts = new Map<string, { INFO: number; WARN: number; ALERT: number }>();
      for (const s of signals) {
        const c = signalCounts.get(s.attemptId) ?? { INFO: 0, WARN: 0, ALERT: 0 };
        c[s.severity] = s._count._all;
        signalCounts.set(s.attemptId, c);
      }
      const actionCounts = new Map(actions.map((a) => [a.attemptId, a._count._all]));

      const rows = attempts
        .map((at) => {
          const mine = answersByAttempt.get(at.id) ?? [];
          let mcqScore = 0;
          let essayScore: number | null = null;
          if (FINAL_STATES.has(at.state)) {
            // 행이 없는 미답 문항과 정답이 없어 채점되지 않은 객관식(awardedPoints null)은 0점이다.
            // 서술형은 행이 있는데 awardedPoints가 null이면 미채점 → 합계를 낼 수 없다. 행이 없는 미답은 채점할 대상이 없으므로 0점.
            let essay = 0;
            let ungraded = false;
            for (const a of mine) {
              if (typeOf.get(a.questionId) === 'ESSAY') {
                if (a.awardedPoints === null) ungraded = true;
                else essay += a.awardedPoints;
              } else {
                mcqScore += a.awardedPoints ?? 0;
              }
            }
            essayScore = ungraded ? null : essay;
          }
          return {
            attemptId: at.id,
            studentNo: at.rosterEntry.studentNo,
            name: at.rosterEntry.name,
            state: at.state,
            mcqScore,
            essayScore,
            total: essayScore === null ? null : mcqScore + essayScore,
            signalCounts: signalCounts.get(at.id) ?? { INFO: 0, WARN: 0, ALERT: 0 },
            actionCount: actionCounts.get(at.id) ?? 0,
            answers: mine.map((a) => ({
              answerId: a.id,
              questionId: a.questionId,
              ...(a.choiceId !== null ? { choiceId: a.choiceId } : {}),
              ...(a.text !== null ? { text: a.text } : {}),
              awardedPoints: a.awardedPoints,
            })),
          };
        })
        .sort((x, y) => (x.studentNo < y.studentNo ? -1 : x.studentNo > y.studentNo ? 1 : 0));

      res.set('Cache-Control', 'no-store');
      res.json({ questions, rows });
    }),
  );

  router.put(
    '/answers/:id/grade',
    requireStaff,
    wrap(async (req, res) => {
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) throw INVALID_INPUT();
      const body = gradeSchema.safeParse(req.body);
      if (!body.success) throw INVALID_INPUT();
      const { points } = body.data;

      const found = await prisma.answer.findUnique({ where: { id: id.data }, select: { attemptId: true } });
      if (!found) throw new AppError(404, 'NOT_FOUND', '답안을 찾을 수 없습니다.');

      const awardedPoints = await runExamTx(async (tx) => {
        // 응시 행을 잠근 안에서 상태·답안을 다시 읽는다. 제출·마감과 직렬화되고, 동시 채점은 순서대로 적용되어 마지막 쓰기가 남는다.
        const locked = await tx.$queryRaw<{ state: string }[]>`SELECT "state" FROM "Attempt" WHERE "id" = ${found.attemptId} FOR UPDATE`;
        const attempt = locked[0];
        const answer = await tx.answer.findUnique({ where: { id: id.data }, select: { question: { select: { type: true, points: true } } } });
        if (!attempt || !answer) throw new AppError(404, 'NOT_FOUND', '답안을 찾을 수 없습니다.');
        if (answer.question.type !== 'ESSAY') throw new AppError(400, 'NOT_ESSAY', '서술형 답안만 채점할 수 있습니다.');
        if (points > answer.question.points) throw new AppError(400, 'INVALID_INPUT', '입력값이 올바르지 않습니다.');
        if (!FINAL_STATES.has(attempt.state)) throw new AppError(409, 'NOT_SUBMITTED', '제출이 끝난 응시만 채점할 수 있습니다.');
        const updated = await tx.answer.update({ where: { id: id.data }, data: { awardedPoints: points }, select: { awardedPoints: true } });
        return updated.awardedPoints;
      });
      res.json({ answerId: id.data, awardedPoints });
    }),
  );

  router.get(
    '/exams/:id/survey',
    requireStaff,
    wrap(async (req, res) => {
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) throw INVALID_INPUT();
      const exam = await prisma.exam.findUnique({ where: { id: id.data }, select: { id: true, status: true } });
      if (!exam) throw NOT_FOUND();
      // 시험 중에는 응답 수 변화로 학생의 제출 시점과 설문이 연결될 수 있어(익명성) 종료 뒤에만 연다(SPEC 2.1).
      if (exam.status !== 'ENDED') throw new AppError(409, 'NOT_ENDED', '시험이 끝난 뒤에 설문 결과를 볼 수 있습니다.');
      // 난이도·의견 두 열만 읽는다. 정렬하지 않으며, 순서는 어차피 셔플로 지운다.
      const rows = await prisma.surveyResponse.findMany({ where: { examId: exam.id }, select: { difficulty: true, comment: true } });
      res.set('Cache-Control', 'no-store');
      res.json(buildSurveySummary(rows, secureShuffle));
    }),
  );

  return router;
}
