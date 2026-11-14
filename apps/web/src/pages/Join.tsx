/** /join/:id#secret — accept a project invite link. */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { HomeLink } from '../components/Logo';
import { Notice } from '../components/Unavailable';
import { joinWithInvite, openInvite } from '../lib/collab';
import { useProjects } from '../lib/projects';
import { useSession } from '../lib/session';

export const RETURN_KEY = 'arai.after-signin';

export function JoinPage() {
  const { id = '' } = useParams();
  const { user, keys } = useSession();
  const secret = location.hash.slice(1);
  const nav = useNavigate();
  const [opened, setOpened] = useState<Awaited<ReturnType<typeof openInvite>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) {
      try {
        sessionStorage.setItem(RETURN_KEY, `/join/${id}#${secret}`);
      } catch {
        /* storage blocked: they can open the link again after signing in */
      }
      return;
    }
    if (!keys) return;
    try {
      sessionStorage.removeItem(RETURN_KEY);
    } catch {
      /* nothing stored */
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return setError('This invite link is incomplete. Ask for the full link, including everything after #.');
    openInvite(id, secret).then(setOpened, () => setError('This invite link has expired, was used up, or was turned off. Ask for a new one.'));
  }, [id, secret, user, keys]);

  return (
    <div className="public-page">
      <header className="public-bar"><HomeLink /></header>
      <main id="main" className="content">
        <section className="auth-panel">
          <h1>Join a project</h1>
          {error && <Notice kind="error">{error}</Notice>}
          {!user ? (
            <>
              <p className="voice">Someone invited you to a project on Arai. Sign in or create an account, and you will come straight back here.</p>
              <p className="form-actions">
                <Link to="/register" className="btn btn-primary">Create an account</Link>
                <Link to="/signin" className="btn">Sign in</Link>
              </p>
            </>
          ) : opened ? (
            <JoinNow id={id} opened={opened} busy={busy} setBusy={setBusy} setError={setError} onJoined={(pid) => nav(`/projects/${pid}`, { replace: true })} />
          ) : (
            !error && <p className="muted" role="status">Opening the invitation…</p>
          )}
        </section>
      </main>
    </div>
  );
}

function JoinNow({ id, opened, busy, setBusy, setError, onJoined }: { id: string; opened: Awaited<ReturnType<typeof openInvite>>; busy: boolean; setBusy: (b: boolean) => void; setError: (e: string | null) => void; onJoined: (pid: string) => void }) {
  const { user, keys } = useSession();
  const { refresh } = useProjects();
  if (opened.alreadyMember) {
    return (
      <>
        <p className="voice">You are already in “{opened.payload.name}”.</p>
        <button type="button" className="btn btn-primary" onClick={() => onJoined(opened.payload.projectId)}>Open the project</button>
      </>
    );
  }
  return (
    <>
      <p className="voice">You are invited to “{opened.payload.name}” as {opened.role === 'editor' ? 'an editor' : 'a listener'}.</p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const pid = await joinWithInvite(id, opened, keys!, user!.id);
            await refresh();
            onJoined(pid);
          } catch {
            setError('Joining did not work. The link may have just been used up.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Joining…' : 'Join project'}
      </button>
    </>
  );
}

/** Where to go after signing in (an invite link opened while signed out); the join page clears it. */
export function takeReturnPath(): string {
  try {
    const p = sessionStorage.getItem(RETURN_KEY);
    return p && p.startsWith('/join/') ? p : '/';
  } catch {
    return '/';
  }
}
