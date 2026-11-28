import { useState } from 'react';
import { t } from '../../copy/ko';
import styles from './student.module.css';

/** 전체화면이 아닐 때 문항 대신 보이는 화면(P-07). requestFullscreen은 사용자 클릭에서만 허용되므로 버튼 클릭에서 부른다. */
export function FullscreenGate() {
  const [failed, setFailed] = useState(false);
  const enter = () => {
    setFailed(false);
    const req = document.documentElement.requestFullscreen?.();
    if (req && typeof req.catch === 'function') req.catch(() => setFailed(true));
  };
  return (
    <div className={styles.gate}>
      <h2>{t.student.taking.fullscreenGateTitle}</h2>
      <p>{t.student.taking.fullscreenGateBody}</p>
      <button type="button" onClick={enter}>
        {t.student.taking.fullscreenGateButton}
      </button>
      {failed ? (
        <p role="alert" className={styles.error}>
          {t.student.taking.fullscreenGateFailed}
        </p>
      ) : null}
    </div>
  );
}
