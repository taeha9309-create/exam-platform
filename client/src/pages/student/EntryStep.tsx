import { useId, useState, type FormEvent } from 'react';
import { t } from '../../copy/ko';
import styles from './student.module.css';

/** P-01 입장: 학번·시험 비밀번호. 비밀번호는 제출하면 곧바로 입력란에서 지운다. */
export function EntryStep({
  examTitle,
  error,
  busy,
  onSubmit,
}: {
  examTitle: string | null;
  error: string | null;
  busy: boolean;
  onSubmit: (studentNo: string, passcode: string) => void;
}) {
  const [studentNo, setStudentNo] = useState('');
  const [passcode, setPasscode] = useState('');
  const id = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const code = passcode;
    setPasscode(''); // 상태에 오래 두지 않는다
    onSubmit(studentNo, code);
  };

  return (
    <main className={styles.page}>
      <h1>{t.student.entry.title}</h1>
      {examTitle ? <p>{t.student.entry.examTitle(examTitle)}</p> : null}
      <form className={styles.stack} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor={`${id}-no`}>{t.student.entry.studentNo}</label>
          <input id={`${id}-no`} value={studentNo} onChange={(e) => setStudentNo(e.target.value)} autoComplete="off" inputMode="numeric" required maxLength={32} />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-pw`}>{t.student.entry.passcode}</label>
          <input id={`${id}-pw`} type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="off" inputMode="numeric" required maxLength={64} />
        </div>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy ? t.student.entry.submitting : t.student.entry.submit}
        </button>
      </form>
    </main>
  );
}
