import { passwordProblems } from '@arai/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Field } from '../components/Field';
import { EMAIL_REASON, Notice, Unavailable } from '../components/Unavailable';
import { recoverWithKey } from '../lib/account';
import { api, errorMessage } from '../lib/api';
import type { SessionUser } from '@arai/shared';
import { useSession } from '../lib/session';
import { AuthLayout, Busy } from './AuthLayout';

export function Recover() {
  const { caps, setSignedIn } = useSession();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwProblems = password ? passwordProblems(password) : [];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pwProblems.length) return;
    setBusy(true);
    setError(null);
    try {
      const keys = await recoverWithKey(username.trim(), code, password);
      const s = await api<{ user: SessionUser }>('GET', '/auth/session');
      setSignedIn(s.user, keys);
      nav('/');
    } catch (err) {
      setError(err instanceof Error && err.message === 'invalid recovery code' ? 'That recovery key is not in the right format.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Reset your password" lede="Your recovery key opens the door again.">
      <section className="auth-block" aria-labelledby="rk">
        <h2 id="rk">Use your recovery key</h2>
        <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-5)' }}>Keeps all your encrypted content. Signs out every other device.</p>
        {error && <Notice kind="error">{error}</Notice>}
        <form onSubmit={onSubmit} noValidate>
          <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Field label="Recovery key" hint="52 characters, as shown when you created your account. Dashes and spaces are optional." autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} required />
          <Field label="New password" type="password" autoComplete="new-password" hint="At least 8 characters, including a letter and a number." error={pwProblems.length ? 'This password does not meet the requirements.' : null} value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !username || !code || !password}>
            {busy ? <Busy label="Restoring your account…" /> : 'Reset password'}
          </button>
        </form>
      </section>
      <section className="auth-block" aria-label="Reset by email">
        {caps.emailDelivery ? null : (
          <Unavailable title="Reset by email" reason={`${EMAIL_REASON} Email reset restores your account, but without your recovery key your encrypted content cannot be recovered.`} action="Send reset email" />
        )}
      </section>
      <p className="auth-alt"><Link to="/signin">Back to sign in</Link></p>
    </AuthLayout>
  );
}
