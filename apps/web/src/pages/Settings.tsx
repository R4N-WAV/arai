import { useCallback, useEffect, useState } from 'react';
import { EMAIL_REASON, Notice, SMS_REASON, Unavailable } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { Field } from '../components/Field';
import { changePassword, changeUsername, deleteAccount } from '../lib/account';
import { exportMyData } from '../lib/exporter';
import { useProjects } from '../lib/projects';
import type { PersonDto } from '@arai/shared';
import { Link } from 'react-router';
import { clearOffline, offlineFiles, offlineSupported, removeOffline } from '../lib/offline';

interface SessionInfo { id: string; createdAt: number; lastSeenAt: number; device: string | null; current: boolean }
interface LoginEvent { at: number; success: boolean; device: string | null; newDevice: boolean }

const fmt = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Settings() {
  const { user, caps, signOut } = useSession();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
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
        <AccountControl />
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

      <PushSection />
      <OfflineSection />
      <BlockedSection />
      <AdminLink />
    </>
  );
}

function AccountControl() {
  const { user, keys, unlockInfo, refresh, signOut } = useSession();
  const { projects } = useProjects();
  const [open, setOpen] = useState<'password' | 'username' | 'export' | 'delete' | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const reset = (o: typeof open) => { setOpen(o); setCur(''); setNext(''); setNext2(''); setName(''); setConfirm(''); setMsg(null); };
  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: done });
      setOpen(null);
    } catch (e) {
      const m = e instanceof Error && e.message === 'vault_unlock_failed' ? 'That is not your current password.' : errorMessage(e);
      setMsg({ kind: 'error', text: m });
    } finally {
      setBusy(null);
    }
  };
  if (!unlockInfo || !keys || !user) return null;
  const weak = next.length > 0 && next.length < 10;
  return (
    <div className="account-control">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="form-actions">
        <button type="button" className="btn btn-sm" aria-expanded={open === 'password'} onClick={() => reset(open === 'password' ? null : 'password')}>Change password</button>
        <button type="button" className="btn btn-sm" aria-expanded={open === 'username'} onClick={() => reset(open === 'username' ? null : 'username')}>Change username</button>
        <button type="button" className="btn btn-sm" aria-expanded={open === 'export'} onClick={() => reset(open === 'export' ? null : 'export')}>Download my data</button>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open === 'delete'} onClick={() => reset(open === 'delete' ? null : 'delete')}>Delete account…</button>
      </div>
      {open === 'password' && (
        <form className="share-form" onSubmit={(e) => { e.preventDefault(); void run('pw', () => changePassword(unlockInfo, keys, cur, next).then(refresh), 'Password changed. Other devices were signed out.'); }}>
          <Field label="Current password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          <Field label="New password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" hint="At least 10 characters. Your recovery key keeps working." error={weak ? 'Use at least 10 characters.' : undefined} />
          <Field label="Repeat new password" type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" error={next2 && next2 !== next ? 'The passwords do not match.' : undefined} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !cur || next.length < 10 || next !== next2}>{busy ? 'Re-encrypting…' : 'Change password'}</button>
        </form>
      )}
      {open === 'username' && (
        <form className="share-form" onSubmit={(e) => { e.preventDefault(); void run('un', () => changeUsername(unlockInfo, cur, name.trim()).then(refresh), 'Username changed. Your old profile link no longer works.'); }}>
          <Field label="New username" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} hint="3–30 letters, numbers, _ or ." />
          <Field label="Password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !/^[A-Za-z0-9_.]{3,30}$/.test(name.trim()) || !cur}>Change username</button>
        </form>
      )}
      {open === 'export' && (
        <div className="share-form">
          <p className="row-sub">Your profile, projects (names, details, versions, comments) and messages, decrypted here in your browser into one JSON file. Audio is not included: use “Download original” on a track.</p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!!busy}
            onClick={() =>
              void run('ex', async () => {
                const blob = await exportMyData(user.id, keys, projects ?? [], (s) => setBusy(s));
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `arai-${user.username}-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
              }, 'Your data was saved.')
            }
          >
            {busy ? `Collecting… ${busy}` : 'Prepare download'}
          </button>
        </div>
      )}
      {open === 'delete' && (
        <form className="share-form danger" onSubmit={(e) => { e.preventDefault(); void run('del', async () => { await deleteAccount(unlockInfo, cur); await signOut(); }, 'Your account was deleted.'); }}>
          <p className="row-sub">This deletes your profile, every project you own (for everyone you shared it with) and erases your messages and comments. It cannot be undone. Download your data first if you want a copy.</p>
          <Field label="Type “delete my account”" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <Field label="Password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          <button type="submit" className="btn btn-danger btn-sm" disabled={!!busy || confirm !== 'delete my account' || !cur}>Delete my account</button>
        </form>
      )}
    </div>
  );
}

function PushSection() {
  const { caps } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void currentSubscription().then((s) => setOn(!!s));
  }, []);
  return (
    <section className="section" aria-labelledby="push-h">
      <h2 id="push-h">Notifications on this device</h2>
      <p className="section-lede">
        Get a notification for messages, invitations, comments and follows. Arai sends only a wake-up signal; your device then fetches who did what over its own encrypted connection, so no content passes through Apple or Google. On iPhone this works in the app added to the Home Screen.
      </p>
      {!caps.push ? (
        <Unavailable title="Notifications" reason="Push notifications are not configured on this server yet." action="Turn on" />
      ) : !pushSupported() ? (
        <p className="muted">This browser cannot receive notifications. On iPhone, add Arai to the Home Screen first.</p>
      ) : (
        <>
          {msg && <Notice kind="error">{msg}</Notice>}
          <button
            type="button"
            className={on ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
            aria-pressed={!!on}
            disabled={on === null}
            onClick={async () => {
              setMsg(null);
              try {
                if (on) await disablePush();
                else await enablePush();
                setOn(!on);
              } catch (e) {
                setMsg(e instanceof Error && e.message === 'permission_denied' ? 'Notifications are blocked for Arai in this browser’s settings.' : errorMessage(e));
              }
            }}
          >
            {on ? 'Notifications are on · Turn off' : 'Turn on notifications'}
          </button>
        </>
      )}
    </section>
  );
}

function OfflineSection() {
  const [files, setFiles] = useState(() => offlineFiles());
  if (!offlineSupported()) return null;
  const entries = Object.entries(files);
  const total = entries.reduce((n, [, f]) => n + f.bytes, 0);
  return (
    <section className="section" aria-labelledby="off-h">
      <h2 id="off-h">Offline copies</h2>
      <p className="section-lede">Tracks you keep offline are stored encrypted in this browser and play without a connection while Arai is unlocked.</p>
      {entries.length === 0 ? (
        <p className="muted">None yet. Choose “Keep offline” in a track’s menu.</p>
      ) : (
        <>
          <ul className="list">
            {entries.map(([id, f]) => (
              <li key={id} className="row">
                <div className="row-main">
                  <div className="row-title">{f.name}</div>
                  <p className="row-sub">{(f.bytes / 1048576).toFixed(1)} MB · saved {new Date(f.at).toLocaleDateString()}</p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeOffline(id).then(() => setFiles(offlineFiles()))}>Remove<span className="visually-hidden"> {f.name}</span></button>
              </li>
            ))}
          </ul>
          <p className="form-actions" style={{ marginTop: 'var(--s-4)' }}>
            <button type="button" className="btn btn-sm" onClick={() => void clearOffline().then(() => setFiles(offlineFiles()))}>Remove all ({(total / 1048576).toFixed(1)} MB)</button>
          </p>
        </>
      )}
    </section>
  );
}

function BlockedSection() {
  const [people, setPeople] = useState<PersonDto[] | null>(null);
  const load = useCallback(() => api<{ people: PersonDto[] }>('GET', '/social/me/blocked').then((r) => setPeople(r.people)).catch(() => setPeople([])), []);
  useEffect(() => void load(), [load]);
  if (!people || people.length === 0) return null;
  return (
    <section className="section" aria-labelledby="blk-h">
      <h2 id="blk-h">Blocked</h2>
      <ul className="list">
        {people.map((p) => (
          <li key={p.id} className="row">
            <div className="row-main"><div className="row-title">@{p.username}</div></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void api('DELETE', `/social/${p.username}/block`).then(load)}>Unblock<span className="visually-hidden"> @{p.username}</span></button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AdminLink() {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    api<{ role: string | null }>('GET', '/account/platform-role').then((r) => setRole(r.role)).catch(() => undefined);
  }, []);
  if (!role) return null;
  return (
    <section className="section" aria-labelledby="adm-h">
      <h2 id="adm-h">Administration</h2>
      <p className="section-lede">You are a platform {role}.</p>
      <Link to="/admin" className="btn btn-sm">Open the dashboard</Link>
    </section>
  );
}
