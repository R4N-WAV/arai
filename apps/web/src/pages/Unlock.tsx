import { useState, type FormEvent } from 'react';
import { Field } from '../components/Field';
import { Notice } from '../components/Unavailable';
import { unlock } from '../lib/account';
import { errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthLayout, Busy } from './AuthLayout';

/** Session is valid but keys are not in memory (page reload): re-derive locally. */
export function Unlock() {
  const { user, unlockInfo, setKeys, signOut } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!unlockInfo) return;
    setBusy(true);
    setError(null);
    try {
      setKeys(await unlock(unlockInfo, password));
    } catch {
      setError(errorMessage(new Error('vault_unlock_failed')).replace('Signed in, but y', 'Y') + ' Check your password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Unlock Arai" lede={`Signed in as ${user?.username ?? ''}.`}>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-5)' }}>Your encryption keys never leave this browser unprotected. In a new tab, enter your password once to unlock them.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <form onSubmit={onSubmit}>
        <input type="hidden" autoComplete="username" value={user?.username ?? ''} readOnly />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !password}>
          {busy ? <Busy label="Unlocking…" /> : 'Unlock'}
        </button>
      </form>
      <p className="auth-alt">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
      </p>
    </AuthLayout>
  );
}
