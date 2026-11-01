import { passwordProblems, USERNAME_RE } from '@arai/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Field } from '../components/Field';
import { Notice } from '../components/Unavailable';
import { prepareRegistration, setHoneypot, type PreparedRegistration } from '../lib/account';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthLayout, Busy } from './AuthLayout';

const PW_TEXT: Record<string, string> = {
  at_least_8_characters: 'at least 8 characters',
  needs_a_letter: 'a letter',
  needs_a_number: 'a number',
};

export function Register() {
  const { setSignedIn } = useSession();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [trap, setTrap] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedRegistration | null>(null);
  const [saved, setSaved] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const usernameError = touched && !USERNAME_RE.test(username) ? 'Use 3–30 letters, numbers, dots or underscores.' : null;
  const emailError = touched && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Enter a valid email address.' : null;
  const problems = passwordProblems(password);
  const pwError = touched && problems.length ? `Your password needs ${problems.map((p) => PW_TEXT[p]).join(', ')}.` : null;
  const confirmError = touched && confirm !== password ? 'The passwords do not match.' : null;

  async function onDetails(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!USERNAME_RE.test(username) || problems.length || confirm !== password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const { available } = await api<{ available: boolean }>('POST', '/auth/username-available', { username });
      if (!available) {
        setError('That username is taken. Choose another one.');
        return;
      }
      setHoneypot(trap);
      setPrepared(await prepareRegistration(username, email.trim(), password));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      const keys = await prepared.submit();
      const s = await api<{ user: Parameters<typeof setSignedIn>[0] }>('GET', '/auth/session');
      setSignedIn(s.user, keys);
      nav('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (prepared) {
    return (
      <AuthLayout title="Save your recovery key">
        {error && <Notice kind="error">{error}</Notice>}
        <p>
          Your music and messages are encrypted with keys only you hold. If you forget your password, this recovery key is the
          <strong> only</strong> way to get your encrypted content back. Arai cannot recover it for you.
        </p>
        <p className="recovery-code" aria-label="Recovery key">{prepared.recoveryCode}</p>
        <p>
          <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(prepared.recoveryCode)}>Copy recovery key</button>
        </p>
        <form onSubmit={onCreate}>
          <label className="checkbox">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I have stored this recovery key somewhere safe, such as a password manager.</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand that if I lose both my password and this key, my encrypted projects and messages are gone for good.</span>
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !saved || !understood}>
            {busy ? <Busy label="Creating your account…" /> : 'Create account'}
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account">
      {error && <Notice kind="error">{error}</Notice>}
      <form onSubmit={onDetails} noValidate>
        <Field label="Username" hint="Public. 3–30 letters, numbers, dots or underscores." autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} error={usernameError} required />
        <Field label="Email" type="email" hint="Not verified yet: email verification will be added later." autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} required />
        <Field label="Password" type="password" hint="At least 8 characters, including a letter and a number." autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={pwError} required />
        <Field label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={confirmError} required />
        <div className="honeypot" aria-hidden="true">
          <label>Website<input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label>
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? <Busy label="Generating your encryption keys…" /> : 'Continue'}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 'var(--s-5)' }}>
        Already have an account? <Link to="/signin">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
