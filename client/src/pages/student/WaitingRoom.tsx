import { t } from '../../copy/ko';
import styles from './student.module.css';

/** P-05(대기실): 시험 시작을 기다린다. 인원 문구는 copy/ko.ts 한 곳(이슈 #52에서 의미 확정 중). */
export function WaitingRoom({ count }: { count: { ready: number; total: number } | null }) {
  return (
    <main className={styles.page}>
      <h1>{t.student.waiting.title}</h1>
      <p role="status">{count ? t.student.waiting.body(count.ready, count.total) : t.student.waiting.bodyNoCount}</p>
    </main>
  );
}
