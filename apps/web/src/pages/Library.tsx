import { useState } from 'react';
import { Link } from 'react-router';
import { Cover } from '../components/Cover';
import { Notice } from '../components/Unavailable';
import { useProjects } from '../lib/projects';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = (n: number) => `${WORDS[n] ?? n} project${n === 1 ? '' : 's'}`;
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function Library() {
  const { projects, error } = useProjects();
  const [filter, setFilter] = useState<'all' | 'private' | 'public'>('all');

  if (projects === null) return error ? <Notice kind="error">{error}</Notice> : <p className="muted" role="status">Loading your space…</p>;

  if (projects.length === 0) {
    return (
      <>
        <h1 className="visually-hidden">Library</h1>
        <section className="empty" aria-labelledby="empty-title">
          <h2 id="empty-title">Your space is quiet.</h2>
          <p className="voice">Start a project and its colours will begin to seep in.</p>
          <p style={{ marginTop: 'var(--s-6)' }}>
            <Link to="/projects/new" className="btn">New project</Link>
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
        <Link to="/projects/new" className="btn">New project</Link>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
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
              <Link to={`/projects/${p.id}`} className="sleeve">
                {p.meta ? <Cover name={p.meta.name} color={p.meta.color} /> : <div className="cover cover-locked" aria-hidden="true" />}
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
