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
      <header className="page-header">
        <h1>Settings</h1>
        <span className="voice">for {user?.username}</span>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      {status && <Notice kind="ok">{status}</Notice>}

      <section className="section" aria-labelledby="acct">
        <h2 id="acct">Account</h2>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Username</div>
            <p className="row-sub">{user?.username}</p>
          </div>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">
              Email
              {user?.emailVerified ? <span className="tag tag-ok">Verified</span> : <span className="tag">Unverified</span>}
            </div>
            <p className="row-sub">{user?.email}</p>
          </div>
        </div>
        {!caps.emailDelivery && !user?.emailVerified && (
          <Unavailable title="Verify email" reason={`${EMAIL_REASON} Until then, sign in with your username.`} action="Send verification email" />
        )}
      </section>

      <section className="section" aria-labelledby="mfa">
        <h2 id="mfa">Two-factor authentication</h2>
        <p className="section-lede">Adds a one-time code when you sign in. Optional.</p>
        {!caps.emailDelivery && <Unavailable title="Email code" reason={EMAIL_REASON} action="Turn on" />}
        {!caps.sms && <Unavailable title="Text message (SMS) code" reason={SMS_REASON} action="Turn on" />}
      </section>

      <section className="section" aria-labelledby="enc">
        <h2 id="enc">Encryption</h2>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Your key fingerprint</div>
            <p className="row-sub">Collaborators can compare this to confirm they are sharing with the real you.</p>
            <div className="fingerprint">{fp ?? '…'}</div>
          </div>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Recovery key</div>
            <p className="row-sub">Shown once when you signed up. It is the only way to reset your password without losing encrypted content.</p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="sess">
        <h2 id="sess">Signed-in devices</h2>
        {sessions === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.id} className="row">
                <div className="row-main">
                  <div className="row-title">
                    {s.device ?? 'Unknown device'}
                    {s.current && <span className="tag tag-ok">This device</span>}
                  </div>
                  <p className="row-sub">Last active {fmt(s.lastSeenAt)} · signed in {fmt(s.createdAt)}</p>
                </div>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => void revoke(s.id, s.current)}>
                  Sign out<span className="visually-hidden"> {s.device ?? 'device'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {sessions && sessions.length > 1 && (
          <p style={{ marginTop: 'var(--s-4)' }}>
            <button type="button" className="btn btn-sm" onClick={() => void revokeOthers()}>Sign out all other devices</button>
          </p>
        )}
      </section>

      <section className="section" aria-labelledby="hist">
        <h2 id="hist">Recent sign-ins</h2>
        {events === null ? (
          <p className="muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted">No sign-ins recorded yet.</p>
        ) : (
          <ul className="list">
            {events.map((e, i) => (
              <li key={i} className="row">
                <div className="row-main">
                  <div className="row-title">
                    {e.success ? 'Signed in' : 'Failed attempt'}
                    {e.newDevice && <span className="tag">New device</span>}
                  </div>
                  <p className="row-sub">{e.device ?? 'Unknown device'} · {fmt(e.at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
