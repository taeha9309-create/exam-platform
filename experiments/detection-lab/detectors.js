// 원시 브라우저 이벤트에서 "후보 신호"를 만드는 순수 함수 모음. 실험 페이지(lab.js)가 쓰고, Node에서 단위 테스트한다.
// 제품 코드(client/, server/)와 공유하지 않는다(버리는 코드). 판정 문구는 관찰 사실만 다룬다.

const SIDEBAR_MIN_SHRINK_PX = 80;

/**
 * 브라우저 창(outer) 너비는 그대로인데 페이지 영역(inner) 너비만 줄어들면 사이드바 열림 의심.
 * 창을 직접 줄인 경우는 outer도 함께 변하므로 제외한다.
 * @param {{innerWidth:number, outerWidth:number}} prev
 * @param {{innerWidth:number, outerWidth:number}} next
 * @returns {null | {type:'SIDEBAR_SUSPECT', deltaInner:number}}
 */
export function detectSidebarResize(prev, next) {
  if (prev.outerWidth !== next.outerWidth) return null;
  const deltaInner = prev.innerWidth - next.innerWidth;
  if (deltaInner < SIDEBAR_MIN_SHRINK_PX) return null;
  return { type: 'SIDEBAR_SUSPECT', deltaInner };
}

/**
 * 이탈(leave)·복귀(return) 이벤트를 같은 원인(cause)끼리 짝지어 지속 시간을 계산한다.
 * 입력 순서가 뒤섞여 있어도 시각(t)순으로 처리한다. 복귀가 없는 이탈은 end/durationMs가 null.
 * 결과는 이탈 시작 시각순.
 * @param {{t:number, kind:'leave'|'return', cause:string}[]} events
 * @returns {{cause:string, start:number, end:number|null, durationMs:number|null}[]}
 */
export function pairLeaves(events) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const open = new Map(); // cause -> 아직 복귀하지 않은 이탈 항목
  const out = [];
  for (const e of sorted) {
    if (e.kind === 'leave') {
      if (open.has(e.cause)) continue; // 같은 원인의 중복 이탈은 처음 것만 유지
      const item = { cause: e.cause, start: e.t, end: null, durationMs: null };
      open.set(e.cause, item);
      out.push(item);
    } else if (e.kind === 'return') {
      const item = open.get(e.cause);
      if (!item) continue; // 이탈 없는 복귀는 무시
      item.end = e.t;
      item.durationMs = e.t - item.start;
      open.delete(e.cause);
    }
  }
  return out;
}

/**
 * 커서가 페이지 밖에 머문 시간 → 신호 단계(SPEC 5.6). 1초 미만은 기록하지 않는다.
 * @param {number} durationMs
 * @returns {null | {type:'POINTER_LEAVE', severity:'INFO'|'WARN'|'ALERT'}}
 */
export function pointerLeaveSignal(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 1000) return null;
  const severity = durationMs < 3000 ? 'INFO' : durationMs <= 15000 ? 'WARN' : 'ALERT';
  return { type: 'POINTER_LEAVE', severity };
}

/**
 * 페이지에 포커스가 없는데 입력이 발생했는가(에이전트형 AI가 대신 입력하는 경우의 후보 신호).
 * @param {{hasFocus:boolean, inputType:string}} e
 * @returns {boolean}
 */
export function inputWithoutFocus(e) {
  return e.hasFocus === false;
}
