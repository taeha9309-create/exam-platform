import { hasControlChars, hasLoneSurrogate } from '../validation';

export const MAX_ROSTER_SIZE = 1000;
export const MAX_STUDENT_NO_LENGTH = 32;
export const MAX_STUDENT_NAME_LENGTH = 100;
/** 명단 CSV 전체 크기 상한(문자 수). 1000명 × (학번 32 + 이름 100 + 구분 문자)에 여유를 둔 값 */
export const MAX_ROSTER_CSV_LENGTH = 200_000;
/** 오류가 아주 많은 CSV로 응답이 커지지 않게 앞쪽 일부만 돌려준다 */
const MAX_REPORTED_ERRORS = 50;

export interface RosterEntryInput {
  studentNo: string;
  name: string;
}

export interface RosterError {
  /** 원본 CSV 기준 줄 번호(1부터, 헤더·빈 줄 포함) */
  line: number;
  code: 'DUPLICATE' | 'EMPTY' | 'FORMAT';
  message: string;
}

export type RosterParseResult = { ok: true; entries: RosterEntryInput[] } | { ok: false; errors: RosterError[] };

/**
 * `학번,이름` CSV를 해석한다. BOM 제거, CRLF/LF 모두 허용, 빈 줄 무시,
 * 첫 줄이 `학번`으로 시작하면 헤더로 건너뛰고, 값 양끝 공백은 제거한다.
 * 따옴표 처리는 지원하지 않는다(학번·이름에 쉼표가 없다고 가정). 오류는 모두 모아 한 번에 돌려준다.
 */
export function parseRosterCsv(csv: string): RosterParseResult {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const lines = text.split(/\r\n|\n|\r/);
  const errors: RosterError[] = [];
  const entries: RosterEntryInput[] = [];
  const seen = new Set<string>();
  let headerChecked = false;

  const fail = (line: number, code: RosterError['code'], message: string) => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ line, code, message });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    if (!headerChecked) {
      headerChecked = true;
      if (raw.trim().startsWith('학번')) continue;
    }

    const cols = raw.split(',');
    if (cols.length !== 2) {
      fail(lineNo, 'FORMAT', `${lineNo}번째 줄: "학번,이름" 형식이어야 합니다.`);
      continue;
    }
    const studentNo = cols[0]!.trim();
    const name = cols[1]!.trim();
    if (studentNo === '' || name === '') {
      fail(lineNo, 'EMPTY', `${lineNo}번째 줄: 학번과 이름은 비워 둘 수 없습니다.`);
      continue;
    }
    if (
      studentNo.length > MAX_STUDENT_NO_LENGTH ||
      name.length > MAX_STUDENT_NAME_LENGTH ||
      hasControlChars(studentNo, false) ||
      hasControlChars(name, false) ||
      hasLoneSurrogate(studentNo) ||
      hasLoneSurrogate(name)
    ) {
      fail(lineNo, 'FORMAT', `${lineNo}번째 줄: 학번 또는 이름이 너무 길거나 사용할 수 없는 문자가 있습니다.`);
      continue;
    }
    if (seen.has(studentNo)) {
      fail(lineNo, 'DUPLICATE', `${lineNo}번째 줄: 중복 학번`);
      continue;
    }
    seen.add(studentNo);
    entries.push({ studentNo, name });
  }

  if (errors.length === 0 && entries.length > MAX_ROSTER_SIZE) {
    fail(lines.length, 'FORMAT', `명단은 최대 ${MAX_ROSTER_SIZE}명까지 등록할 수 있습니다.`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}
