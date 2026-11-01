import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Cover } from '../components/Cover';
import { Field } from '../components/Field';
import { ProjectForm } from '../components/ProjectForm';
import { Notice } from '../components/Unavailable';
import { errorMessage } from '../lib/api';
import { useProjects } from '../lib/projects';

const date = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function ProjectPage() {
  const { id } = useParams();
  const { projects, update, remove, focus } = useProjects();
  const nav = useNavigate();
  const [mode, setMode] = useState<'view' | 'edit' | 'visibility' | 'delete'>('view');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    focus(id ?? null);
    return () => focus(null);
  }, [id, focus]);

  if (projects === null) return <p className="muted" role="status">Loading…</p>;
  const p = projects.find((x) => x.id === id);
  if (!p) {
    return (
      <>
        <header className="page-header"><h1>Not found</h1></header>
        <p className="voice" style={{ fontSize: 'var(--fs-xl)' }}>This project does not exist, or you no longer have access to it.</p>
        <p><Link to="/">Back to your library</Link></p>
      </>
    );
  }
  if (!p.meta) {
    return (
      <>
        <header className="page-header"><h1>Locked project</h1></header>
        <p className="muted">This project's key could not be opened in this browser. If someone shared it with you, ask them to share it again.</p>
      </>
    );
  }
  const meta = p.meta;
  const canEdit = p.role !== 'listener';
  const canAdmin = p.role === 'admin' || p.role === 'owner';
  const isOwner = p.role === 'owner';

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(done);
      setMode('view');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="project-hero">
        <Cover name={meta.name} color={meta.color} size="hero" />
        <div className="project-hero-text">
          <p className="row-sub">
            {p.visibility === 'public' ? 'Public project' : 'Private project'} · created {date(p.createdAt)}
            {p.role !== 'owner' && ` · you are ${p.role === 'admin' ? 'an admin' : `a ${p.role}`}`}
          </p>
          <h1>{meta.name}</h1>
          {meta.description && <p className="voice project-description">{meta.description}</p>}
          {(meta.genre || meta.tags.length > 0) && (
            <p className="project-tags">
              {meta.genre && <span className="tag">{meta.genre}</span>}
              {meta.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            </p>
          )}
        </div>
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {status && <Notice kind="ok">{status}</Notice>}

      {mode === 'view' && (canEdit || canAdmin || isOwner) && (
        <div className="form-actions" style={{ marginBottom: 'var(--s-7)' }}>
          {canEdit && <button type="button" className="btn btn-sm" onClick={() => { setStatus(null); setMode('edit'); }}>Edit details</button>}
          {canAdmin && (
            <button type="button" className="btn btn-sm" onClick={() => { setStatus(null); setMode('visibility'); }}>
              {p.visibility === 'public' ? 'Make private…' : 'Make public…'}
            </button>
          )}
          {isOwner && <button type="button" className="btn btn-danger btn-sm" onClick={() => { setStatus(null); setConfirmName(''); setMode('delete'); }}>Delete…</button>}
        </div>
      )}

      {mode === 'edit' && (
        <section className="section" aria-labelledby="edit-h">
          <h2 id="edit-h">Edit details</h2>
          <ProjectForm
            initial={{ meta, visibility: p.visibility }}
            submitLabel="Save"
            busyLabel="Encrypting…"
            showVisibility={false}
            onCancel={() => setMode('view')}
            onSubmit={(v) => run(() => update(p, { meta: v.meta }), 'Saved.')}
          />
        </section>
      )}

      {mode === 'visibility' && (
        <section className="section confirm" aria-labelledby="vis-h">
          <h2 id="vis-h">{p.visibility === 'public' ? 'Make this project private?' : 'Make this project public?'}</h2>
          {p.visibility === 'public' ? (
            <p className="muted">Its public details are removed from Arai straight away. Anyone who already saw or saved them may still have a copy.</p>
          ) : (
            <p className="muted">Its name, description, genre and tags will be stored unencrypted and visible to anyone. Everything else stays encrypted. You can make it private again later.</p>
          )}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => update(p, { visibility: p.visibility === 'public' ? 'private' : 'public' }), p.visibility === 'public' ? 'The project is private now.' : 'The project is public now.')}>
              {p.visibility === 'public' ? 'Make private' : 'Make public'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode('view')}>Cancel</button>
          </div>
        </section>
      )}

      {mode === 'delete' && (
        <section className="section confirm" aria-labelledby="del-h">
          <h2 id="del-h">Delete this project?</h2>
          <p className="muted">It disappears for you and everyone you shared it with, and its public page goes offline. This cannot be undone from Arai.</p>
          <Field label={`Type the project name (${meta.name}) to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
          <div className="form-actions">
            <button type="button" className="btn btn-danger" disabled={busy || confirmName.trim() !== meta.name} onClick={() => run(async () => { await remove(p); nav('/'); }, 'Deleted.')}>
              Delete project
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode('view')}>Cancel</button>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="tracks-h">
        <h2 id="tracks-h">Tracks</h2>
        <p className="voice" style={{ fontSize: 'var(--fs-lg)' }}>No tracks yet.</p>
        <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Uploading audio needs file storage, which is being switched on next.</p>
      </section>
    </>
  );
}
