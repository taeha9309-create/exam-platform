// 학생 세션 토큰과 미저장 답안 초안의 저장소. localStorage 접근은 모두 이 파일에 모은다(ADR-005, SPEC 2.3).
// 토큰은 localStorage에 둔다: 새로고침·브라우저 재시작 뒤에도 같은 응시를 이어서 하기 위함이다(SPEC 2.3).
// 대가: XSS가 있으면 읽힌다(문항·보기는 React 기본 이스케이프로만 그리고 dangerouslySetInnerHTML을 쓰지 않는다).
// 토큰이 없으면(저장소를 지웠거나 다른 브라우저) 같은 학번은 "다른 기기"로 취급되어 중복 접속 승인(감독관 승인) 흐름으로 간다.

const tokenKey = (examCode: string) => `exam:${examCode}:token`;
const draftPrefix = (examCode: string) => `exam:${examCode}:draft:`;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 저장소 접근이 막힌 환경(일부 시크릿 모드 등)
  }
}

export const session = {
  get(examCode: string): string | null {
    try {
      return store()?.getItem(tokenKey(examCode)) ?? null;
    } catch {
      return null;
    }
  },
  set(examCode: string, token: string): void {
    try {
      store()?.setItem(tokenKey(examCode), token);
    } catch {
      // 저장하지 못해도 이번 접속은 계속된다(새로고침하면 다시 승인이 필요할 수 있음)
    }
  },
  clear(examCode: string): void {
    try {
      store()?.removeItem(tokenKey(examCode));
    } catch {
      // 무시
    }
  },
  /** 신호 큐와 seq를 지운다(공용 PC에서 이전 응시자의 미전송 신호가 섞이지 않게). 키는 signalQueue.ts의 `exam:{code}:seq`·`:signalQueue`. */
  clearSignals(examCode: string): void {
    try {
      store()?.removeItem(`exam:${examCode}:seq`);
      store()?.removeItem(`exam:${examCode}:signalQueue`);
    } catch {
      // 무시
    }
  },
  /** 토큰과 그 시험의 모든 미저장 초안·신호 큐를 지운다(제출·세션 폐기·안내 화면). */
  clearAll(examCode: string): void {
    session.clear(examCode);
    drafts.clearAll(examCode);
    session.clearSignals(examCode);
  },
};

export interface Draft {
  rev: number;
  text?: string;
  choiceId?: string;
}

function isDraft(v: unknown): v is Draft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.rev !== 'number' || !Number.isSafeInteger(d.rev)) return false;
  const hasText = typeof d.text === 'string';
  const hasChoice = typeof d.choiceId === 'string';
  return hasText !== hasChoice; // 정확히 하나
}

export const drafts = {
  load(examCode: string, questionId: string): Draft | null {
    try {
      const raw = store()?.getItem(draftPrefix(examCode) + questionId);
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      return isDraft(v) ? v : null;
    } catch {
      return null;
    }
  },
  save(examCode: string, questionId: string, draft: Draft): void {
    try {
      store()?.setItem(draftPrefix(examCode) + questionId, JSON.stringify(draft));
    } catch {
      // 용량 초과 등: 서버 저장은 계속된다
    }
  },
  remove(examCode: string, questionId: string): void {
    try {
      store()?.removeItem(draftPrefix(examCode) + questionId);
    } catch {
      // 무시
    }
  },
  clearAll(examCode: string): void {
    try {
      const s = store();
      if (!s) return;
      const prefix = draftPrefix(examCode);
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(prefix)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
    } catch {
      // 무시
    }
  },
};
