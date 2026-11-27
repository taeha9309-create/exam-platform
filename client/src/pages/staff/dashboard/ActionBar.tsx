import type { AttemptSummary } from '@exam/shared';
import { useEffect, useState } from 'react';
import { t } from '../../../copy/ko';
import type { ProctorActionBody } from '../staffApi';
import { ConfirmDialog } from '../staffUi';

const parseMinutes = (s: string): number | null => (/^\d+$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= 60 ? Number(s) : null);

/** 잠겨 있던 시간(분, 올림). 화면에 보여 주기만 하며 실제 값은 서버가 계산한다(5.7). */
const pausedMinutes = (pausedAt: number | null, now: number) => (pausedAt === null ? 1 : Math.max(1, Math.ceil((now - pausedAt) / 60_000)));

/** 선택한 학생 한 명에게 하는 조치(F-16). 사유가 비면 조치 버튼은 비활성이다(ACK는 카드의 [확인]). */
export function ActionBar({ card, busy, onAct }: { card: AttemptSummary; busy: boolean; onAct: (body: ProctorActionBody) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('10');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 학생을 바꾸면 입력을 비운다
  useEffect(() => {
    setReason('');
    setConfirmEnd(false);
  }, [card.studentNo]);
  // 잠겨 있던 시간 표시용 시계(표시만)
  useEffect(() => {
    if (card.state !== 'PAUSED') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [card.state]);

  const trimmed = reason.trim();
  const noReason = trimmed.length === 0;
  const mins = parseMinutes(minutes);
  const active = card.state === 'ACTIVE';
  const paused = card.state === 'PAUSED';
  const off = busy || noReason;

  return (
    <section aria-label={t.staff.dash.actionsFor(card.name, card.studentNo)} style={{ border: '1px solid #bbb', borderRadius: 8, padding: '0.75rem', margin: '0.75rem 0' }}>
      <h4 style={{ margin: '0 0 0.5rem' }}>{t.staff.dash.actionsFor(card.name, card.studentNo)}</h4>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label htmlFor="proctor-reason">{t.staff.dash.reasonLabel}</label>
        <input id="proctor-reason" value={reason} maxLength={500} style={{ minWidth: '18rem' }} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
        {[t.staff.dash.quickOk, t.staff.dash.quickSelf, t.staff.dash.quickWarn].map((q) => (
          <button key={q} type="button" onClick={() => setReason(q)}>
            {q}
          </button>
        ))}
      </div>
      {noReason ? <p style={{ margin: '0.25rem 0', color: '#555' }}>{t.staff.dash.reasonRequired}</p> : null}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {active ? (
          <button type="button" disabled={off} onClick={() => void onAct({ type: 'PAUSE', reason: trimmed })}>
            {t.staff.dash.pause}
          </button>
        ) : null}
        {paused ? (
          <>
            <button type="button" disabled={off} onClick={() => void onAct({ type: 'RESUME', reason: trimmed })}>
              {t.staff.dash.resume}
            </button>
            {card.locked ? (
              <button type="button" disabled={off} onClick={() => void onAct({ type: 'RESUME', reason: trimmed, payload: { addPausedTime: true } })}>
                {t.staff.dash.resumeAddTime(pausedMinutes(card.pausedAt, now))}
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" disabled={off} onClick={() => void onAct({ type: 'WARN', reason: trimmed })}>
          {t.staff.dash.warn}
        </button>
        <button type="button" style={{ color: '#b00020' }} disabled={off} onClick={() => setConfirmEnd(true)}>
          {t.staff.dash.terminate}
        </button>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
        <label htmlFor="proctor-minutes">{t.staff.dash.minutes}</label>
        <input id="proctor-minutes" inputMode="numeric" value={minutes} style={{ width: '4rem' }} aria-invalid={mins === null} onChange={(e) => setMinutes(e.target.value)} />
        <button type="button" disabled={off || mins === null} onClick={() => mins !== null && void onAct({ type: 'ADD_TIME', reason: trimmed, payload: { minutes: mins } })}>
          {t.staff.dash.addTime}
        </button>
        {mins === null ? <span role="note">{t.staff.dash.minutesInvalid}</span> : null}
      </div>
      {confirmEnd ? (
        <ConfirmDialog
          title={t.staff.dash.terminateConfirmTitle}
          body={t.staff.dash.terminateConfirmBody}
          busy={busy}
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            void onAct({ type: 'TERMINATE', reason: trimmed }).finally(() => setConfirmEnd(false));
          }}
        />
      ) : null}
    </section>
  );
}
