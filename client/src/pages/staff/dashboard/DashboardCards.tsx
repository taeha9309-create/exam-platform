import { useState } from 'react';
import { t } from '../../../copy/ko';
import { postAction, type ProctorActionBody } from '../staffApi';
import { ErrorAlert, useBusy, useStaffError } from '../staffUi';
import { ActionBar } from './ActionBar';
import { StudentCard } from './StudentCard';
import type { Dashboard, NetworkIncident, SortBy } from './useDashboard';

/** 네트워크 장애 의심 배너(SPEC 5.5). 해제(null)되면 사라진다. */
export function NetworkIncidentBanner({ incident }: { incident: NetworkIncident | null }) {
  if (!incident) return null;
  return (
    <div role="status" style={{ background: '#fff3e0', border: '2px solid #ef6c00', borderRadius: 8, padding: '0.6rem 0.75rem', margin: '0.75rem 0' }}>
      <strong>{t.staff.dash.networkIncident(incident.count)}</strong>
      <div>{t.staff.dash.networkIncidentHelp}</div>
    </div>
  );
}

/** 학생 카드 목록(정렬·검색)과 선택한 학생의 조치 막대 */
export function DashboardCards({ dash }: { dash: Dashboard }) {
  const toText = useStaffError();
  const { busy, run } = useBusy();
  const [error, setError] = useState<string | null>(null);
  const [selectedNo, setSelectedNo] = useState<string | null>(null);
  const { cards, allCards, signals } = dash;
  const selected = selectedNo === null ? null : (allCards.find((c) => c.studentNo === selectedNo) ?? null);
  const disabled = busy !== null;

  const act = (attemptId: string, key: string, body: ProctorActionBody): Promise<void> => {
    setError(null);
    return run(key, async () => {
      try {
        await postAction(attemptId, body);
      } catch (err) {
        setError(toText(err)); // 409 BUSY·INVALID_STATE 포함
      }
    });
  };

  return (
    <section aria-label={t.staff.dash.title} style={{ marginTop: '1rem' }}>
      <h3>{t.staff.dash.title}</h3>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.5rem' }}>
        <label>
          {t.staff.dash.search} <input type="search" value={dash.query} onChange={(e) => dash.setQuery(e.target.value)} />
        </label>
        <label>
          {t.staff.dash.sort}{' '}
          <select value={dash.sortBy} onChange={(e) => dash.setSortBy(e.target.value as SortBy)}>
            <option value="STUDENT_NO">{t.staff.dash.sortStudentNo}</option>
            <option value="NEEDS_ATTENTION">{t.staff.dash.sortAttention}</option>
          </select>
        </label>
      </div>
      <ErrorAlert message={error} />
      {selected && selected.attemptId !== null ? (
        <ActionBar card={selected} busy={disabled} onAct={(body) => act(selected.attemptId!, `action-${body.type}`, body)} />
      ) : (
        <p style={{ color: '#555' }}>{t.staff.dash.noTarget}</p>
      )}
      {cards.length === 0 ? (
        <p>{dash.query.trim() ? t.staff.dash.noMatch : t.staff.dash.empty}</p>
      ) : (
        <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))', gap: '0.6rem', padding: 0 }}>
          {cards.map((c) => (
            <StudentCard
              key={c.studentNo}
              card={c}
              detail={c.attemptId ? signals.get(c.attemptId) : undefined}
              selected={selectedNo === c.studentNo}
              busy={disabled}
              onSelect={() => setSelectedNo((cur) => (cur === c.studentNo ? null : c.studentNo))}
              onAck={() => c.attemptId && void act(c.attemptId, `ack-${c.studentNo}`, { type: 'ACK' })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
