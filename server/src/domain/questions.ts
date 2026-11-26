import { z } from 'zod';
import { safeString } from '../validation';

export const MAX_QUESTIONS = 100;
export const MAX_PROMPT_LENGTH = 5000;
export const MAX_CHOICE_TEXT_LENGTH = 500;
export const MAX_POINTS = 1000;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;

const choiceSchema = z.object({
  // 보기 id는 화면이 만드는 짧은 식별자다. 영숫자·_·- 만 허용해 제어 문자·공백 문제를 원천 차단한다.
  id: safeString({ min: 1, max: 64 }).regex(/^[A-Za-z0-9_-]+$/),
  text: safeString({ min: 1, max: MAX_CHOICE_TEXT_LENGTH }),
});

const questionSchema = z
  .object({
    type: z.enum(['MCQ', 'ESSAY']),
    prompt: safeString({ min: 1, max: MAX_PROMPT_LENGTH, allowNewlines: true }),
    points: z.number().int().min(1).max(MAX_POINTS),
    choices: z.array(choiceSchema).optional().nullable(),
    correctChoiceId: z.string().max(64).optional().nullable(),
  })
  .superRefine((q, ctx) => {
    if (q.type !== 'MCQ') return;
    const choices = q.choices ?? [];
    if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'CHOICES_COUNT' });
    } else if (new Set(choices.map((c) => c.id)).size !== choices.length) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'CHOICES_DUPLICATE_ID' });
    }
    if (!q.correctChoiceId || !choices.some((c) => c.id === q.correctChoiceId)) {
      ctx.addIssue({ code: 'custom', path: ['correctChoiceId'], message: 'CORRECT_CHOICE_REQUIRED' });
    }
  });

export const questionsInputSchema = z.array(questionSchema).max(MAX_QUESTIONS);

export interface ValidQuestion {
  type: 'MCQ' | 'ESSAY';
  prompt: string;
  points: number;
  choices?: { id: string; text: string }[];
  correctChoiceId?: string;
}

export interface QuestionError {
  /** 문항 번호(0부터). 배열 전체의 오류는 -1 */
  index: number;
  field: string;
  code: string;
}

export type QuestionsParseResult = { ok: true; questions: ValidQuestion[] } | { ok: false; errors: QuestionError[] };

/** 검증 후 저장 형태로 정리한다. 서술형에 딸려 온 보기·정답은 버린다. */
export function parseQuestionsInput(input: unknown): QuestionsParseResult {
  const parsed = questionsInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue): QuestionError => {
      const [first, second] = issue.path;
      const index = typeof first === 'number' ? first : -1;
      const field = typeof second === 'string' ? second : 'questions';
      return { index, field, code: issue.code === 'custom' ? issue.message : issue.code };
    });
    return { ok: false, errors };
  }
  const questions = parsed.data.map((q): ValidQuestion =>
    q.type === 'MCQ'
      ? { type: 'MCQ', prompt: q.prompt, points: q.points, choices: q.choices!.map((c) => ({ id: c.id, text: c.text })), correctChoiceId: q.correctChoiceId!}
      : { type: 'ESSAY', prompt: q.prompt, points: q.points },
  );
  return { ok: true, questions };
}
