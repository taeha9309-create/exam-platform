import { randomInt } from 'node:crypto';

/** 시험 코드 알파벳: 헷갈리기 쉬운 I, L, O, 0, 1 제외 (31자) */
const EXAM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const EXAM_CODE_LENGTH = 8;

/** 시험 주소용 8자 코드 (SPEC 2.4). 암호학적 난수를 쓴다 */
export function generateExamCode(): string {
  let out = '';
  for (let i = 0; i < EXAM_CODE_LENGTH; i++) {
    out += EXAM_CODE_ALPHABET[randomInt(EXAM_CODE_ALPHABET.length)];
  }
  return out;
}

/** 시험 비밀번호 6자리 숫자 (SPEC 2.4). 앞자리 0 허용. 암호학적 난수를 쓴다 */
export function generatePasscode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
