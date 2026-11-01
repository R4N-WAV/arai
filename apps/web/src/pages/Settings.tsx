import { fingerprint } from '@arai/crypto';
import { useCallback, useEffect, useState } from 'react';
import { EMAIL_REASON, Notice, SMS_REASON, Unavailable } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';

interface SessionInfo { id: string; createdAt: number; lastSeenAt: number; device: string | null; current: boolean }
interface LoginEvent { at: number; success: boolean; device: string | null; newDevice: boolean }

const fmt = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Settings() {
  const { user, keys, caps, signOut } = useSession();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
  const [fp, setFp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        api<{ sessions: SessionInfo[] }>('GET', '/account/sessions'),
        api<{ events: LoginEvent[] }>('GET', '/account/login-history'),
      ]);
      setSessions(s.sessions);
      setEvents(h.events);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (keys) void fingerprint(keys.box.publicKey, keys.sign.publicKey).then(setFp);
  }, [keys]);

  async function revoke(id: string, current: boolean) {
    if (current) return void signOut();
    await api('DELETE', `/account/sessions/${id}`).catch((e) => setError(errorMessage(e)));
    setStatus('Device signed out.');
    void load();
  }

  async function revokeOthers() {
    const r = await api<{ revoked: number }>('POST', '/account/sessions/revoke-others').catch((e) => (setError(errorMessage(e)), null));
    if (r) setStatus(`Signed out ${r.revoked} other ${r.revoked === 1 ? 'device' : 'devices'}.`);
    void load();
  }

  return (
    <>
      <h1>Settings</h1>
      {error && <Notice kind="error">{error}</Notice>}
      {status && <Notice kind="ok">{status}</Notice>}

      <section className="card" aria-labelledby="acct">
        <h2 id="acct">Account</h2>
        <div className="row">
          <div><strong>Username</strong><div className="muted">@{user?.username}</div></div>
        </div>
        <div className="row">
          <div>
            <strong>Email</strong>{' '}
            {user?.emailVerified ? <span className="badge badge-ok">Verified</span> : <span className="badge">Unverified</span>}
            <div className="muted">{user?.email}</div>
          </div>
        </div>
        {!caps.emailDelivery && !user?.emailVerified && (
          <Unavailable title="Verify email" reason={`${EMAIL_REASON} Until then, sign in with your username.`} action="Send verification email" />
        )}
      </section>

      <section className="card" aria-labelledby="mfa">
        <h2 id="mfa">Two-factor authentication</h2>
        <p className="muted">Adds a one-time code at sign-in. Optional.</p>
        {!caps.emailDelivery && <Unavailable title="Email code" reason={EMAIL_REASON} action="Turn on" />}
        {!caps.sms && <Unavailable title="Text message (SMS) code" reason={SMS_REASON} action="Turn on" />}
      </section>

      <section className="card" aria-labelledby="enc">
        <h2 id="enc">Encryption</h2>
        <div className="row">
          <div>
            <strong>Your key fingerprint</strong>
            <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Collaborators can compare this to confirm they are sharing with the real you.</div>
            <div className="mono" style={{ marginTop: 'var(--s-1)' }}>{fp ?? '…'}</div>
          </div>
        </div>
        <div className="row">
          <div>
            <strong>Recovery key</strong>
            <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              Shown once when you signed up. It is the only way to reset your password without losing encrypted content.
            </div>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="sess">
        <h2 id="sess">Signed-in devices</h2>
        {sessions === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.id} className="row">
                <div>
                  <strong>{s.device ?? 'Unknown device'}</strong> {s.current && <span className="badge badge-ok">This device</span>}
                  <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Last active {fmt(s.lastSeenAt)} · signed in {fmt(s.createdAt)}</div>
                </div>
                <button type="button" className="btn btn-danger" onClick={() => void revoke(s.id, s.current)}>
                  Sign out<span className="visually-hidden"> {s.device ?? 'device'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {sessions && sessions.length > 1 && (
          <p style={{ marginTop: 'var(--s-3)' }}>
            <button type="button" className="btn" onClick={() => void revokeOthers()}>Sign out all other devices</button>
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="hist">
        <h2 id="hist">Recent sign-ins</h2>
        {events === null ? (
          <p className="muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted">No sign-ins recorded yet.</p>
        ) : (
          <ul className="list">
            {events.map((e, i) => (
              <li key={i} className="row">
                <div>
                  <strong>{e.success ? 'Signed in' : 'Failed attempt'}</strong> {e.newDevice && <span className="badge">New device</span>}
                  <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{e.device ?? 'Unknown device'} · {fmt(e.at)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
