// 학생 흐름의 컨테이너(/e/:examCode). 입장(P-01) → 본인 확인(P-02) → [중복 접속이면 승인 대기 폴링] → 세션.
// 세션 안에서는 서버가 주는 상태(GET /api/student/attempt + attempt:state)로 화면을 정한다. 상태의 원본은 서버다.
import { EV } from '@exam/shared';
import type { Socket } from 'socket.io-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { t } from '../../copy/ko';
import { connectStudentSocket } from '../../socket';
import { createServerClock } from '../../student/serverClock';
import { drafts, session } from '../../student/session';
import { getAttempt, getPublicExam, postConfirm, postEntry, type AttemptView, type EntryInput } from '../../student/studentApi';
import { ConfirmStep } from './ConfirmStep';
import { ConsentStep } from './ConsentStep';
import { EnvCheckStep } from './EnvCheckStep';
import { EntryStep } from './EntryStep';
import { ExamTaking, type ExamSocket } from './ExamTaking';
import { Notice, type NoticeKind } from './Notice';
import { PendingApproval } from './PendingApproval';
import styles from './student.module.css';
import { errorCodeOf, studentErrorText } from './studentUi';
import { SubmittedSurvey } from './SubmittedSurvey';
import { WaitingRoom } from './WaitingRoom';

const POLL_MS = 2000;

type Phase =
  | { kind: 'entry' }
  | { kind: 'confirm'; name: string }
  | { kind: 'pending' }
  | { kind: 'session'; token: string }
  | { kind: 'notice'; notice: NoticeKind };

export function StudentFlow() {
  const params = useParams();
  // 시험 코드는 대소문자를 구분하지 않으므로 대문자로 통일해 저장소 키가 하나가 되게 한다.
  const examCode = (params.examCode ?? '').toUpperCase();
  const [phase, setPhase] = useState<Phase>(() => {
    const token = session.get(examCode);
    return token ? { kind: 'session', token } : { kind: 'entry' };
  });
  const [title, setTitle] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  // 비밀번호와 승인 대기 토큰은 입장~승인 사이에만 메모리(ref)에 둔다. 화면 상태·URL·저장소에는 넣지 않는다.
  const creds = useRef<Pick<EntryInput, 'studentNo' | 'passcode'> | null>(null);
  const pendingToken = useRef<string | null>(null);
  const studentNoShown = useRef('');

  const forget = () => {
    creds.current = null;
    pendingToken.current = null;
  };
  const toEntry = (error: string | null = null) => {
    forget();
    setEntryError(error);
    setConfirmError(null);
    setPhase({ kind: 'entry' });
  };
  const toNotice = (notice: NoticeKind) => {
    forget();
    session.clearAll(examCode);
    setPhase({ kind: 'notice', notice });
  };
  const toSession = (token: string) => {
    forget();
    // 이 브라우저에 세션이 없던 새 응시 시작이면 이전 응시자가 남긴 신호 큐·seq를 비운다. 같은 기기의 재입장(토큰 있음)은 seq를 이어간다.
    if (!session.get(examCode)) session.clearSignals(examCode);
    session.set(examCode, token);
    setPhase({ kind: 'session', token });
  };

  useEffect(() => {
    if (phase.kind !== 'entry') return;
    let alive = true;
    getPublicExam(examCode)
      .then((r) => alive && setTitle(r?.title ?? null))
      .catch((err) => {
        if (alive && err instanceof ApiError && err.status === 404) toNotice('notFound');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, examCode]);

  const onEntry = async (studentNo: string, passcode: string) => {
    setBusy(true);
    setEntryError(null);
    try {
      const { name } = await postEntry({ examCode, studentNo, passcode });
      creds.current = { studentNo, passcode };
      studentNoShown.current = studentNo;
      setPhase({ kind: 'confirm', name });
    } catch (err) {
      setEntryError(studentErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** 확인·폴링 응답/오류를 화면 전환으로 옮긴다. 폴링을 계속해야 하면 true. */
  const handleConfirmError = (err: unknown): 'continue' | 'stop' => {
    const code = errorCodeOf(err);
    switch (code) {
      case 'ENTRY_REJECTED':
        toNotice('rejected');
        return 'stop';
      case 'ENTRY_CLOSED':
        toNotice('entryClosed');
        return 'stop';
      case 'ATTEMPT_FINISHED':
        toNotice('finished');
        return 'stop';
      case 'ENTRY_FAILED':
      case 'EXAM_NOT_ENTERABLE':
        toEntry(studentErrorText(err));
        return 'stop';
      default:
        return 'continue';
    }
  };

  const onConfirmYes = async () => {
    const c = creds.current;
    if (!c) return toEntry();
    setBusy(true);
    setConfirmError(null);
    try {
      const res = await postConfirm({ examCode, ...c, sessionToken: session.get(examCode) ?? undefined });
      if ('sessionToken' in res) toSession(res.sessionToken);
      else {
        pendingToken.current = res.pendingToken ?? null;
        setPollError(null);
        setPhase({ kind: 'pending' });
      }
    } catch (err) {
      if (handleConfirmError(err) === 'continue') setConfirmError(studentErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  // 중복 접속 승인 대기: 2초마다 같은 입력 + pendingToken(sessionToken 필드)으로 /confirm을 다시 호출한다(SPEC 2.3, ADR-005).
  useEffect(() => {
    if (phase.kind !== 'pending') return;
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      const c = creds.current;
      if (inFlight || !c) return;
      inFlight = true;
      try {
        const res = await postConfirm({ examCode, ...c, sessionToken: pendingToken.current ?? undefined });
        if (!alive) return;
        if ('sessionToken' in res) {
          alive = false;
          clearInterval(id);
          toSession(res.sessionToken);
        } else {
          if (res.pendingToken) pendingToken.current = res.pendingToken;
          setPollError(null);
        }
      } catch (err) {
        if (!alive) return;
        if (handleConfirmError(err) === 'stop') {
          alive = false;
          clearInterval(id); // 거절·마감·종료: 폴링을 멈춘다
        } else setPollError(studentErrorText(err)); // 네트워크 끊김·429 등은 안내만 하고 계속 시도
      } finally {
        inFlight = false;
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, examCode]);

  switch (phase.kind) {
    case 'entry':
      return <EntryStep examTitle={title} error={entryError} busy={busy} onSubmit={(no, pw) => void onEntry(no, pw)} />;
    case 'confirm':
      return <ConfirmStep studentNo={studentNoShown.current} name={phase.name} busy={busy} error={confirmError} onYes={() => void onConfirmYes()} onNo={() => toEntry()} />;
    case 'pending':
      return <PendingApproval duplicate error={pollError} />;
    case 'notice':
      return <Notice kind={phase.notice} onBack={() => toEntry()} />;
    case 'session':
      return <StudentSession key={phase.token} examCode={examCode} token={phase.token} onLeave={(notice) => (notice ? toNotice(notice) : toEntry())} />;
  }
}

interface Snapshot extends AttemptView {
  /** 받은 시각(학생 시계). createServerClock의 receivedAt */
  receivedAt: number;
}

function StudentSession({ examCode, token, onLeave }: { examCode: string; token: string; onLeave: (notice: NoticeKind | null) => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [waiting, setWaiting] = useState<{ ready: number; total: number } | null>(null);
  const [connected, setConnected] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const lastNow = useRef(Number.NEGATIVE_INFINITY);
  const alive = useRef(true);
  const leave = useRef(onLeave);
  leave.current = onLeave;

  /**
   * 상태를 적용한다. serverNow가 이미 적용한 것보다 작으면 늦게 도착한 옛 상태이므로 버린다(이슈 #56: 재연결 스냅샷 순서 역전).
   * needs는 REST 응답에만 있어 이벤트로 온 상태는 마지막으로 안 값을 이어받는다.
   */
  const applyView = useCallback((v: AttemptView) => {
    if (!alive.current || v.serverNow < lastNow.current) return;
    lastNow.current = v.serverNow;
    setSnap((prev) => ({ ...v, needs: v.needs ?? prev?.needs, surveyDone: v.surveyDone ?? prev?.surveyDone, receivedAt: Date.now() }));
    setLoadError(null);
  }, []);

  /** 서버 상태를 다시 읽는다. 토큰이 거부되면(401) 입장 화면으로 돌아간다. */
  const refresh = useCallback(async () => {
    try {
      applyView(await getAttempt(token));
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 401) {
        session.clearAll(examCode);
        leave.current(null);
      } else setLoadError(studentErrorText(err));
    }
  }, [token, examCode, applyView]);

  useEffect(() => {
    alive.current = true;
    const sock = connectStudentSocket(token);
    setSocket(sock);
    // connect_error: 서버가 handshake를 거절하면 socket.io는 스스로 재연결하지 않는다. 그래서
    // ① HTTP로 세션이 아직 유효한지 확인하고(401이면 입장 화면으로) ② 유효하면 지수 백오프(1s→30s)로 직접 다시 연결한다.
    let reconnectN = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    const scheduleReconnect = () => {
      if (!alive.current || reconnectTimer !== undefined || sock.active === true) return; // 이미 socket.io가 재시도 중이면 맡긴다
      const delay = Math.min(1000 * 2 ** reconnectN, 30_000);
      reconnectN += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (alive.current && !sock.connected) sock.connect();
      }, delay);
    };
    const recover = async () => {
      if (checking) return;
      checking = true;
      try {
        applyView(await getAttempt(token));
        scheduleReconnect();
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.status === 401) {
          sock.disconnect();
          session.clearAll(examCode);
          leave.current(null);
        } else scheduleReconnect(); // 서버·네트워크 문제: 계속 시도
      } finally {
        checking = false;
      }
    };
    sock.on('connect', () => {
      reconnectN = 0;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      setConnected(true);
      void refresh(); // 연결·재연결 뒤 DB 최신 상태로 한 번 맞춘다
    });
    sock.on('disconnect', () => setConnected(false));
    sock.on('connect_error', () => {
      setConnected(false);
      void recover();
    });
    sock.on(EV.ATTEMPT_STATE, (p: AttemptView) => applyView(p));
    sock.on(EV.WAITING_COUNT, (p: { ready: number; total: number }) => setWaiting({ ready: p.ready, total: p.total }));
    sock.on(EV.EXAM_STARTED, () => void refresh());
    sock.on(EV.SESSION_REVOKED, () => {
      // 알림만 믿지 않고 서버에서 이 토큰이 정말 무효인지 확인한 뒤 종료 화면을 보인다.
      getAttempt(token)
        .then((v) => {
          if (!alive.current) return;
          applyView(v);
          sock.connect(); // 서버가 끊었으므로 유효한 세션이면 다시 연결
        })
        .catch(() => {
          if (!alive.current) return;
          sock.disconnect();
          session.clearAll(examCode);
          leave.current('revoked');
        });
    });
    void refresh();
    return () => {
      alive.current = false;
      clearTimeout(reconnectTimer);
      sock.off('connect');
      sock.off('disconnect');
      sock.off('connect_error');
      sock.off(EV.ATTEMPT_STATE);
      sock.off(EV.WAITING_COUNT);
      sock.off(EV.EXAM_STARTED);
      sock.off(EV.SESSION_REVOKED);
      sock.disconnect();
    };
  }, [token, examCode, refresh, applyView]);

  const state = snap?.state;
  // 제출·종료·거절되면 이 기기의 미저장 초안을 지운다(토큰은 설문을 마칠 때까지 둔다).
  useEffect(() => {
    if (state === 'SUBMITTED' || state === 'TERMINATED' || state === 'REJECTED') {
      drafts.clearAll(examCode);
      session.clearSignals(examCode);
    }
    if (state === 'REJECTED') session.clearAll(examCode);
  }, [state, examCode]);

  const clock = useMemo(() => createServerClock(snap?.serverNow ?? Date.now(), snap?.receivedAt ?? Date.now()), [snap?.serverNow, snap?.receivedAt]);
  const onUpdate = useCallback((v: AttemptView) => applyView(v), [applyView]);
  const refreshVoid = useCallback(() => void refresh(), [refresh]);
  const examSocket = socket as unknown as ExamSocket | null;

  if (!snap) {
    return (
      <main className={styles.page}>
        {loadError ? (
          <>
            <p role="alert" className={styles.error}>
              {loadError}
            </p>
            <button type="button" onClick={refreshVoid}>
              {t.student.taking.retry}
            </button>
          </>
        ) : (
          <p>{t.student.loading}</p>
        )}
      </main>
    );
  }

  switch (snap.state) {
    case 'REJECTED':
      return <Notice kind="rejected" onBack={() => leave.current(null)} />;
    case 'SUBMITTED':
    case 'TERMINATED':
      return <SubmittedSurvey token={token} terminated={snap.state === 'TERMINATED'} surveyDone={snap.surveyDone === true} onFinished={() => session.clear(examCode)} />;
    case 'PENDING_APPROVAL':
      return <PendingApproval />;
    case 'WAITING':
      if (snap.needs?.consent) return <ConsentStep token={token} onUpdate={onUpdate} />;
      if (snap.needs?.env) return <EnvCheckStep token={token} onUpdate={onUpdate} />;
      return <WaitingRoom count={waiting} />;
    case 'ACTIVE':
    case 'PAUSED':
      return (
        <ExamTaking
          examCode={examCode}
          token={token}
          socket={examSocket}
          state={snap.state}
          deadline={snap.deadline}
          clock={clock}
          violationCount={snap.violationCount}
          connected={connected}
          onRefresh={refreshVoid}
        />
      );
  }
}
