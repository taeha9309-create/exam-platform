import { t } from '../../copy/ko';
import styles from './student.module.css';

/** P-02 본인 확인: "○○○(학번) 님이 맞습니까?" */
export function ConfirmStep({
  studentNo,
  name,
  busy,
  error,
  onYes,
  onNo,
}: {
  studentNo: string;
  name: string;
  busy: boolean;
  error: string | null;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <main className={styles.page}>
      <h1>{t.student.entry.title}</h1>
      <p>{t.student.confirm.question(studentNo, name)}</p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.row}>
        <button type="button" onClick={onYes} disabled={busy}>
          {busy ? t.student.confirm.working : t.student.confirm.yes}
        </button>
        <button type="button" onClick={onNo} disabled={busy}>
          {t.student.confirm.no}
        </button>
      </div>
    </main>
  );
}
