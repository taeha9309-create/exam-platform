import { randomInt } from 'node:crypto';

export interface OrderableQuestion {
  id: string;
  type: 'MCQ' | 'ESSAY';
  choices: { id: string }[] | null;
}

export interface Orders {
  questionOrder: string[];
  choiceOrders: Record<string, string[]>;
}

/** [0, 1) 범위의 난수를 돌려주는 함수. 테스트에서는 고정 값을 주입한다 */
export type Rng = () => number;

/** 기본 난수: 암호학적 난수 소스 기반 (셔플 용도에도 통일해서 쓴다) */
const cryptoRng: Rng = () => randomInt(0, 2 ** 32) / 2 ** 32;

/** Fisher–Yates 셔플. 입력 배열은 바꾸지 않고 새 배열을 돌려준다 */
function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 학생 한 명분의 문항 순서와 객관식 보기 순서를 만든다.
 * shuffle=false면 입력 순서를 그대로 쓴다. 서술형은 보기 순서가 없으므로 choiceOrders에 넣지 않는다.
 */
export function buildOrders(
  questions: readonly OrderableQuestion[],
  shuffle: boolean,
  rng: Rng = cryptoRng,
): Orders {
  const questionOrder = shuffle
    ? shuffled(questions.map((q) => q.id), rng)
    : questions.map((q) => q.id);

  const choiceOrders: Record<string, string[]> = {};
  for (const q of questions) {
    if (q.type !== 'MCQ' || q.choices === null) continue;
    const ids = q.choices.map((c) => c.id);
    choiceOrders[q.id] = shuffle ? shuffled(ids, rng) : ids;
  }

  return { questionOrder, choiceOrders };
}
