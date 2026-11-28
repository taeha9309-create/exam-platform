// 사이드바 열림 의심 판정(SPEC 5.1 SIDEBAR_SUSPECT). 순수 함수.
// 창 바깥 너비는 그대로인데 페이지 안쪽 너비만 80px 이상 줄었을 때만 감지한다.
import { SIDEBAR_MIN_SHRINK_PX } from '@exam/shared';

export interface WindowSize {
  outerWidth: number;
  innerWidth: number;
}

/** 감지되면 줄어든 안쪽 너비(px), 아니면 null. 창 크기를 직접 바꾸면 outer도 변하므로 제외한다. */
export function detectSidebarShrink(prev: WindowSize, next: WindowSize): { deltaInner: number } | null {
  if (prev.outerWidth !== next.outerWidth) return null;
  const deltaInner = prev.innerWidth - next.innerWidth;
  if (deltaInner < SIDEBAR_MIN_SHRINK_PX) return null;
  return { deltaInner };
}
