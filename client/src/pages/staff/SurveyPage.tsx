import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { t } from '../../copy/ko';
import { getSurvey, type SurveyResponseDto } from './staffApi';
import { ErrorAlert, PageShell, useStaffError } from './staffUi';
import styles from './staff.module.css';

/** S-07 설문 요약: 응답 수, 난이도 분포(1~5), 평균, 의견 목록(서버가 요청마다 섞어 보낸다) */
export function SurveyPage() {
  const { id = '' } = useParams();
  const toText = useStaffError();
  const [data, setData] = useState<SurveyResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSurvey(id)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(toText(err)));
    return () => {
      alive = false;
    };
  }, [id, toText]);

  const max = Math.max(1, ...(data?.distribution ?? [0]));

  return (
    <PageShell title={t.pages.staffSurvey}>
      <ErrorAlert message={error} />
      {data === null ? (
        error ? null : <p>{t.staff.common.loading}</p>
      ) : (
        <>
          <p>{t.staff.survey.count(data.count)}</p>
          <p>
            {t.staff.survey.average}: <strong>{data.average === null ? t.staff.survey.noAverage : data.average.toFixed(2)}</strong>
          </p>
          <h2>{t.staff.survey.distribution}</h2>
          <ul className={styles.list}>
            {data.distribution.map((n, i) => (
              <li key={i}>
                {t.staff.survey.level(i + 1)} <span className={styles.bar} style={{ width: `${(n / max) * 12}rem` }} aria-hidden="true" /> {n}
              </li>
            ))}
          </ul>
          <h2>{t.staff.survey.comments}</h2>
          <p className={styles.hint}>{t.staff.survey.anonymousNote}</p>
          {data.comments.length === 0 ? (
            <p>{t.staff.survey.noComments}</p>
          ) : (
            <ul className={styles.list}>
              {data.comments.map((c, i) => (
                <li key={i} style={{ whiteSpace: 'pre-wrap' }}>
                  {c}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageShell>
  );
}
