import { describe, expect, it } from 'vitest';
import { parseQuestionsInput } from '../../src/domain/questions';

const mcq = (over: Record<string, unknown> = {}) => ({
  type: 'MCQ',
  prompt: '문제',
  points: 2,
  choices: [
    { id: 'a', text: '가' },
    { id: 'b', text: '나' },
  ],
  correctChoiceId: 'a',
  ...over,
});

describe('보기 배열 상한·예약어 id·오류 절단 (#42)', () => {
  it('보기 100,000개는 거부된다', () => {
    const choices = Array.from({ length: 100000 }, (_, i) => ({ id: `c${i}`, text: 'x' }));
    const r = parseQuestionsInput([mcq({ choices })]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeLessThanOrEqual(50);
      expect(r.errors).toContainEqual(expect.objectContaining({ index: 0, field: 'choices' }));
    }
  });

  it('오류 목록은 최대 50건으로 잘린다', () => {
    const r = parseQuestionsInput(Array.from({ length: 100 }, () => mcq({ points: 0 })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(50);
  });

  it('보기 id가 __proto__·constructor·prototype이면 choices 오류', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const r = parseQuestionsInput([mcq({ choices: [{ id: bad, text: '가' }, { id: 'b', text: '나' }], correctChoiceId: 'b' })]);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors, bad).toContainEqual(expect.objectContaining({ index: 0, field: 'choices' }));
    }
  });
});

describe('parseQuestionsInput', () => {
  it('올바른 객관식·서술형을 통과시킨다', () => {
    const r = parseQuestionsInput([mcq(), { type: 'ESSAY', prompt: '서술', points: 5 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.questions).toHaveLength(2);
  });

  it('보기 1개는 { index, field: choices } 오류', () => {
    const r = parseQuestionsInput([{ type: 'ESSAY', prompt: 'x', points: 1 }, mcq({ choices: [{ id: 'a', text: '가' }] })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual(expect.objectContaining({ index: 1, field: 'choices' }));
  });

  it('보기 7개는 거부, 6개는 허용', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `보기${i}` }));
    expect(parseQuestionsInput([mcq({ choices: many(7), correctChoiceId: 'c0' })]).ok).toBe(false);
    expect(parseQuestionsInput([mcq({ choices: many(6), correctChoiceId: 'c0' })]).ok).toBe(true);
  });

  it('정답이 없거나 보기에 없으면 correctChoiceId 오류', () => {
    const a = parseQuestionsInput([mcq({ correctChoiceId: undefined })]);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors).toContainEqual(expect.objectContaining({ index: 0, field: 'correctChoiceId' }));
    const b = parseQuestionsInput([mcq({ correctChoiceId: 'zzz' })]);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors).toContainEqual(expect.objectContaining({ index: 0, field: 'correctChoiceId' }));
  });

  it('보기 id 중복은 choices 오류', () => {
    const r = parseQuestionsInput([mcq({ choices: [{ id: 'a', text: '가' }, { id: 'a', text: '나' }] })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual(expect.objectContaining({ index: 0, field: 'choices' }));
  });

  it('지문·배점 제약', () => {
    const empty = parseQuestionsInput([mcq({ prompt: '' })]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors).toContainEqual(expect.objectContaining({ index: 0, field: 'prompt' }));
    expect(parseQuestionsInput([mcq({ prompt: 'a'.repeat(5001) })]).ok).toBe(false);
    expect(parseQuestionsInput([mcq({ prompt: 'a'.repeat(5000) })]).ok).toBe(true);
    for (const points of [0, -1, 1.5, '3', 1001]) expect(parseQuestionsInput([mcq({ points })]).ok, String(points)).toBe(false);
  });

  it('지문의 NUL은 거부하고 줄바꿈은 허용한다', () => {
    expect(parseQuestionsInput([mcq({ prompt: `a${String.fromCharCode(0)}b` })]).ok).toBe(false);
    expect(parseQuestionsInput([mcq({ prompt: 'a\nb' })]).ok).toBe(true);
    expect(parseQuestionsInput([mcq({ choices: [{ id: 'a', text: `x${String.fromCharCode(0)}` }, { id: 'b', text: 'y' }] })]).ok).toBe(false);
    expect(parseQuestionsInput([mcq({ choices: [{ id: 'a', text: 'x\ny' }, { id: 'b', text: 'y' }] })]).ok).toBe(false);
  });

  it('알 수 없는 유형과 배열이 아닌 입력, 문항 수 상한', () => {
    expect(parseQuestionsInput([{ type: 'TF', prompt: 'x', points: 1 }]).ok).toBe(false);
    expect(parseQuestionsInput({}).ok).toBe(false);
    expect(parseQuestionsInput(Array.from({ length: 101 }, () => ({ type: 'ESSAY', prompt: 'x', points: 1 }))).ok).toBe(false);
  });

  it('서술형에 들어온 보기·정답은 버린다', () => {
    const r = parseQuestionsInput([{ type: 'ESSAY', prompt: 'x', points: 1, choices: [{ id: 'a', text: 'q' }], correctChoiceId: 'a' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.questions[0]).toEqual({ type: 'ESSAY', prompt: 'x', points: 1 });
  });
});
