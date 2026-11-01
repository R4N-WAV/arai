import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Field } from '../components/Field';
import { Notice } from '../components/Unavailable';
import { login } from '../lib/account';
import { errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthLayout, Busy } from './AuthLayout';

export function SignIn() {
  const { setSignedIn } = useSession();
  const nav = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(identifier.trim(), password);
      setSignedIn(r.user, r.keys);
      nav('/');
    } catch (err) {
      setError(errorMessage(err));
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
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !identifier || !password}>
          {busy ? <Busy label="Unlocking your keys…" /> : 'Sign in'}
        </button>
      </form>
      <p className="auth-alt">
        <Link to="/recover">Forgot your password?</Link>
      </p>
      <p className="auth-alt" style={{ marginTop: 0 }}>
        New to Arai? <Link to="/register">Create an account</Link>
      </p>
    </AuthLayout>
  );
}
