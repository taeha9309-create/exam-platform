import { z } from 'zod';
import { safeString } from '../validation';

export const MAX_QUESTIONS = 100;
export const MAX_PROMPT_LENGTH = 5000;
export const MAX_CHOICE_TEXT_LENGTH = 500;
export const MAX_POINTS = 1000;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;

/** 오류 응답이 입력 크기에 비례해 커지지 않도록 돌려주는 세부 오류 수를 제한한다(roster와 같은 50건) */
export const MAX_ERROR_DETAILS = 50;

/**
 * 보기 id로 쓰면 객체 키로 채점·집계할 때 프로토타입 오염·충돌을 일으킬 수 있는 이름.
 * 채점·집계 코드는 가능하면 Map을 쓰고, 입력 단계에서도 이 이름을 거부한다.
 */
const RESERVED_CHOICE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const choiceSchema = z.object({
  // 보기 id는 화면이 만드는 짧은 식별자다. 영숫자·_·- 만 허용해 제어 문자·공백 문제를 원천 차단한다.
  id: safeString({ min: 1, max: 64 })
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((id) => !RESERVED_CHOICE_IDS.has(id)),
  text: safeString({ min: 1, max: MAX_CHOICE_TEXT_LENGTH }),
});

const questionSchema = z
  .object({
    type: z.enum(['MCQ', 'ESSAY']),
    prompt: safeString({ min: 1, max: MAX_PROMPT_LENGTH, allowNewlines: true }),
    points: z.number().int().min(1).max(MAX_POINTS),
    choices: z.array(choiceSchema).max(MAX_CHOICES).optional().nullable(),
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
    return { ok: false, errors: errors.slice(0, MAX_ERROR_DETAILS) };
  }
  const questions = parsed.data.map((q): ValidQuestion =>
    q.type === 'MCQ'
      ? { type: 'MCQ', prompt: q.prompt, points: q.points, choices: q.choices!.map((c) => ({ id: c.id, text: c.text })), correctChoiceId: q.correctChoiceId!}
      : { type: 'ESSAY', prompt: q.prompt, points: q.points },
  );
  return { ok: true, questions };
}
