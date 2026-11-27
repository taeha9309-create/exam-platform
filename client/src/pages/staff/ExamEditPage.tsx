import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useParams } from 'react-router-dom';
import { t } from '../../copy/ko';
import { DetailedApiError, getExam, patchExam, putQuestions, putRoster, type ExamDetail, type QuestionDto, type QuestionError, type RosterError } from './staffApi';
import { ErrorAlert, PageShell, useBusy, useStaffError } from './staffUi';
import styles from './staff.module.css';

type Tab = 'info' | 'questions' | 'roster' | 'settings';
const TABS: Tab[] = ['info', 'questions', 'roster', 'settings'];

/** 화면에서 편집 중인 문항. key는 React 목록용(서버로 보내지 않는다). */
interface DraftQuestion {
  key: number;
  type: 'MCQ' | 'ESSAY';
  prompt: string;
  points: string;
  choices: { id: string; text: string }[];
  correctChoiceId: string;
}

const MAX_CHOICES = 6;

/** 보기 id: 서버는 영숫자·_·-만 받는다. 같은 문항 안에서 겹치지 않게 c1, c2…를 쓴다. */
function nextChoiceId(choices: { id: string }[]): string {
  const used = new Set(choices.map((c) => c.id));
  for (let n = 1; ; n++) if (!used.has(`c${n}`)) return `c${n}`;
}

function toDrafts(questions: QuestionDto[], nextKey: () => number): DraftQuestion[] {
  return questions.map((q) => ({
    key: nextKey(),
    type: q.type,
    prompt: q.prompt,
    points: String(q.points),
    choices: (q.choices ?? []).map((c) => ({ id: c.id, text: c.text })),
    correctChoiceId: q.correctChoiceId ?? '',
  }));
}

function toPayload(d: DraftQuestion): QuestionDto {
  const points = Number(d.points);
  const base = { type: d.type, prompt: d.prompt, points: Number.isFinite(points) ? points : 0 };
  return d.type === 'MCQ' ? { ...base, choices: d.choices, correctChoiceId: d.correctChoiceId || undefined } : base;
}

function isDetails<T>(details: unknown, test: (x: unknown) => boolean): details is T[] {
  return Array.isArray(details) && details.every(test);
}
const isQuestionError = (x: unknown) => typeof x === 'object' && x !== null && typeof (x as QuestionError).index === 'number' && typeof (x as QuestionError).field === 'string';
const isRosterError = (x: unknown) => typeof x === 'object' && x !== null && typeof (x as RosterError).line === 'number';

const rosterToCsv = (roster: ExamDetail['roster']) => roster.map((r) => `${r.studentNo},${r.name}`).join('\n');

/** S-03 시험 편집: 탭(기본정보·문항·명단·설정) */
export function ExamEditPage() {
  const { id = '' } = useParams();
  const toText = useStaffError();
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [tab, setTab] = useState<Tab>('info');
  const [loadError, setLoadError] = useState<string | null>(null);
  const keyCounter = useRef(0);
  const nextKey = () => ++keyCounter.current;

  useEffect(() => {
    let alive = true;
    getExam(id)
      .then(({ exam: e }) => alive && setExam(e))
      .catch((err) => alive && setLoadError(toText(err)));
    return () => {
      alive = false;
    };
  }, [id, toText]);

  return (
    <PageShell title={t.pages.staffEdit}>
      <ErrorAlert message={loadError} />
      {exam === null ? (
        loadError ? null : <p>{t.staff.common.loading}</p>
      ) : (
        <>
          <p>
            {exam.title} — {t.staff.status[exam.status] ?? exam.status}
          </p>
          <div role="tablist" className={styles.tabs}>
            {TABS.map((k) => (
              <button
                key={k}
                role="tab"
                type="button"
                id={`tab-${k}`}
                aria-selected={tab === k}
                aria-controls={`panel-${k}`}
                className={`${styles.tab} ${tab === k ? styles.tabActive : ''}`}
                onClick={() => setTab(k)}
              >
                {t.staff.edit.tabs[k]}
              </button>
            ))}
          </div>
          {TABS.map((k) => (
            <div key={k} role="tabpanel" id={`panel-${k}`} aria-labelledby={`tab-${k}`} hidden={tab !== k}>
              {k === 'info' ? <InfoTab exam={exam} onSaved={setExam} /> : null}
              {k === 'questions' ? <QuestionsTab exam={exam} nextKey={nextKey} onSaved={(questions) => setExam((e) => (e ? { ...e, questions } : e))} /> : null}
              {k === 'roster' ? <RosterTab exam={exam} onSaved={(n) => setExam((e) => (e ? { ...e, rosterCount: n } : e))} /> : null}
              {k === 'settings' ? <SettingsTab exam={exam} onSaved={setExam} /> : null}
            </div>
          ))}
        </>
      )}
    </PageShell>
  );
}

/** 기본정보·설정은 RUNNING 전까지 바꿀 수 있다(SPEC 2.1). */
const settingsEditable = (e: ExamDetail) => e.status === 'DRAFT' || e.status === 'OPEN';

function InfoTab({ exam, onSaved }: { exam: ExamDetail; onSaved: (e: ExamDetail) => void }) {
  const toText = useStaffError();
  const [title, setTitle] = useState(exam.title);
  const [instructions, setInstructions] = useState(exam.instructions);
  const [durationMin, setDurationMin] = useState(String(exam.durationMin));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, run } = useBusy();
  const editable = settingsEditable(exam);

  const save = () => {
    setError(null);
    setSaved(false);
    void run('info', async () => {
      try {
        const res = await patchExam(exam.id, { title, instructions, durationMin: Number(durationMin) });
        onSaved(res.exam);
        setSaved(true);
      } catch (err) {
        setError(toText(err));
      }
    });
  };

  return (
    <div className={styles.stack}>
      {editable ? null : <p className={styles.hint}>{t.staff.edit.settingsLocked}</p>}
      <label className={styles.field}>
        {t.staff.edit.title}
        <input value={title} maxLength={100} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className={styles.field}>
        {t.staff.edit.instructions}
        <textarea value={instructions} maxLength={2000} disabled={!editable} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <label className={styles.field}>
        {t.staff.edit.duration}
        <input type="number" min={1} max={300} value={durationMin} disabled={!editable} onChange={(e) => setDurationMin(e.target.value)} />
      </label>
      <ErrorAlert message={error} />
      {saved ? <p role="status" className={styles.ok}>{t.staff.edit.saved}</p> : null}
      <button type="button" disabled={!editable || busy !== null} onClick={save}>
        {busy ? t.staff.common.saving : t.staff.edit.saveInfo}
      </button>
    </div>
  );
}

function SettingsTab({ exam, onSaved }: { exam: ExamDetail; onSaved: (e: ExamDetail) => void }) {
  const toText = useStaffError();
  const [pasteMode, setPasteMode] = useState(exam.pasteMode);
  const [shuffle, setShuffle] = useState(exam.shuffle);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, run } = useBusy();
  const editable = settingsEditable(exam);

  const save = () => {
    setError(null);
    setSaved(false);
    void run('settings', async () => {
      try {
        onSaved((await patchExam(exam.id, { pasteMode, shuffle })).exam);
        setSaved(true);
      } catch (err) {
        setError(toText(err));
      }
    });
  };

  return (
    <div className={styles.stack}>
      {editable ? null : <p className={styles.hint}>{t.staff.edit.settingsLocked}</p>}
      <fieldset disabled={!editable}>
        <legend>{t.staff.edit.pasteMode}</legend>
        <label>
          <input type="radio" name="pasteMode" checked={pasteMode === 'RECORD'} onChange={() => setPasteMode('RECORD')} /> {t.staff.edit.pasteRecord}
        </label>
        <label>
          <input type="radio" name="pasteMode" checked={pasteMode === 'BLOCK'} onChange={() => setPasteMode('BLOCK')} /> {t.staff.edit.pasteBlock}
        </label>
      </fieldset>
      <label>
        <input type="checkbox" checked={shuffle} disabled={!editable} onChange={(e) => setShuffle(e.target.checked)} /> {t.staff.edit.shuffle}
      </label>
      <ErrorAlert message={error} />
      {saved ? <p role="status" className={styles.ok}>{t.staff.edit.saved}</p> : null}
      <button type="button" disabled={!editable || busy !== null} onClick={save}>
        {busy ? t.staff.common.saving : t.staff.edit.saveSettings}
      </button>
    </div>
  );
}

function QuestionsTab({ exam, nextKey, onSaved }: { exam: ExamDetail; nextKey: () => number; onSaved: (q: QuestionDto[]) => void }) {
  const toText = useStaffError();
  const [items, setItems] = useState<DraftQuestion[]>(() => toDrafts(exam.questions, nextKey));
  const [errors, setErrors] = useState<Map<number, string[]>>(new Map()); // 문항 번호(0부터) → 오류 문구
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, run } = useBusy();
  const editable = exam.status === 'DRAFT';

  const update = (key: number, patch: Partial<DraftQuestion>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const updateChoice = (key: number, choiceId: string, text: string) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, choices: x.choices.map((c) => (c.id === choiceId ? { ...c, text } : c)) } : x)));
  const move = (i: number, d: -1 | 1) =>
    setItems((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const copy = [...xs];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });

  const addQuestion = (type: 'MCQ' | 'ESSAY') =>
    setItems((xs) => [
      ...xs,
      {
        key: nextKey(),
        type,
        prompt: '',
        points: '1',
        choices: type === 'MCQ' ? [{ id: 'c1', text: '' }, { id: 'c2', text: '' }] : [],
        correctChoiceId: '',
      },
    ]);

  const save = () => {
    setErrors(new Map());
    setGeneralError(null);
    setSaved(false);
    void run('questions', async () => {
      try {
        const res = await putQuestions(exam.id, items.map(toPayload));
        onSaved(res.questions);
        setSaved(true);
      } catch (err) {
        if (err instanceof DetailedApiError && isDetails<QuestionError>(err.details, isQuestionError)) {
          // 서버 오류(index, field, code)를 문항별로 모아 그 문항 아래에 보여 준다. index -1은 목록 전체의 오류
          const map = new Map<number, string[]>();
          for (const d of err.details) {
            const label = t.staff.edit.questionFieldLabel[d.field] ?? d.field;
            const msg = t.staff.edit.questionErrors[d.code] ?? t.staff.edit.questionErrors.UNKNOWN!;
            map.set(d.index, [...(map.get(d.index) ?? []), `${label}: ${msg}`]);
          }
          setErrors(map);
          const general = map.get(-1);
          if (general) setGeneralError(general.join(' '));
        } else {
          setGeneralError(toText(err));
        }
      }
    });
  };

  return (
    <div>
      {editable ? null : <p className={styles.hint}>{t.staff.edit.readOnly}</p>}
      {items.length === 0 ? <p>{t.staff.edit.noQuestions}</p> : null}
      {items.map((q, i) => {
        const qErrors = errors.get(i);
        return (
          <fieldset key={q.key} className={styles.question} disabled={!editable}>
            <legend>{t.staff.edit.questionLabel(i + 1)}</legend>
            <p className={styles.hint}>{q.type === 'MCQ' ? t.staff.edit.typeMcq : t.staff.edit.typeEssay}</p>
            <label className={styles.field}>
              {t.staff.edit.prompt}
              <textarea value={q.prompt} maxLength={5000} onChange={(e) => update(q.key, { prompt: e.target.value })} />
            </label>
            <label className={styles.field}>
              {t.staff.edit.points}
              <input type="number" min={1} max={1000} value={q.points} onChange={(e) => update(q.key, { points: e.target.value })} />
            </label>
            {q.type === 'MCQ'
              ? q.choices.map((c, ci) => (
                  <div key={c.id} className={styles.choiceRow}>
                    <input
                      type="radio"
                      name={`correct-${q.key}`}
                      aria-label={`${t.staff.edit.choice(ci + 1)} ${t.staff.edit.correct}`}
                      checked={q.correctChoiceId === c.id}
                      onChange={() => update(q.key, { correctChoiceId: c.id })}
                    />
                    <label>
                      <span className={styles.hint}>{t.staff.edit.choice(ci + 1)}</span>{' '}
                      <input value={c.text} maxLength={500} onChange={(e) => updateChoice(q.key, c.id, e.target.value)} aria-label={t.staff.edit.choice(ci + 1)} />
                    </label>
                    <button
                      type="button"
                      onClick={() => update(q.key, { choices: q.choices.filter((x) => x.id !== c.id), correctChoiceId: q.correctChoiceId === c.id ? '' : q.correctChoiceId })}
                    >
                      {t.staff.edit.removeChoice}
                    </button>
                  </div>
                ))
              : null}
            {q.type === 'MCQ' && q.choices.length < MAX_CHOICES ? (
              <button type="button" onClick={() => update(q.key, { choices: [...q.choices, { id: nextChoiceId(q.choices), text: '' }] })}>
                {t.staff.edit.addChoice}
              </button>
            ) : null}
            <div className={styles.row}>
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                {t.staff.edit.moveUp}
              </button>
              <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                {t.staff.edit.moveDown}
              </button>
              <button type="button" onClick={() => setItems((xs) => xs.filter((x) => x.key !== q.key))}>
                {t.staff.edit.removeQuestion}
              </button>
            </div>
            {qErrors ? (
              <div role="alert" className={styles.error}>
                {qErrors.map((m) => (
                  <p key={m}>{m}</p>
                ))}
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <div className={styles.row}>
        <button type="button" disabled={!editable} onClick={() => addQuestion('MCQ')}>
          {t.staff.edit.addMcq}
        </button>
        <button type="button" disabled={!editable} onClick={() => addQuestion('ESSAY')}>
          {t.staff.edit.addEssay}
        </button>
      </div>
      <ErrorAlert message={generalError} />
      {saved ? <p role="status" className={styles.ok}>{t.staff.edit.saved}</p> : null}
      <button type="button" disabled={!editable || busy !== null} onClick={save}>
        {busy ? t.staff.common.saving : t.staff.edit.saveQuestions}
      </button>
    </div>
  );
}

function RosterTab({ exam, onSaved }: { exam: ExamDetail; onSaved: (count: number) => void }) {
  const toText = useStaffError();
  const [csv, setCsv] = useState(() => rosterToCsv(exam.roster));
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const { busy, run } = useBusy();
  const editable = exam.status === 'DRAFT';

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setCsv(await file.text());
    e.target.value = '';
  };

  const save = () => {
    setLines([]);
    setError(null);
    setSavedCount(null);
    void run('roster', async () => {
      try {
        const res = await putRoster(exam.id, csv);
        setSavedCount(res.rosterCount);
        onSaved(res.rosterCount);
      } catch (err) {
        if (err instanceof DetailedApiError && isDetails<RosterError>(err.details, isRosterError)) {
          setLines(err.details.map((d) => t.staff.edit.rosterLine(d.line, t.staff.edit.rosterErrors[d.code] ?? d.message ?? t.errors.INVALID_INPUT)));
        } else {
          setError(toText(err));
        }
      }
    });
  };

  return (
    <div>
      {editable ? null : <p className={styles.hint}>{t.staff.edit.readOnly}</p>}
      <p className={styles.hint}>{t.staff.edit.rosterCurrent(exam.rosterCount)}</p>
      <label className={styles.field}>
        {t.staff.edit.rosterCsv}
        <textarea className={styles.textarea} value={csv} disabled={!editable} onChange={(e) => setCsv(e.target.value)} />
      </label>
      <label className={styles.field}>
        {t.staff.edit.rosterFile}
        <input type="file" accept=".csv,text/csv,text/plain" disabled={!editable} onChange={(e) => void onFile(e)} />
      </label>
      {lines.length > 0 || error ? (
        <div role="alert" className={styles.error}>
          {error ? <p>{error}</p> : null}
          {lines.length > 0 ? (
            <ul className={styles.list}>
              {lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {savedCount !== null ? <p role="status" className={styles.ok}>{t.staff.edit.rosterSaved(savedCount)}</p> : null}
      <button type="button" disabled={!editable || busy !== null} onClick={save}>
        {busy ? t.staff.common.saving : t.staff.edit.saveRoster}
      </button>
    </div>
  );
}
