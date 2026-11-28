/**
 * 부하 측정 스크립트(load-test.ts)의 순수 함수 모음. DB·네트워크 없이 테스트한다.
 * 합격 기준은 SPEC 9장 성공 기준 2·3과 계획 3 Task 1을 그대로 옮긴 것이다.
 */

/** 신호 지연 95% 상한(ms). SPEC 9장 성공 기준 3 */
export const LATENCY_P95_LIMIT_MS = 2000;
/** 실시간성 표본(보낸 신호) 최소 개수 */
export const MIN_SIGNAL_SAMPLES = 100;
/** 부하 전용 데이터베이스 이름. 개발(exam)·테스트(exam_test) DB를 건드리지 않게 이 이름일 때만 시드·삭제한다 */
export const LOAD_DB_NAME = 'exam_load';

/** 가장 가까운 순위(nearest-rank) 백분위. 입력을 바꾸지 않는다. 빈 배열은 null */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const r = (n: number | null): number | null => (n === null ? null : round1(n));
  return { count: values.length, p50: r(percentile(values, 50)), p95: r(percentile(values, 95)), max: r(Math.max(...values)) };
}

/** 보낸 신호 키 중 이 소켓이 받지 못한 개수 */
export function countMissed(sentKeys: readonly string[], receivedKeys: ReadonlySet<string>): number {
  let missed = 0;
  for (const k of sentKeys) if (!receivedKeys.has(k)) missed += 1;
  return missed;
}

export interface EvaluateInput {
  students: number;
  submitted: number;
  http5xx: number;
  /** 교수자 소켓별 수신 누락 수 */
  staffMissed: readonly number[];
  signalCount: number;
  p95: number | null;
  /** 제출 직전 서버에 저장된 답안이 학생이 마지막으로 보낸 답안과 일치한 학생 수 */
  answersPreserved: number;
  /** answer:save·signal ack가 실패(BUSY·INTERNAL·시간 초과 등)한 횟수. 하나라도 있으면 실패 */
  answerAckFail: number;
  signalAckFail: number;
  /** 서버가 ack ok로 받아 준 답안 수의 합. 0이면 "보존 비교"가 빈 비교라 의미가 없다 */
  answersSent: number;
}

export function evaluate(input: EvaluateInput): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (input.submitted !== input.students) failures.push(`제출 ${input.submitted}/${input.students}`);
  if (input.http5xx !== 0) failures.push(`서버 5xx ${input.http5xx}건`);
  input.staffMissed.forEach((n, i) => {
    if (n !== 0) failures.push(`교수자 소켓 ${i + 1} 수신 누락 ${n}건`);
  });
  if (input.signalCount < MIN_SIGNAL_SAMPLES) failures.push(`신호 표본 ${input.signalCount}건(최소 ${MIN_SIGNAL_SAMPLES})`);
  if (input.p95 === null || input.p95 > LATENCY_P95_LIMIT_MS) failures.push(`신호 지연 p95 ${input.p95 ?? '측정 불가'}ms(상한 ${LATENCY_P95_LIMIT_MS})`);
  if (input.answerAckFail !== 0) failures.push(`answer:save ack 실패 ${input.answerAckFail}건`);
  if (input.signalAckFail !== 0) failures.push(`signal ack 실패 ${input.signalAckFail}건`);
  if (input.answersSent <= 0) failures.push('전송에 성공한 답안이 0건(답안 보존을 검증할 수 없음)');
  if (input.answersPreserved !== input.students) failures.push(`답안 보존 ${input.answersPreserved}/${input.students}`);
  return { pass: failures.length === 0, failures };
}

/** 로컬 호스트만 true. 비슷한 이름(localhost.evil.com)·사설망 주소는 false */
export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** 처음 한 번만 실행하는 함수로 감싼다 */
export function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** 결과 JSON에 넣을 DB·서버 설명. 실제 접속 주소에서 계산하며 비밀번호는 넣지 않는다 */
export function describeEnvironment(base: string, databaseUrl: string): { db: string; server: string } {
  const d = new URL(databaseUrl);
  return { db: `PostgreSQL ${d.pathname.replace(/^\//, '')} @ ${d.host}`, server: `${new URL(base).origin} (로컬)` };
}

export interface LoadArgs {
  base: string;
  students: number;
  /** 시험 시작 뒤 학생들이 답안·신호를 보내는 시간(초) */
  runSec: number;
  signalEverySec: number;
  answerEverySec: number;
  out?: string;
}

function intArg(name: string, raw: string | undefined, min: number, max: number): number {
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}은(는) ${min}~${max} 사이의 정수여야 합니다.`);
  return n;
}

/** 명령줄 인자 해석. 로컬 서버(localhost·127.0.0.1)가 아니면 거부한다(운영 서버 보호) */
export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = get('--base');
  if (!base) throw new Error('--base http://localhost:포트 가 필요합니다.');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('--base 값이 올바른 주소가 아닙니다.');
  }
  if (url.protocol !== 'http:' || !isLocalHost(url.hostname)) {
    throw new Error('부하는 로컬 서버(http://localhost 또는 http://127.0.0.1)에만 겁니다. 운영 서버는 허용하지 않습니다.');
  }
  return {
    base: `${url.protocol}//${url.host}`,
    students: get('--students') === undefined ? 20 : intArg('--students', get('--students'), 1, 100),
    runSec: get('--run-sec') === undefined ? 90 : intArg('--run-sec', get('--run-sec'), 10, 1800),
    signalEverySec: get('--signal-every-sec') === undefined ? 12 : intArg('--signal-every-sec', get('--signal-every-sec'), 1, 600),
    answerEverySec: get('--answer-every-sec') === undefined ? 10 : intArg('--answer-every-sec', get('--answer-every-sec'), 1, 600),
    out: get('--out'),
  };
}

/** DATABASE_URL이 부하 전용 DB(exam_load)를 가리키는지 확인하고 DB 이름을 돌려준다. 아니면 던진다 */
export function assertLoadDatabase(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error(`DATABASE_URL이 필요합니다(${LOAD_DB_NAME} 데이터베이스를 가리켜야 합니다).`);
  const url = new URL(databaseUrl);
  if (!isLocalHost(url.hostname)) throw new Error('DATABASE_URL의 호스트가 localhost 또는 127.0.0.1이 아닙니다. 부하 전용 DB는 로컬에서만 씁니다.');
  const name = url.pathname.replace(/^\//, '');
  if (name !== LOAD_DB_NAME) throw new Error(`DATABASE_URL의 데이터베이스 이름이 ${LOAD_DB_NAME}이(가) 아닙니다. 개발·테스트 DB에는 부하를 걸지 않습니다.`);
  return name;
}
