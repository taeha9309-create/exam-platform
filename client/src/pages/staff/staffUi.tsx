// 교수자 화면 공통 부품: 오류 문구 변환, 중복 요청 방지, 대화상자, 페이지 틀.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import { errorText, t } from '../../copy/ko';
import { logout } from './staffApi';
import styles from './staff.module.css';

/** 오류를 한국어 문구로 바꾼다. 로그인이 풀렸으면(401) 로그인 화면으로 보낸다. */
export function useStaffError(): (err: unknown) => string {
  const navigate = useNavigate();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.code === 'UNAUTHORIZED') navigate('/staff/login', { replace: true });
        return errorText(err.code);
      }
      return t.errors.UNKNOWN;
    },
    [navigate],
  );
}

/**
 * 한 번에 하나의 요청만 실행한다. 요청 중에는 busy가 키 이름이라 버튼을 비활성화할 수 있고,
 * 같은 틱에 두 번 눌러도(ref로 막는다) 서버에는 한 번만 간다.
 */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(key);
    try {
      await fn();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** 모달 대화상자: 열릴 때 안으로 포커스 이동, Esc로 닫기, Tab이 밖으로 나가지 않음, 닫히면 원래 위치로 포커스 복귀. */
export function Dialog({ title, onClose, children, fullscreen = false }: { title: string; onClose: () => void; children: ReactNode; fullscreen?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={fullscreen ? styles.overlayFull : styles.overlay}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={fullscreen ? styles.dialogFull : styles.dialog} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** 되돌릴 수 없는 동작 앞의 확인 대화상자. 처음 포커스는 [취소]에 둔다. */
export function ConfirmDialog({
  title,
  body,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <p>{body}</p>
      <div className={styles.row}>
        <button type="button" autoFocus onClick={onCancel} disabled={busy}>
          {t.staff.common.cancel}
        </button>
        <button type="button" className={styles.danger} onClick={onConfirm} disabled={busy}>
          {t.staff.common.confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** 목록·편집·운영·결과 화면의 공통 틀: 제목, 시험 목록 링크, 로그아웃. */
export function PageShell({ title, children, back = true }: { title: string; children: ReactNode; back?: boolean }) {
  const navigate = useNavigate();
  const onLogout = async () => {
    try {
      await logout();
    } catch {
      // 401(이미 만료)이나 네트워크 오류여도 로그인 화면으로 보낸다
    }
    navigate('/staff/login', { replace: true });
  };
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>{title}</h1>
        <nav className={styles.row} aria-label={t.appName}>
          {back ? <Link to="/staff/exams">{t.staff.common.back}</Link> : null}
          <button type="button" onClick={() => void onLogout()}>
            {t.staff.common.logout}
          </button>
        </nav>
      </header>
      {children}
    </main>
  );
}

export function ErrorAlert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className={styles.error}>
      {message}
    </p>
  ) : null;
}
