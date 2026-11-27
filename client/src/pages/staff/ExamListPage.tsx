import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { t } from '../../copy/ko';
import { createExam, deleteExam, listExams, type ExamListItem } from './staffApi';
import { ConfirmDialog, ErrorAlert, PageShell, useBusy, useStaffError } from './staffUi';
import styles from './staff.module.css';

/** 삭제는 DRAFT·ENDED에서만 가능(F-02). OPEN·RUNNING은 서버도 409로 막으므로 버튼을 끈다. */
const canDelete = (status: string) => status === 'DRAFT' || status === 'ENDED';

/** S-02 시험 목록·생성 */
export function ExamListPage() {
  const navigate = useNavigate();
  const toText = useStaffError();
  const [exams, setExams] = useState<ExamListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [durationMin, setDurationMin] = useState('60');
  const [deleteTarget, setDeleteTarget] = useState<ExamListItem | null>(null);
  const { busy, run } = useBusy();

  const reload = useCallback(async () => {
    try {
      setExams((await listExams()).exams);
    } catch (err) {
      setError(toText(err));
    }
  }, [toText]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    void run('create', async () => {
      try {
        const { exam } = await createExam({ title, instructions, durationMin: Number(durationMin) });
        navigate(`/staff/exams/${exam.id}/edit`);
      } catch (err) {
        setError(toText(err));
      }
    });
  };

  const onDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    void run('delete', async () => {
      try {
        await deleteExam(target.id);
        setDeleteTarget(null);
        await reload();
      } catch (err) {
        setDeleteTarget(null);
        setError(toText(err));
      }
    });
  };

  return (
    <PageShell title={t.pages.staffExams} back={false}>
      <ErrorAlert message={error} />
      <section className={styles.panel} aria-label={t.staff.list.newExam}>
        <h2>{t.staff.list.newExam}</h2>
        <form className={styles.stack} onSubmit={onCreate}>
          <label className={styles.field}>
            {t.staff.list.title}
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required />
          </label>
          <label className={styles.field}>
            {t.staff.list.instructions}
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={2000} />
          </label>
          <label className={styles.field}>
            {t.staff.list.duration}
            <input type="number" min={1} max={300} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} required />
          </label>
          <button type="submit" disabled={busy !== null}>
            {t.staff.list.create}
          </button>
        </form>
      </section>

      {exams === null ? (
        error ? null : <p>{t.staff.common.loading}</p>
      ) : exams.length === 0 ? (
        <p>{t.staff.list.empty}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t.staff.list.colTitle}</th>
              <th>{t.staff.list.colStatus}</th>
              <th>{t.staff.list.colOwner}</th>
              <th>{t.staff.list.colAttempts}</th>
              <th>{t.staff.list.colCreated}</th>
              <th>{t.staff.list.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((e) => (
              <tr key={e.id}>
                <td>{e.title}</td>
                <td>{t.staff.status[e.status] ?? e.status}</td>
                <td>{e.ownerName}</td>
                <td>
                  {e.attemptCount}/{e.rosterCount}
                </td>
                <td>{new Date(e.createdAt).toLocaleDateString('ko-KR')}</td>
                <td>
                  <div className={styles.row}>
                    <Link to={`/staff/exams/${e.id}/edit`}>{t.staff.list.edit}</Link>
                    <Link to={`/staff/exams/${e.id}/run`}>{t.staff.list.run}</Link>
                    {e.status === 'ENDED' ? (
                      <>
                        <Link to={`/staff/exams/${e.id}/results`}>{t.staff.list.results}</Link>
                        <Link to={`/staff/exams/${e.id}/survey`}>{t.staff.list.survey}</Link>
                      </>
                    ) : null}
                    <button type="button" disabled={!canDelete(e.status) || busy !== null} onClick={() => setDeleteTarget(e)} aria-describedby={canDelete(e.status) ? undefined : `why-${e.id}`}>
                      {t.staff.list.remove}
                    </button>
                  </div>
                  {canDelete(e.status) ? null : (
                    <p id={`why-${e.id}`} className={styles.hint}>
                      {t.staff.list.removeDisabled}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deleteTarget ? (
        <ConfirmDialog title={t.staff.list.confirmDeleteTitle} body={`${deleteTarget.title} — ${t.staff.list.confirmDeleteBody}`} busy={busy !== null} onConfirm={onDelete} onCancel={() => setDeleteTarget(null)} />
      ) : null}
    </PageShell>
  );
}
