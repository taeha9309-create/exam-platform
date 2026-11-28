import { describe, expect, it } from 'vitest';
import { assertLoadDatabase, countMissed, evaluate, parseLoadArgs, percentile, summarizeLatencies, LATENCY_P95_LIMIT_MS } from './load-test-lib';

describe('percentile (가장 가까운 순위 방식)', () => {
  it('빈 배열은 NaN이 아니라 null', () => {
    expect(percentile([], 95)).toBeNull();
  });
  it('1..100에서 p50=50, p95=95, p100=100', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
  });
  it('정렬되지 않은 입력도 원본을 바꾸지 않고 처리한다', () => {
    const v = [5, 1, 3];
    expect(percentile(v, 50)).toBe(3);
    expect(v).toEqual([5, 1, 3]);
  });
  it('표본 1개면 모든 백분위가 그 값', () => {
    expect(percentile([42], 1)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('summarizeLatencies', () => {
  it('p50·p95·max·표본 수를 소수 첫째 자리로 반올림한다', () => {
    const s = summarizeLatencies([10.04, 20.06, 30, 40, 1000.123]);
    expect(s).toEqual({ count: 5, p50: 30, p95: 1000.1, max: 1000.1 });
  });
  it('표본이 없으면 null 값', () => {
    expect(summarizeLatencies([])).toEqual({ count: 0, p50: null, p95: null, max: null });
  });
});

describe('countMissed', () => {
  it('보낸 키 중 받은 키에 없는 개수', () => {
    expect(countMissed(['a', 'b', 'c'], new Set(['a', 'c', 'zzz']))).toBe(1);
    expect(countMissed([], new Set())).toBe(0);
  });
});

describe('evaluate (합격 기준)', () => {
  const ok = { students: 20, submitted: 20, http5xx: 0, staffMissed: [0, 0], signalCount: 120, p95: 150, answersPreserved: 20 };
  it('모두 만족하면 통과', () => {
    expect(evaluate(ok)).toEqual({ pass: true, failures: [] });
  });
  it('제출 부족·5xx·누락·지연·표본 부족·답안 불일치를 각각 잡는다', () => {
    expect(evaluate({ ...ok, submitted: 19 }).failures).toHaveLength(1);
    expect(evaluate({ ...ok, http5xx: 1 }).failures).toHaveLength(1);
    expect(evaluate({ ...ok, staffMissed: [0, 2] }).failures).toHaveLength(1);
    expect(evaluate({ ...ok, p95: LATENCY_P95_LIMIT_MS + 0.1 }).failures).toHaveLength(1);
    expect(evaluate({ ...ok, signalCount: 99 }).failures).toHaveLength(1);
    expect(evaluate({ ...ok, answersPreserved: 19 }).failures).toHaveLength(1);
  });
  it('p95가 정확히 2000ms면 통과(이하)', () => {
    expect(evaluate({ ...ok, p95: LATENCY_P95_LIMIT_MS }).pass).toBe(true);
  });
  it('p95가 null(표본 없음)이면 실패', () => {
    expect(evaluate({ ...ok, p95: null }).pass).toBe(false);
  });
});

describe('parseLoadArgs', () => {
  it('--base 필수', () => {
    expect(() => parseLoadArgs([])).toThrow(/--base/);
  });
  it('기본값과 덮어쓰기', () => {
    const a = parseLoadArgs(['--base', 'http://localhost:3200']);
    expect(a).toMatchObject({ base: 'http://localhost:3200', students: 20, runSec: 90, signalEverySec: 12, answerEverySec: 10 });
    const b = parseLoadArgs(['--base', 'http://localhost:3200/', '--students', '5', '--run-sec', '20', '--out', 'x.json']);
    expect(b).toMatchObject({ base: 'http://localhost:3200', students: 5, runSec: 20, out: 'x.json' });
  });
  it('원격(운영) 주소는 거부한다: 로컬(localhost·127.0.0.1)만', () => {
    expect(() => parseLoadArgs(['--base', 'https://exam.onrender.com'])).toThrow(/localhost/);
  });
  it('학생 수는 1~100 정수', () => {
    expect(() => parseLoadArgs(['--base', 'http://localhost:1', '--students', '0'])).toThrow();
    expect(() => parseLoadArgs(['--base', 'http://localhost:1', '--students', 'abc'])).toThrow();
    expect(() => parseLoadArgs(['--base', 'http://localhost:1', '--students', '101'])).toThrow();
  });
});

describe('assertLoadDatabase (전용 DB 보호)', () => {
  it('데이터베이스 이름이 exam_load일 때만 통과', () => {
    expect(assertLoadDatabase('postgresql://exam:exam@localhost:5432/exam_load')).toBe('exam_load');
    expect(assertLoadDatabase('postgresql://exam:exam@localhost:5432/exam_load?schema=public')).toBe('exam_load');
  });
  it('개발 DB·테스트 DB·없는 값은 거부', () => {
    expect(() => assertLoadDatabase('postgresql://exam:exam@localhost:5432/exam')).toThrow(/exam_load/);
    expect(() => assertLoadDatabase('postgresql://exam:exam@localhost:5432/exam_test')).toThrow(/exam_load/);
    expect(() => assertLoadDatabase(undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertLoadDatabase('not a url')).toThrow();
  });
});
