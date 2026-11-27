import { useRef, useState } from 'react';
import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { codePointLength } from '../../student/useAutosave';
import { postSurvey } from '../../student/studentApi';
import styles from './student.module.css';
import { studentErrorText } from './studentUi';

const COMMENT_MAX = 1000;

/** P-08 제출 완료 + 종료 설문(F-18). 난이도·의견은 선택, [건너뛰기] 가능. 안내 문구는 익명 저장과 한계를 함께 알린다. */
export function SubmittedSurvey({
  token,
  terminated,
  surveyDone,
  onFinished,
}: {
  token: string;
  terminated: boolean;
  surveyDone: boolean;
  onFinished: () => void;
}) {
  const s = t.student.submitted;
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<'sent' | 'skipped' | null>(surveyDone ? 'sent' : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const tooLong = codePointLength(comment) > COMMENT_MAX;

  const send = async (skip: boolean) => {
    if (running.current || (!skip && tooLong)) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: { difficulty?: number; comment?: string } = {};
      if (!skip) {
        if (difficulty !== null) body.difficulty = difficulty;
        if (comment.trim()) body.comment = comment.trim();
      }
      await postSurvey(token, body);
      setDone(skip ? 'skipped' : 'sent');
      onFinished();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_SUBMITTED') {
        setDone('sent'); // 이미 낸 설문(새로고침 등): 중복 응답은 서버가 막는다
        onFinished();
      } else setError(studentErrorText(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <h1>{s.title}</h1>
      <p>{terminated ? s.terminated : s.body}</p>
      {done ? (
        <p role="status">{done === 'sent' ? s.done : s.skipped}</p>
      ) : (
        <form
          className={styles.stack}
          aria-labelledby="survey-title"
          onSubmit={(e) => {
            e.preventDefault();
            void send(false);
          }}
        >
          <h2 id="survey-title">{s.surveyTitle}</h2>
          <fieldset>
            <legend>{s.difficulty}</legend>
            {s.difficultyLevels.map((label, i) => (
              <label key={label} className={styles.choice}>
                <input type="radio" name="difficulty" value={i + 1} checked={difficulty === i + 1} onChange={() => setDifficulty(i + 1)} />
                {label}
              </label>
            ))}
          </fieldset>
          <div className={styles.field}>
            <label htmlFor="survey-comment">{s.comment}</label>
            <textarea id="survey-comment" className={styles.textarea} value={comment} onChange={(e) => setComment(e.target.value)} />
            <span className={styles.hint}>{s.commentCount(codePointLength(comment), COMMENT_MAX)}</span>
          </div>
          <p className={styles.hint}>{s.anonymousNote}</p>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <div className={styles.row}>
            <button type="submit" disabled={busy || tooLong}>
              {busy ? s.sending : s.send}
            </button>
            <button type="button" onClick={() => void send(true)} disabled={busy}>
              {s.skip}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
