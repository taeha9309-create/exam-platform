import { describe, expect, it } from 'vitest';
import { gradeMcq } from '../../src/domain/grading';

const q = { points: 3, correctChoiceId: 'c1' };

describe('gradeMcq', () => {
  it('정답이면 배점을 준다', () => {
    expect(gradeMcq(q, 'c1')).toBe(3);
  });
  it('오답이면 0점', () => {
    expect(gradeMcq(q, 'c2')).toBe(0);
  });
  it('미답(null)이면 0점', () => {
    expect(gradeMcq(q, null)).toBe(0);
  });
  it('대소문자·공백이 다르면 오답(정확히 같아야 한다)', () => {
    expect(gradeMcq(q, 'C1')).toBe(0);
    expect(gradeMcq(q, ' c1')).toBe(0);
    expect(gradeMcq(q, '')).toBe(0);
  });
  it('정답 id가 비어 있어도 미답이 정답으로 처리되지 않는다', () => {
    expect(gradeMcq({ points: 3, correctChoiceId: '' }, null)).toBe(0);
  });
});
