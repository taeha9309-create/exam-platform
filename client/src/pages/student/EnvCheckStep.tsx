import { useEffect, useRef, useState } from 'react';
import { t } from '../../copy/ko';
import { detectBrowser } from '../../student/browserCheck';
import { postEnv, type AttemptView } from '../../student/studentApi';
import { Notice } from './Notice';
import styles from './student.module.css';
import { studentErrorText } from './studentUi';

interface UaNavigator {
  userAgentData?: { brands?: { brand: string }[] };
}

/** P-04 환경 점검(F-09): 브라우저, 전체화면(버튼 클릭으로만 진입), 다중 모니터(경고만, 진행은 막지 않음). */
export function EnvCheckStep({ token, onUpdate }: { token: string; onUpdate: (view: AttemptView) => void }) {
  const browser = detectBrowser((navigator as unknown as UaNavigator).userAgentData?.brands);
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  const [fsError, setFsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  // screen.isExtended는 Chrome·Edge의 최신 속성이다. 없으면 false로 본다.
  const isExtended = (screen as unknown as { isExtended?: boolean }).isExtended === true;

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (browser === 'unsupported') return <Notice kind="unsupportedBrowser" />;

  // 전체화면은 사용자 클릭 핸들러 안에서 바로 요청해야 브라우저가 허용한다.
  const enterFullscreen = () => {
    setFsError(false);
    document.documentElement
      .requestFullscreen()
      .then(() => setFullscreen(true))
      .catch(() => setFsError(true));
  };

  const next = async () => {
    if (running.current || !fullscreen) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      onUpdate(await postEnv(token, { browser, isExtended }));
    } catch (err) {
      setError(studentErrorText(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const e = t.student.env;
  return (
    <main className={styles.page}>
      <h1>{e.title}</h1>
      <section aria-labelledby="env-browser">
        <h2 id="env-browser">{e.browserLabel}</h2>
        <p>{e.browserOk(e.browserNames[browser] ?? browser)}</p>
      </section>
      <section aria-labelledby="env-fs">
        <h2 id="env-fs">{e.fullscreenLabel}</h2>
        <p role="status">{fullscreen ? e.fullscreenOn : e.fullscreenOff}</p>
        {!fullscreen ? (
          <button type="button" onClick={enterFullscreen}>
            {e.fullscreenButton}
          </button>
        ) : null}
        {fsError ? (
          <p role="alert" className={styles.error}>
            {e.fullscreenFailed}
          </p>
        ) : null}
      </section>
      {isExtended ? (
        <p role="alert" className={styles.warn}>
          {e.extendedWarn}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <p>
        <button type="button" onClick={() => void next()} disabled={!fullscreen || busy}>
          {busy ? e.saving : e.next}
        </button>
      </p>
    </main>
  );
}
