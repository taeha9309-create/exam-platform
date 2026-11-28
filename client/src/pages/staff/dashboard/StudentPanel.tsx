// 학생 상세 패널(S-05, F-15): 학생 정보·상태·남은 시간·신호 타임라인·조치 기록. 서버 문자열은 React 텍스트로만 그린다.
import { VIOLATION_LIMIT, type AttemptSummary, type SignalDto } from '@exam/shared';
import { useEffect, useState } from 'react';
import { t } from '../../../copy/ko';
import { getTimeline, type TimelineResponse } from '../staffApi';
import { ErrorAlert, useStaffError } from '../staffUi';
import { stateLabel } from './StudentCard';
import { describeAction, describeSignal } from './timelineText';

const P = t.staff.panel;
const fmt = (ms: number) => new Date(ms).toLocaleTimeString('ko-KR', { hour12: false });

/** 마감(deadline)에는 추가 시간이 이미 포함돼 있다. 일시정지 중에는 멈춘 시각 기준. */
function remainingText(card: AttemptSummary, now: number): string {
  if (card.deadline === null) return P.noDeadline;
  const ref = card.state === 'PAUSED' && card.pausedAt !== null ? card.pausedAt : now;
  const sec = Math.max(0, Math.floor((card.deadline - ref) / 1000));
  if (sec === 0 && card.state !== 'PAUSED') return P.timeUp;
  return P.remainingValue(Math.floor(sec / 60), sec % 60);
}

export function StudentPanel({
  card,
  subscribeSignals,
  clock,
  onClose,
}: {
  card: AttemptSummary;
  /** 서버 시계(스냅샷 serverNow 보정) */
  clock: { now(): number };
  subscribeSignals: (fn: (attemptId: string, signal: SignalDto) => void) => () => void;
  onClose: () => void;
}) {
  const attemptId = card.attemptId;
  const toText = useStaffError();
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<SignalDto[]>([]);
  const [now, setNow] = useState(() => clock.now());
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), 1000);
    return () => clearInterval(id);
  }, [clock]);

  // 조회 응답보다 먼저 온 신호도 놓치지 않도록 구독은 조회와 별개로 먼저 건다.
  useEffect(() => {
    if (attemptId === null) return;
    return subscribeSignals((id, signal) => {
      if (id !== attemptId) return;
      setLive((cur) => (cur.some((s) => s.id === signal.id) ? cur : [...cur, signal]));
    });
  }, [attemptId, subscribeSignals]);

  useEffect(() => {
    if (attemptId === null) return;
    let cancelled = false;
    setError(null);
    getTimeline(attemptId).then(
      (res) => {
        if (!cancelled) setData(res);
      },
      (err: unknown) => {
        if (!cancelled) setError(toText(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // toText는 렌더마다 바뀔 수 있어 의존성에서 뺀다(오류 문구 변환 용도)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, tries]);

  const fetched = data ? [...data.signals].sort((a, b) => a.receivedAt - b.receivedAt) : [];
  const seen = new Set(fetched.map((s) => s.id));
  const signals = data ? [...fetched, ...live.filter((s) => !seen.has(s.id))] : [];

  return (
    <aside role="dialog" aria-label={P.title(card.name, card.studentNo)} style={{ border: '2px solid #1565c0', borderRadius: 8, padding: '0.75rem', margin: '1rem 0', background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h4 style={{ margin: 0 }}>{P.title(card.name, card.studentNo)}</h4>
        <button type="button" onClick={onClose}>
          {P.close}
        </button>
      </div>
      <dl>
        <dt>{P.state}</dt>
        <dd>{stateLabel(card)}</dd>
        <dt>{P.violations}</dt>
        <dd>{t.staff.dash.violations(card.violationCount, VIOLATION_LIMIT)}</dd>
        <dt>{P.remaining}</dt>
        <dd>
          {remainingText(card, now)}
          {card.extraSeconds > 0 ? ` (${P.extraTime(Math.round(card.extraSeconds / 60))})` : ''}
        </dd>
      </dl>
      <ErrorAlert message={error ? `${P.loadFailed} ${error}` : null} />
      {error ? (
        <button type="button" onClick={() => setTries((n) => n + 1)}>
          {P.retry}
        </button>
      ) : null}
      {!data && !error ? <p role="status">{P.loading}</p> : null}
      {data ? (
        <>
          <h5>{P.timelineTitle}</h5>
          {data.truncated ? <p>{P.truncated}</p> : null}
          {signals.length === 0 ? (
            <p>{P.noSignals}</p>
          ) : (
            <ol aria-label={P.timelineTitle}>
              {signals.map((s) => (
                <li key={s.id} data-testid="signal-item">
                  <small>{fmt(s.receivedAt)}</small> {describeSignal(s)}
                </li>
              ))}
            </ol>
          )}
          <h5>{P.actionsTitle}</h5>
          {data.actions.length === 0 ? (
            <p>{P.noActions}</p>
          ) : (
            <ul aria-label={P.actionsTitle}>
              {data.actions.map((a) => (
                <li key={a.id} data-testid="action-item">
                  <small>{fmt(a.createdAt)}</small> {describeAction(a.type)} · {a.staffName ?? P.noStaff}
                  {a.reason ? ` · ${P.reasonLabel}: ${a.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </aside>
  );
}
