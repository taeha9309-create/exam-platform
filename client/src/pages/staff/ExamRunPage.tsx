import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { t } from '../../copy/ko';
import { ApiError } from '../../api';
import { DashboardCards, NetworkIncidentBanner } from './dashboard/DashboardCards';
import { useDashboard, type PendingApproval } from './dashboard/useDashboard';
import { endExam, getExam, openExam, patchExam, regeneratePasscode, resolveApproval, startExam, type ApprovalAction, type ExamDetail } from './staffApi';
import { ConfirmDialog, Dialog, ErrorAlert, PageShell, useBusy, useStaffError } from './staffUi';
import styles from './staff.module.css';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 입장 열기 조건(F-06): 문항 1개 이상, 명단 1명 이상 */
const openBlocked = (e: ExamDetail) => e.questions.length === 0 || e.rosterCount === 0;

/** 운영 화면 + 감독 대시보드(S-04): 위쪽은 시험 진행, 아래쪽은 학생 카드. */
export function ExamRunPage() {
  const { id = '' } = useParams();
  const toText = useStaffError();
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'end' | 'reissue' | null>(null);
  const [showPasscode, setShowPasscode] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useBusy();

  useEffect(() => {
    let alive = true;
    getExam(id)
      .then(({ exam: e }) => alive && setExam(e))
      .catch((err) => alive && setError(toText(err)));
    return () => {
      alive = false;
    };
  }, [id, toText]);

  // 남은 시간 표시용 1초 시계. 마감 판정은 서버가 하며 이 값은 표시에만 쓴다.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 실시간 상태(입장 현황·승인 요청·학생 카드)는 useDashboard가 소켓 하나로 받는다. 화면은 스냅샷+이벤트로만 갱신한다.
  const dash = useDashboard(id);
  const { ready, total, socketDown, pendingApprovals: approvals } = dash;

  const act = useCallback(
    (key: string, fn: () => Promise<void>) => {
      setError(null);
      void run(key, async () => {
        try {
          await fn();
        } catch (err) {
          setError(toText(err)); // 409 BUSY는 "잠시 후 다시 시도" 문구
        }
      });
    },
    [run, toText],
  );

  if (exam === null) {
    return (
      <PageShell title={t.pages.staffRun}>
        <ErrorAlert message={error} />
        {error ? null : <p>{t.staff.common.loading}</p>}
      </PageShell>
    );
  }

  const inProgress = exam.status === 'OPEN' || exam.status === 'RUNNING';
  const remainingMs = exam.status === 'RUNNING' && exam.endsAt ? new Date(exam.endsAt).getTime() - now : null;
  const blocked = openBlocked(exam);
  const disabled = busy !== null;

  const onOpen = () => act('open', async () => setExam((await openExam(exam.id)).exam));
  const onStart = () => act('start', async () => setExam((await startExam(exam.id)).exam));
  const onEnd = () =>
    act('end', async () => {
      try {
        setExam((await endExam(exam.id)).exam);
      } finally {
        setConfirm(null);
      }
    });
  const onReissue = () =>
    act('reissue', async () => {
      try {
        const { passcode } = await regeneratePasscode(exam.id);
        setExam((e) => (e ? { ...e, passcode } : e));
      } finally {
        setConfirm(null);
      }
    });
  const onToggleLock = (lock: boolean) => act('lock', async () => setExam((await patchExam(exam.id, { lockNewEntry: lock })).exam));
  const onResolve = (a: PendingApproval, approve: boolean, reason: string) =>
    act(`approval-${a.attemptId}`, async () => {
      const type: ApprovalAction = a.kind === 'LATE' ? (approve ? 'APPROVE_ENTRY' : 'REJECT_ENTRY') : approve ? 'APPROVE_SESSION' : 'REJECT_SESSION';
      try {
        await resolveApproval(a.attemptId, type, reason);
        dash.removeApproval(a.attemptId);
      } catch (err) {
        // 이미 처리됨(INVALID_STATE)이면 목록에서 지운다. BUSY는 일시적 충돌이라 항목을 남기고 다시 시도 안내만 보인다.
        if (err instanceof ApiError && err.status === 409 && err.code === 'INVALID_STATE') {
          dash.removeApproval(a.attemptId);
          setError(t.staff.dash.resolvedGone);
          return;
        }
        throw err;
      }
    });

  return (
    <PageShell title={t.pages.staffRun}>
      <h2>{exam.title}</h2>
      <NetworkIncidentBanner incident={dash.networkIncident} />
      <ErrorAlert message={error} />
      {socketDown ? <p role="status" className={styles.hint}>{t.staff.run.socketDown}</p> : null}

      <section className={styles.panel} aria-label={t.staff.run.status}>
        <p>
          {t.staff.run.status}: <strong>{t.staff.status[exam.status] ?? exam.status}</strong>
        </p>
        <p>
          {t.staff.run.remaining}: <span className={styles.big}>{remainingMs === null ? t.staff.run.notStarted : formatRemaining(remainingMs)}</span>
        </p>
        {inProgress ? (
          <p>
            {t.staff.run.entryUrl}: <code>{`${window.location.origin}/e/${exam.examCode}`}</code>
          </p>
        ) : null}
      </section>

      <section className={styles.panel} aria-label={t.staff.run.waiting}>
        <h3>{t.staff.run.waiting}</h3>
        <p>
          <span className={styles.big}>{t.staff.run.waitingCount(ready ?? '-', total ?? exam.rosterCount)}</span>
        </p>
        <p className={styles.hint}>{t.staff.run.waitingHelp}</p>
      </section>

      <div className={styles.row}>
        {exam.status === 'DRAFT' ? (
          <div>
            <button type="button" disabled={blocked || disabled} aria-describedby={blocked ? 'open-why' : undefined} onClick={onOpen}>
              {t.staff.run.open}
            </button>
            {blocked ? (
              <p id="open-why" className={styles.hint}>
                {t.staff.run.openBlocked} <Link to={`/staff/exams/${exam.id}/edit`}>{t.staff.run.editLink}</Link>
              </p>
            ) : null}
          </div>
        ) : null}
        {inProgress ? (
          <>
            <button type="button" disabled={!exam.passcode} onClick={() => setShowPasscode(true)}>
              {t.staff.run.showPasscode}
            </button>
            <button type="button" disabled={disabled} onClick={() => setConfirm('reissue')}>
              {t.staff.run.reissue}
            </button>
            <label>
              <input type="checkbox" checked={exam.lockNewEntry} disabled={disabled} onChange={(e) => onToggleLock(e.target.checked)} /> {t.staff.run.lockNewEntry}
            </label>
          </>
        ) : null}
        {exam.status === 'OPEN' ? (
          <button type="button" disabled={disabled} onClick={onStart}>
            {t.staff.run.start}
          </button>
        ) : null}
        {exam.status === 'RUNNING' ? (
          <button type="button" className={styles.danger} disabled={disabled} onClick={() => setConfirm('end')}>
            {t.staff.run.end}
          </button>
        ) : null}
        {exam.status === 'ENDED' ? (
          <>
            <Link to={`/staff/exams/${exam.id}/results`}>{t.staff.run.resultsLink}</Link>
            <Link to={`/staff/exams/${exam.id}/survey`}>{t.staff.run.surveyLink}</Link>
          </>
        ) : null}
      </div>

      {inProgress ? (
        <section className={styles.panel} aria-label={t.staff.run.approvals}>
          <h3>{t.staff.run.approvals}</h3>
          {approvals.length === 0 ? (
            <p>{t.staff.run.noApprovals}</p>
          ) : (
            <ul className={styles.list}>
              {approvals.map((a) => (
                <ApprovalItem key={a.attemptId} approval={a} disabled={disabled} onResolve={onResolve} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {exam.status !== 'DRAFT' ? <DashboardCards dash={dash} /> : null}

      {confirm === 'end' ? <ConfirmDialog title={t.staff.run.endConfirmTitle} body={t.staff.run.endConfirmBody} busy={disabled} onConfirm={onEnd} onCancel={() => setConfirm(null)} /> : null}
      {confirm === 'reissue' ? <ConfirmDialog title={t.staff.run.reissueConfirmTitle} body={t.staff.run.reissueConfirmBody} busy={disabled} onConfirm={onReissue} onCancel={() => setConfirm(null)} /> : null}

      {showPasscode && exam.passcode ? (
        <Dialog title={t.staff.run.passcodeOverlay} onClose={() => setShowPasscode(false)} fullscreen>
          {/* 비밀번호는 이 오버레이 안에만 그려지고 저장소·URL·콘솔에는 남기지 않는다 */}
          <p className={styles.passcode}>
            {exam.passcode}
          </p>
          <button type="button" onClick={() => setShowPasscode(false)}>
            {t.staff.run.closeOverlay}
          </button>
        </Dialog>
      ) : null}
    </PageShell>
  );
}

function ApprovalItem({ approval, disabled, onResolve }: { approval: PendingApproval; disabled: boolean; onResolve: (a: PendingApproval, approve: boolean, reason: string) => void }) {
  const [reason, setReason] = useState<string>(t.staff.run.reasonQuick);
  const inputId = `reason-${approval.attemptId}`;
  const valid = reason.trim().length > 0;
  return (
    <li className={styles.row}>
      <strong>{approval.kind === 'LATE' ? t.staff.run.kindLate : t.staff.run.kindDuplicate}</strong>
      <span>{approval.studentNo !== null ? `${approval.studentNo} ${approval.name ?? ''}`.trim() : t.staff.run.attemptLabel(approval.attemptId.slice(0, 8))}</span>
      <label htmlFor={inputId}>{t.staff.run.reason}</label>
      <input id={inputId} value={reason} maxLength={500} aria-describedby={`${inputId}-hint`} onChange={(e) => setReason(e.target.value)} />
      <span id={`${inputId}-hint`} className={styles.hint}>
        {t.staff.dash.approvalReasonHint}
      </span>
      <button type="button" onClick={() => setReason(t.staff.run.reasonQuick)}>
        {t.staff.run.reasonQuick}
      </button>
      <button type="button" disabled={disabled || !valid} onClick={() => onResolve(approval, true, reason.trim())}>
        {t.staff.run.approve}
      </button>
      <button type="button" disabled={disabled || !valid} onClick={() => onResolve(approval, false, reason.trim())}>
        {t.staff.run.reject}
      </button>
    </li>
  );
}
