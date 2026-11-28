import { VIOLATION_LIMIT, type AttemptSummary, type SignalDto } from '@exam/shared';
import { t } from '../../../copy/ko';

type Tone = 'green' | 'yellow' | 'red' | 'neutral';

const TONE_STYLE: Record<Tone, { background: string; borderColor: string }> = {
  green: { background: '#e8f5e9', borderColor: '#2e7d32' },
  yellow: { background: '#fff8e1', borderColor: '#f9a825' },
  red: { background: '#ffebee', borderColor: '#c62828' },
  neutral: { background: '#f5f5f5', borderColor: '#bdbdbd' },
};

/** 카드 색(SPEC 5.4): NONE·INFO 초록, WARN 노랑, ALERT 빨강. 잠김은 빨강. 미입장은 색 없음. */
export function cardTone(a: AttemptSummary): Tone {
  if (a.locked) return 'red';
  if (a.state === null) return 'neutral';
  switch (a.unackedSeverity) {
    case 'ALERT':
      return 'red';
    case 'WARN':
      return 'yellow';
    default:
      return 'green';
  }
}

export function stateLabel(a: AttemptSummary): string {
  if (a.state === null) return t.staff.dash.state.NOT_ENTERED;
  if (a.state === 'PAUSED' && a.locked) return t.staff.dash.locked;
  return t.staff.dash.state[a.state];
}

const formatTime = (ms: number) => new Date(ms).toLocaleTimeString('ko-KR', { hour12: false });

export function StudentCard({
  card,
  detail,
  selected,
  busy,
  onSelect,
  onAck,
}: {
  card: AttemptSummary;
  /** `signal:new`로 받은 최근 신호 상세(없으면 요약의 종류만 표시) */
  detail: SignalDto | undefined;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAck: () => void;
}) {
  const tone = cardTone(card);
  const paused = card.state === 'PAUSED';
  const dim = card.state === 'SUBMITTED' || card.state === 'TERMINATED';
  const inRoom = card.state === 'WAITING' || card.state === 'ACTIVE' || card.state === 'PAUSED';
  const last = card.lastSignal;
  const useDetail = detail && last && detail.type === last.type && detail.receivedAt === last.receivedAt;
  const style = {
    ...TONE_STYLE[tone],
    border: `${paused && !card.locked ? 4 : 2}px solid ${paused && !card.locked ? '#757575' : TONE_STYLE[tone].borderColor}`,
    borderRadius: 8,
    padding: '0.6rem 0.75rem',
    opacity: dim ? 0.5 : 1,
    listStyle: 'none',
    outline: selected ? '3px solid #1565c0' : undefined,
  } as const;
  const canAct = card.attemptId !== null && (card.state === 'ACTIVE' || card.state === 'PAUSED');

  return (
    <li
      data-testid="student-card"
      data-student-no={card.studentNo}
      data-tone={tone}
      data-paused={String(paused)}
      data-locked={String(card.locked)}
      data-dim={String(dim)}
      data-severity={card.unackedSeverity}
      style={style}
    >
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>{card.name}</strong>
        <span>{card.studentNo}</span>
        {card.locked ? <span aria-hidden="true">{t.staff.dash.lockMark}</span> : null}
        {card.unackedSeverity === 'INFO' ? <span aria-hidden="true" data-info-dot>●</span> : null}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.3rem 0' }}>
        <span>{stateLabel(card)}</span>
        {inRoom && !card.connected ? <span>{t.staff.dash.disconnected}</span> : null}
        {card.away ? <span>{t.staff.dash.away}</span> : null}
        {card.consentDeclined ? <span>{t.staff.dash.consentDeclined}</span> : null}
      </div>
      <div>{t.staff.dash.violations(card.violationCount, VIOLATION_LIMIT)}</div>
      <div>
        {t.staff.dash.lastSignal}:{' '}
        {last ? (
          <>
            {t.staff.dash.signalSummary(last.type, useDetail ? detail.durationMs : null, useDetail ? detail.meta : null)} <small>{formatTime(last.receivedAt)}</small>
          </>
        ) : (
          t.staff.dash.noSignal
        )}
      </div>
      {card.attemptId !== null ? (
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
          <button type="button" disabled={busy || card.unackedSeverity === 'NONE'} onClick={onAck}>
            {t.staff.dash.ack}
          </button>
          {canAct ? (
            <button type="button" aria-pressed={selected} onClick={onSelect}>
              {t.staff.dash.select}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
