import { t } from '../../copy/ko';
import styles from './student.module.css';

export type NoticeKind = 'unsupportedBrowser' | 'entryClosed' | 'rejected' | 'revoked' | 'finished' | 'notFound';

/** P-09 안내 화면: 지원하지 않는 브라우저, 입장 마감, 거절, 세션 종료 등. */
export function Notice({ kind, onBack }: { kind: NoticeKind; onBack?: () => void }) {
  return (
    <main className={styles.page}>
      <h1>{t.appName}</h1>
      <div className={styles.notice} role="alert">
        <p>{t.student.notice[kind]}</p>
      </div>
      {onBack ? (
        <p>
          <button type="button" onClick={onBack}>
            {t.student.notice.back}
          </button>
        </p>
      ) : null}
    </main>
  );
}
