import { describe, expect, it } from 'vitest';
import { MAX_ROSTER_SIZE, parseRosterCsv } from '../../src/domain/roster';

describe('parseRosterCsv', () => {
  it('BOM·CRLF·헤더·빈 줄을 처리한다', () => {
    const r = parseRosterCsv('﻿학번,이름\r\n20260001,김철수\r\n20260002,이영희\r\n\r\n');
    expect(r).toEqual({
      ok: true,
      entries: [
        { studentNo: '20260001', name: '김철수' },
        { studentNo: '20260002', name: '이영희' },
      ],
    });
  });

  it('LF 줄바꿈과 헤더 없는 CSV, 값 양끝 공백 제거', () => {
    const r = parseRosterCsv(' 20260001 , 김철수 \n20260002,이영희');
    expect(r).toEqual({
      ok: true,
      entries: [
        { studentNo: '20260001', name: '김철수' },
        { studentNo: '20260002', name: '이영희' },
      ],
    });
  });

  it('중복 학번은 두 번째 줄을 DUPLICATE로 보고한다', () => {
    const r = parseRosterCsv('20260001,김\n20260001,이');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toMatchObject([{ line: 2, code: 'DUPLICATE' }]);
  });

  it('빈 값은 EMPTY(줄 번호는 원본 파일 기준: 헤더·빈 줄 포함)', () => {
    const a = parseRosterCsv('20260001,');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors).toMatchObject([{ line: 1, code: 'EMPTY' }]);

    const b = parseRosterCsv('학번,이름\n\n20260001,김\n,이');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors).toMatchObject([{ line: 4, code: 'EMPTY' }]);
  });

  it('모든 오류를 한 번에 돌려준다', () => {
    const r = parseRosterCsv('1,가\n1,나\n2,\n3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => [e.line, e.code])).toEqual([[2, 'DUPLICATE'], [3, 'EMPTY'], [4, 'FORMAT']]);
  });

  it('열이 3개 이상이면 FORMAT', () => {
    const r = parseRosterCsv('1,가,나');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toMatchObject([{ line: 1, code: 'FORMAT' }]);
  });

  it('값 안의 제어 문자와 너무 긴 값은 FORMAT', () => {
    const nul = parseRosterCsv(`1,가${String.fromCharCode(0)}`);
    expect(nul.ok).toBe(false);
    if (!nul.ok) expect(nul.errors).toMatchObject([{ line: 1, code: 'FORMAT' }]);
    const longName = parseRosterCsv(`1,${'가'.repeat(101)}`);
    expect(longName.ok).toBe(false);
    const longNo = parseRosterCsv(`${'1'.repeat(33)},가`);
    expect(longNo.ok).toBe(false);
  });

  it('인원 상한을 넘으면 거부한다', () => {
    const csv = Array.from({ length: MAX_ROSTER_SIZE + 1 }, (_, i) => `${i + 1},이름`).join('\n');
    expect(parseRosterCsv(csv).ok).toBe(false);
  });

  it('빈 CSV는 빈 명단이다', () => {
    expect(parseRosterCsv('')).toEqual({ ok: true, entries: [] });
    expect(parseRosterCsv('학번,이름\n')).toEqual({ ok: true, entries: [] });
  });
});
