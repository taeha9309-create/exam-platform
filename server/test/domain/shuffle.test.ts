import { describe, expect, it } from 'vitest';
import { buildOrders } from '../../src/domain/shuffle';

const questions = [
  { id: 'q1', type: 'MCQ' as const, choices: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  { id: 'q2', type: 'ESSAY' as const, choices: null },
  { id: 'q3', type: 'MCQ' as const, choices: [{ id: 'x' }, { id: 'y' }] },
];

describe('buildOrders', () => {
  it('shuffle=false면 입력 순서를 그대로 쓴다', () => {
    const r = buildOrders(questions, false);
    expect(r.questionOrder).toEqual(['q1', 'q2', 'q3']);
    expect(r.choiceOrders).toEqual({ q1: ['a', 'b', 'c'], q3: ['x', 'y'] });
  });

  it('shuffle=true + rng가 0을 내면 결정적 결과를 준다', () => {
    const r1 = buildOrders(questions, true, () => 0);
    const r2 = buildOrders(questions, true, () => 0);
    expect(r1).toEqual(r2);
    // Fisher–Yates, rng=0: [q1,q2,q3] → [q3,q2,q1] → [q2,q3,q1]
    expect(r1.questionOrder).toEqual(['q2', 'q3', 'q1']);
  });

  it('shuffle=true여도 모든 id가 정확히 한 번씩 나온다', () => {
    const r = buildOrders(questions, true);
    expect([...r.questionOrder].sort()).toEqual(['q1', 'q2', 'q3']);
    expect([...(r.choiceOrders.q1 ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect([...(r.choiceOrders.q3 ?? [])].sort()).toEqual(['x', 'y']);
  });

  it('ESSAY 문항은 choiceOrders에 없다', () => {
    const r = buildOrders(questions, true, () => 0.5);
    expect(r.choiceOrders).not.toHaveProperty('q2');
  });

  it('입력 배열을 바꾸지 않는다', () => {
    const copy = JSON.parse(JSON.stringify(questions));
    buildOrders(questions, true, () => 0);
    expect(questions).toEqual(copy);
  });

  it('빈 문항 목록을 처리한다', () => {
    expect(buildOrders([], true)).toEqual({ questionOrder: [], choiceOrders: {} });
  });
});
