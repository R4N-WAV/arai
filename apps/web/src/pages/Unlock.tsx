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
    <AuthLayout title="Unlock Arai">
      <p className="muted">Signed in as @{user?.username}. Your encryption keys are kept only in memory, so enter your password to unlock them on this page.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <form onSubmit={onSubmit}>
        <input type="hidden" autoComplete="username" value={user?.username ?? ''} readOnly />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !password}>
          {busy ? <Busy label="Unlocking…" /> : 'Unlock'}
        </button>
      </form>
      <p style={{ marginTop: 'var(--s-4)' }}>
        <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>Sign out</button>
      </p>
    </AuthLayout>
  );
}
