import { VIOLATION_LIMIT } from '@exam/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { drafts } from '../../student/session';
import { type AnswerValue, type AutosaveSocket, codePointLength, MAX_TEXT_LENGTH, useAutosave } from '../../student/useAutosave';
import { getStudentExam, postSubmit, type StudentExam } from '../../student/studentApi';
import { Dialog } from '../staff/staffUi';
import styles from './student.module.css';
import { errorCodeOf, studentErrorText } from './studentUi';

const pad = (n: number) => String(n).padStart(2, '0');
const formatClock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${pad(m)}:${pad(total % 60)}`;
}
const isAnswered = (v: AnswerValue | undefined) => !!v && ('choiceId' in v ? v.choiceId !== '' : v.text.trim() !== '');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ExamTakingProps {
  examCode: string;
  token: string;
  socket: AutosaveSocket | null;
  state: 'ACTIVE' | 'PAUSED';
  deadline: number | null;
  clock: { now(): number };
  violationCount: number;
  connected: boolean;
  /** GET /api/student/attempt로 서버 상태를 다시 읽는다 */
  onRefresh: () => void;
}

/** P-06 응시(F-11): 문항 목록·자유 이동·남은 시간(서버 시계)·자동 저장·제출. 감지·위반 처리는 계획 2. */
export function ExamTaking({ examCode, token, socket, state, deadline, clock, violationCount, connected, onRefresh }: ExamTakingProps) {
  const [exam, setExam] = useState<StudentExam | null>(null);
  const [values, setValues] = useState<Record<string, AnswerValue>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const submitRunning = useRef(false);
  const loading = useRef(false);
  const staleRef = useRef<() => void>(() => {});

  const autosave = useAutosave({ socket, examCode, enabled: state === 'ACTIVE', onStale: () => staleRef.current(), onNotActive: onRefresh });
  const { adopt, restore } = autosave;

  const applyServer = useCallback(
    (data: StudentExam, keepDrafts: boolean) => {
      // adopt()는 그 문항의 초안을 지우므로, 되살릴 초안은 먼저 읽어 둔다.
      const savedDrafts = keepDrafts ? new Map(data.questions.map((q) => [q.id, drafts.load(examCode, q.id)])) : null;
      adopt(data.answers.map((a) => ({ questionId: a.questionId, rev: a.rev })));
      const serverRev = new Map(data.answers.map((a) => [a.questionId, a.rev]));
      const next: Record<string, AnswerValue> = {};
      for (const a of data.answers) {
        if (a.choiceId !== undefined) next[a.questionId] = { choiceId: a.choiceId };
        else if (a.text !== undefined) next[a.questionId] = { text: a.text };
      }
      if (savedDrafts) {
        for (const q of data.questions) {
          const d = savedDrafts.get(q.id);
          if (!d) continue;
          const matches = q.type === 'MCQ' ? d.choiceId !== undefined : d.text !== undefined;
          if (!matches || d.rev <= (serverRev.get(q.id) ?? 0)) {
            drafts.remove(examCode, q.id); // 서버가 더 새롭거나 같다
            continue;
          }
          const value: AnswerValue = d.choiceId !== undefined ? { choiceId: d.choiceId } : { text: d.text ?? '' };
          next[q.id] = value;
          restore(q.id, value, d.rev); // 같은 rev로 다시 보낸다
        }
      }
      setValues((prev) => (keepDrafts ? next : { ...prev, ...next }));
      setExam(data);
    },
    [adopt, restore, examCode],
  );

  const load = useCallback(
    async (keepDrafts: boolean) => {
      if (loading.current) return;
      loading.current = true;
      try {
        applyServer(await getStudentExam(token), keepDrafts);
        setLoadError(null);
      } catch (err) {
        if (errorCodeOf(err) === 'NOT_ACTIVE') onRefresh();
        else setLoadError(studentErrorText(err));
      } finally {
        loading.current = false;
      }
    },
    [applyServer, token, onRefresh],
  );
  staleRef.current = () => void load(false);

  useEffect(() => {
    if (state === 'ACTIVE' && !exam && !loadError) void load(true);
  }, [state, exam, loadError, load]);

  // 남은 시간 표시용 1초 틱
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = deadline === null ? null : Math.max(0, deadline - clock.now());
  const expired = remaining === 0 && state === 'ACTIVE';
  // 마감이 지났는데 아직 ACTIVE면 서버가 제출 처리할 때까지(1초 주기) 상태를 다시 확인한다.
  useEffect(() => {
    if (!expired) return;
    onRefresh();
    const id = setInterval(onRefresh, 2000);
    return () => clearInterval(id);
  }, [expired, onRefresh]);

  const questions = exam?.questions ?? [];
  const unanswered = questions.filter((q) => !isAnswered(values[q.id])).length;

  const onChange = (questionId: string, value: AnswerValue) => {
    setValues((prev) => ({ ...prev, [questionId]: value }));
    autosave.change(questionId, value);
  };

  const submit = async () => {
    if (submitRunning.current) return;
    submitRunning.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (!(await autosave.flushAll())) {
        setSubmitError(t.student.taking.unsavedBlock);
        return;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await postSubmit(token);
          break;
        } catch (err) {
          if (errorCodeOf(err) === 'BUSY' && attempt < 3) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }
      setConfirming(false);
      onRefresh();
    } catch (err) {
      setSubmitError(studentErrorText(err));
      if (err instanceof ApiError && err.code === 'NOT_ACTIVE') onRefresh();
    } finally {
      submitRunning.current = false;
      setSubmitting(false);
    }
  };

  const q = questions[current];
  const value = q ? values[q.id] : undefined;
  const savedText = autosave.pending ? t.student.taking.saving : autosave.savedAt ? t.student.taking.saved(formatClock(autosave.savedAt)) : null;

  return (
    <div>
      <div className={styles.recording}>
        <span>{t.student.taking.recording}</span>
        <span>{t.student.taking.violationCounter(violationCount, VIOLATION_LIMIT)}</span>
      </div>
      <main className={styles.page}>
        <div className={styles.row}>
          <span>{t.student.taking.remaining}</span>
          <span role="timer" aria-label={t.student.taking.remaining} className={styles.timer}>
            {remaining === null ? '--:--' : formatRemaining(remaining)}
          </span>
          {savedText ? <span className={styles.hint}>{savedText}</span> : null}
        </div>
        {!connected ? (
          <p role="status" className={styles.warn}>
            {t.student.taking.socketDown}
          </p>
        ) : null}

        {state === 'PAUSED' ? (
          <div role="alert" className={styles.lock}>
            {t.student.taking.paused}
          </div>
        ) : loadError ? (
          <div>
            <p role="alert" className={styles.error}>
              {t.student.taking.loadFailed} {loadError}
            </p>
            <button type="button" onClick={() => void load(!exam)}>
              {t.student.taking.retry}
            </button>
          </div>
        ) : !exam ? (
          <p>{t.student.loading}</p>
        ) : (
          <div className={styles.takingLayout}>
            <nav aria-label={t.student.taking.questionList}>
              <ol className={styles.qList}>
                {questions.map((item, i) => (
                  <li key={item.id}>
                    <button type="button" className={`${styles.qButton} ${i === current ? styles.qButtonCurrent : ''}`} aria-current={i === current ? 'true' : undefined} onClick={() => setCurrent(i)}>
                      {t.student.taking.questionLabel(i + 1)}{' '}
                      <span className={isAnswered(values[item.id]) ? styles.qDone : styles.hint}>{isAnswered(values[item.id]) ? t.student.taking.answered : t.student.taking.unanswered}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <p>
                <button type="button" onClick={() => setConfirming(true)} disabled={submitting}>
                  {t.student.taking.submit}
                </button>
              </p>
            </nav>
            {q ? (
              <section aria-labelledby={`q-${q.id}`}>
                <h2 id={`q-${q.id}`}>
                  {t.student.taking.questionLabel(current + 1)} <span className={styles.hint}>({t.student.taking.points(q.points)})</span>
                </h2>
                <p className={styles.prompt}>{q.prompt}</p>
                {q.type === 'MCQ' ? (
                  <div role="radiogroup" aria-labelledby={`q-${q.id}`}>
                    {(q.choices ?? []).map((c) => (
                      <label key={c.id} className={styles.choice}>
                        <input type="radio" name={`choice-${q.id}`} checked={!!value && 'choiceId' in value && value.choiceId === c.id} onChange={() => onChange(q.id, { choiceId: c.id })} />
                        {c.text}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className={styles.field}>
                    <label htmlFor={`essay-${q.id}`}>{t.student.taking.essayLabel}</label>
                    <textarea
                      id={`essay-${q.id}`}
                      className={styles.textarea}
                      value={value && 'text' in value ? value.text : ''}
                      onChange={(e) => onChange(q.id, { text: e.target.value })}
                      onCompositionStart={autosave.compositionStart}
                      onCompositionEnd={autosave.compositionEnd}
                    />
                    <span className={styles.hint}>{t.student.taking.charCount(codePointLength(value && 'text' in value ? value.text : ''), MAX_TEXT_LENGTH)}</span>
                  </div>
                )}
                {autosave.errors[q.id] === 'TOO_LONG' ? (
                  <p role="alert" className={styles.error}>
                    {t.student.taking.tooLong(MAX_TEXT_LENGTH)}
                  </p>
                ) : autosave.errors[q.id] ? (
                  <p role="alert" className={styles.error}>
                    {t.student.taking.invalidAnswer}
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
        {submitError && !confirming ? (
          <p role="alert" className={styles.error}>
            {submitError}
          </p>
        ) : null}
      </main>

      {confirming ? (
        <Dialog title={t.student.taking.confirmTitle} onClose={() => (submitting ? undefined : setConfirming(false))}>
          <p>{t.student.taking.confirmBody(unanswered)}</p>
          {submitError ? (
            <p role="alert" className={styles.error}>
              {submitError}
            </p>
          ) : null}
          <div className={styles.row}>
            <button type="button" autoFocus onClick={() => setConfirming(false)} disabled={submitting}>
              {t.student.taking.cancel}
            </button>
            <button type="button" className={styles.danger} onClick={() => void submit()} disabled={submitting}>
              {submitting ? t.student.taking.submitting : t.student.taking.confirmSubmit}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
