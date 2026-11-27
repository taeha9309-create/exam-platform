import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { t } from '../../copy/ko';
import { getResults, gradeAnswer, type ResultsResponse } from './staffApi';
import { ErrorAlert, PageShell, useBusy, useStaffError } from './staffUi';
import styles from './staff.module.css';

type Row = ResultsResponse['rows'][number];

/** 점수 입력 검증: 0 이상의 정수이고 배점 이하(F-17). 비어 있으면 아직 입력 전이라 저장만 막는다. */
function checkScore(text: string, max: number): { ok: boolean; message: string | null } {
  if (text.trim() === '') return { ok: false, message: null };
  if (!/^\d+$/.test(text.trim())) return { ok: false, message: t.staff.results.invalidScore };
  if (Number(text) > max) return { ok: false, message: t.staff.results.overMax(max) };
  return { ok: true, message: null };
}

/** S-06 결과 표와 서술형 채점 */
export function ResultsPage() {
  const { id = '' } = useParams();
  const toText = useStaffError();
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, run } = useBusy();

  const load = useCallback(async () => {
    try {
      const res = await getResults(id);
      setData(res);
      // 이미 채점된 점수는 입력칸에 미리 채운다. 입력 중인 값은 건드리지 않는다.
      setInputs((cur) => {
        const next = { ...cur };
        for (const r of res.rows) for (const a of r.answers) if (a.awardedPoints !== null && a.awardedPoints !== undefined && next[a.answerId] === undefined) next[a.answerId] = String(a.awardedPoints);
        return next;
      });
    } catch (err) {
      setError(toText(err));
    }
  }, [id, toText]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = (answerId: string, points: number) => {
    setError(null);
    setNotice(null);
    void run(`grade-${answerId}`, async () => {
      try {
        await gradeAnswer(answerId, points);
        setNotice(t.staff.results.gradeSaved);
        await load();
      } catch (err) {
        setError(toText(err));
      }
    });
  };

  const questions = new Map((data?.questions ?? []).map((q) => [q.id, q]));
  const score = (v: number | null) => (v === null ? t.staff.results.ungraded : String(v));

  return (
    <PageShell title={t.pages.staffResults}>
      <ErrorAlert message={error} />
      {notice ? <p role="status" className={styles.ok}>{notice}</p> : null}
      {data === null ? (
        error ? null : <p>{t.staff.common.loading}</p>
      ) : data.rows.length === 0 ? (
        <p>{t.staff.results.empty}</p>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t.staff.results.colStudentNo}</th>
                <th>{t.staff.results.colName}</th>
                <th>{t.staff.results.colState}</th>
                <th>{t.staff.results.colMcq}</th>
                <th>{t.staff.results.colEssay}</th>
                <th>{t.staff.results.colTotal}</th>
                <th>{t.staff.results.colSignals}</th>
                <th>{t.staff.results.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: Row) => (
                <tr key={r.attemptId}>
                  <td>{r.studentNo}</td>
                  <td>{r.name}</td>
                  <td>{t.staff.results.stateLabel[r.state] ?? r.state}</td>
                  <td>{r.mcqScore}</td>
                  <td>{score(r.essayScore)}</td>
                  <td>{score(r.total)}</td>
                  <td>
                    {r.signalCounts.INFO}/{r.signalCounts.WARN}/{r.signalCounts.ALERT}
                  </td>
                  <td>{r.actionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>{t.staff.results.essays}</h2>
          {data.rows.map((r) => {
            const essays = r.answers.filter((a) => questions.get(a.questionId)?.type === 'ESSAY');
            if (essays.length === 0) return null;
            const who = `${r.studentNo} ${r.name}`;
            return (
              <section key={r.attemptId} className={styles.panel} aria-label={who}>
                <h3>{who}</h3>
                {essays.map((a) => {
                  const q = questions.get(a.questionId)!;
                  const value = inputs[a.answerId] ?? '';
                  const check = checkScore(value, q.points);
                  const inputId = `score-${a.answerId}`;
                  return (
                    <div key={a.answerId} className={styles.field}>
                      {/* 학생 답안은 React 기본 이스케이프로만 출력한다 */}
                      <p style={{ whiteSpace: 'pre-wrap' }}>{a.text ? a.text : t.staff.results.noAnswer}</p>
                      <div className={styles.row}>
                        <label htmlFor={inputId}>{t.staff.results.score(who, q.position + 1)}</label>
                        <input id={inputId} inputMode="numeric" value={value} aria-invalid={check.message ? true : undefined} onChange={(e) => setInputs((cur) => ({ ...cur, [a.answerId]: e.target.value }))} />
                        <span className={styles.hint}>{t.staff.results.maxPoints(q.points)}</span>
                        <button type="button" disabled={!check.ok || busy !== null} aria-describedby={check.message ? `${inputId}-msg` : undefined} onClick={() => save(a.answerId, Number(value))}>
                          {t.staff.results.saveGrade}
                        </button>
                      </div>
                      {check.message ? (
                        <p id={`${inputId}-msg`} className={styles.error}>
                          {check.message}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </>
      )}
    </PageShell>
  );
}
