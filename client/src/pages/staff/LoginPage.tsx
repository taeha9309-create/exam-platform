import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import { errorText, t } from '../../copy/ko';
import { login } from './staffApi';
import { ErrorAlert, useBusy } from './staffUi';
import styles from './staff.module.css';

/** S-01 교수자 로그인. 인증은 서버가 심는 httpOnly 쿠키라 화면은 토큰을 만지지 않는다. */
export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useBusy();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    void run('login', async () => {
      try {
        await login(email, password);
        navigate('/staff/exams', { replace: true });
      } catch (err) {
        // 서버가 계정 존재 여부를 숨기는 단일 문구(INVALID_CREDENTIALS)를 주므로 그대로 보여 준다
        setError(err instanceof ApiError ? errorText(err.code) : t.errors.UNKNOWN);
      }
    });
  };

  return (
    <main className={styles.page}>
      <h1>{t.pages.staffLogin}</h1>
      <form className={styles.stack} onSubmit={onSubmit}>
        <label className={styles.field}>
          {t.staff.login.email}
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className={styles.field}>
          {t.staff.login.password}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <ErrorAlert message={error} />
        <button type="submit" disabled={busy !== null}>
          {busy ? t.staff.login.submitting : t.staff.login.submit}
        </button>
      </form>
    </main>
  );
}
