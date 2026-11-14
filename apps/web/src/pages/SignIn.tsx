import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Field } from '../components/Field';
import { Notice } from '../components/Unavailable';
import { login } from '../lib/account';
import { ApiError, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { takeReturnPath } from './Join';
import { AuthLayout, Busy } from './AuthLayout';

export function SignIn() {
  const { setSignedIn } = useSession();
  const nav = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState<'code' | 'recovery' | null>(null);
  const [code, setCode] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const second = mfa === 'code' ? { totpCode: code.replace(/\s/g, '') } : mfa === 'recovery' ? { mfaRecoveryCode: code.trim() } : undefined;
      const r = await login(identifier.trim(), password, undefined, second);
      setSignedIn(r.user, r.keys);
      nav(takeReturnPath());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setMfa('code');
      } else if (err instanceof ApiError && err.code === 'invalid_mfa') {
        setError(mfa === 'recovery' ? 'That recovery code is not valid or was already used.' : 'That code is not right. Check the time on your phone and try the newest code.');
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in" lede="Welcome back to your space.">
      {error && <Notice kind="error">{error}</Notice>}
      <form onSubmit={onSubmit} noValidate>
        <Field label="Username" hint="Signing in with your email address becomes available once email verification is set up." autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {mfa === 'code' && (
          <Field label="Code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} autoFocus hint="Six digits, from the app you set up for Arai." />
        )}
        {mfa === 'recovery' && <Field label="Recovery code" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} autoFocus hint="One of the codes you saved when you turned on two-factor sign-in. Each works once." />}
        {mfa && (
          <p className="row-sub">
            <button type="button" className="link-btn" onClick={() => (setMfa(mfa === 'code' ? 'recovery' : 'code'), setCode(''))}>
              {mfa === 'code' ? 'Use a recovery code instead' : 'Use the authenticator app instead'}
            </button>
          </p>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !identifier || !password || (mfa !== null && !code.trim())}>
          {busy ? <Busy label="Unlocking your keys…" /> : 'Sign in'}
        </button>
      </form>
      <p className="auth-alt">
        <Link to="/recover">Forgot your password?</Link>
      </p>
      <p className="auth-alt" style={{ marginTop: 0 }}>
        New to Arai? <Link to="/register">Create an account</Link>
      </p>
      <p className="auth-alt" style={{ marginTop: 0 }}>
        <Link to="/help">Help</Link> · <Link to="/privacy">Privacy</Link>
      </p>
    </AuthLayout>
  );
}
