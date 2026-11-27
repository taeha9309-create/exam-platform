import { useRef, useState } from 'react';
import { t } from '../../copy/ko';
import { postConsent, type AttemptView } from '../../student/studentApi';
import styles from './student.module.css';
import { studentErrorText } from './studentUi';

/** P-03 사전 고지·동의(F-08). 동의하지 않으면 다음 단계로 갈 수 없다. */
export function ConsentStep({ token, onUpdate }: { token: string; onUpdate: (view: AttemptView) => void }) {
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const c = t.student.consent;

  const answer = async (agree: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const view = await postConsent(token, agree);
      if (agree) onUpdate(view);
      else setDeclined(true);
    } catch (err) {
      setError(studentErrorText(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  if (declined) {
    return (
      <main className={styles.page}>
        <h1>{c.title}</h1>
        <p role="alert">{c.declinedBody}</p>
        <button type="button" onClick={() => setDeclined(false)}>
          {c.review}
        </button>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1>{c.title}</h1>
      <p>{c.intro}</p>
      <h2>{c.collectTitle}</h2>
      <ul>
        {c.collectItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h2>{c.purposeTitle}</h2>
      <p>{c.purpose}</p>
      <h2>{c.retentionTitle}</h2>
      <p>{c.retention}</p>
      <p>{c.noJudgement}</p>
      <p>{c.pasteRecord}</p>
      <p className={styles.warn}>{c.violationRule}</p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.row}>
        <button type="button" onClick={() => void answer(true)} disabled={busy}>
          {c.agree}
        </button>
        <button type="button" onClick={() => void answer(false)} disabled={busy}>
          {c.decline}
        </button>
      </div>
    </main>
  );
}
