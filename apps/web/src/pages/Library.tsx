import { useState } from 'react';
import { Link } from 'react-router';
import { ProjectCover } from '../components/Cover';
import { Notice } from '../components/Unavailable';
import { roleWithArticle, useProjects } from '../lib/projects';
import { errorMessage } from '../lib/api';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = (n: number) => `${WORDS[n] ?? n} project${n === 1 ? '' : 's'}`;
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Invitations() {
  const { invites, accept, decline } = useProjects();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (invites.length === 0) return null;
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="section invites" aria-labelledby="inv-h">
      <h2 id="inv-h" className="section-title">Invitations</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="list">
        {invites.map((p) => (
          <li key={p.id} className="row invite-row">
            <ProjectCover p={p} size="thumb" />
            <div className="row-main">
              <div className="row-title">{p.meta?.name ?? 'A project'}</div>
              <p className="row-sub">@{p.invitedBy} invited you as {roleWithArticle(p.role)}</p>
            </div>
            <span className="form-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => void act(p.id, () => accept(p))}>Accept<span className="visually-hidden"> {p.meta?.name}</span></button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p.id, () => decline(p))}>Decline<span className="visually-hidden"> {p.meta?.name}</span></button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Library() {
  const { projects, error } = useProjects();
  const [filter, setFilter] = useState<'all' | 'private' | 'public'>('all');

  if (projects === null) return error ? <Notice kind="error">{error}</Notice> : <p className="muted" role="status">Loading your space…</p>;

  if (projects.length === 0) {
    return (
      <>
        <h1 className="visually-hidden">Library</h1>
        <Invitations />
        <section className="empty" aria-labelledby="empty-title">
          <h2 id="empty-title">Your space is quiet.</h2>
          <p className="voice">Start a project and its colours will begin to seep in.</p>
          <p className="form-actions" style={{ marginTop: 'var(--s-6)', justifyContent: 'center' }}>
            <Link to="/projects/new" className="btn" viewTransition>New project</Link>
            <Link to="/import" className="btn btn-ghost">Import from other platforms</Link>
          </p>
        </section>
      </>
    );
  }

  const shown = projects.filter((p) => filter === 'all' || p.visibility === filter);
  return (
    <>
      <header className="page-header page-header-actions">
        <div className="page-header-title">
          <h1>Library</h1>
          <span className="voice">{count(projects.length)}</span>
        </div>
        <span className="form-actions">
          <Link to="/import" className="btn btn-ghost">Import</Link>
          <Link to="/projects/new" className="btn" viewTransition>New project</Link>
        </span>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      <Invitations />
      <div className="filters" role="group" aria-label="Show projects">
        {(['all', 'private', 'public'] as const).map((f) => (
          <button key={f} type="button" className="filter" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'private' ? 'Private' : 'Public'}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="muted">No {filter} projects.</p>
      ) : (
        <ul className="sleeves">
          {shown.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="sleeve" viewTransition>
                <div className="cover-shared" style={{ viewTransitionName: `cover-${p.id}` }}>
                  <ProjectCover p={p} />
                </div>
                <span className="sleeve-name">{p.meta?.name ?? 'Locked project'}</span>
                <span className="sleeve-meta">
                  {p.visibility} · {p.role === 'owner' ? `created ${date(p.createdAt)}` : `shared with you`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function NotBuilt({ title }: { title: string }) {
  return (
    <>
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <p className="voice" style={{ fontSize: 'var(--fs-xl)' }}>Not built yet. This part of the space is still being made.</p>
    </>
  );
}
