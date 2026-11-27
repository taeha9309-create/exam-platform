import { t } from '../../copy/ko';
import styles from './student.module.css';

/** P-05(승인 대기): 지각 입장 또는 중복 접속의 감독관 승인을 기다린다. */
export function PendingApproval({ duplicate = false, error }: { duplicate?: boolean; error?: string | null }) {
  return (
    <main className={styles.page}>
      <h1>{t.student.pending.title}</h1>
      <p role="status">{t.student.pending.body}</p>
      {duplicate ? <p className={styles.hint}>{t.student.pending.duplicateBody}</p> : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </main>
  );
}
