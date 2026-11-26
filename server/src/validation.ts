import { z } from 'zod';

/**
 * 공통 문자열 검증. 사용자가 보낸 문자열을 DB에 넣기 전에 걸러 낸다.
 * - 제어 문자(U+0000~U+001F, U+007F): 특히 NUL(U+0000)은 PostgreSQL이 문자열로 받지 못해 500과 로그 범람을 만든다.
 * - 짝 없는 서로게이트(U+D800~U+DFFF 단독): 올바른 UTF-8로 저장할 수 없어 DB·JSON 직렬화에서 오류가 난다.
 * 줄바꿈·탭이 필요한 필드(안내문·지문·서술형)만 allowNewlines로 \n, \r, \t를 허용한다.
 */

const CONTROL_STRICT = /[\u0000-\u001f\u007f]/;
const CONTROL_NO_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function hasControlChars(s: string, allowNewlines: boolean): boolean {
  return (allowNewlines ? CONTROL_NO_NEWLINE : CONTROL_STRICT).test(s);
}

export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

export interface SafeStringOptions {
  min: number;
  max: number;
  /** \n, \r, \t 허용(여러 줄 입력 필드용). 기본 false */
  allowNewlines?: boolean;
}

/** 길이(UTF-16 코드 유닛 기준)·제어 문자·짝 없는 서로게이트를 한 번에 검사하는 zod 문자열. */
export function safeString({ min, max, allowNewlines = false }: SafeStringOptions) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !hasControlChars(s, allowNewlines), { message: '허용되지 않는 제어 문자가 있습니다.' })
    .refine((s) => !hasLoneSurrogate(s), { message: '올바르지 않은 유니코드 문자가 있습니다.' });
}
