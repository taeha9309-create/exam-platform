// 신호·조치를 한 줄 문구로 바꾼다. 관찰된 사실만 적는다(판정 표현 금지, 문구는 ko.ts).
import type { ProctorActionType, SignalDto, SignalType } from '@exam/shared';
import { t } from '../../../copy/ko';

const P = t.staff.panel;
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Record라서 SignalType이 늘면 여기서 컴파일 오류가 난다(문구 누락 방지). */
const DESCRIBE: Record<SignalType, (s: SignalDto) => string> = {
  LEAVE: (s) => P.signalText.LEAVE(s.durationMs),
  LEAVE_START: () => P.signalText.LEAVE_START(),
  FULLSCREEN_EXIT: () => P.signalText.FULLSCREEN_EXIT(),
  PASTE: (s) => P.signalText.PASTE(asNum(s.meta?.length), asBool(s.meta?.blocked)),
  DROP: (s) => P.signalText.DROP(asBool(s.meta?.blocked)),
  MULTI_MONITOR: () => P.signalText.MULTI_MONITOR(),
  DISCONNECT: () => P.signalText.DISCONNECT(),
  RECONNECT: () => P.signalText.RECONNECT(),
  HEARTBEAT_GAP: () => P.signalText.HEARTBEAT_GAP(),
  SEQ_GAP: () => P.signalText.SEQ_GAP(),
};

export function describeSignal(signal: SignalDto): string {
  const fn = (DESCRIBE as Partial<Record<string, (s: SignalDto) => string>>)[signal.type];
  return fn ? fn(signal) : P.unknownSignal;
}

export function describeAction(type: ProctorActionType): string {
  return (P.actionType as Record<string, string>)[type] ?? type;
}
