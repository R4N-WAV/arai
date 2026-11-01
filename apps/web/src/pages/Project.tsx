import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Cover } from '../components/Cover';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { ProjectForm } from '../components/ProjectForm';
import { TracksSection } from '../components/TracksSection';
import { Notice } from '../components/Unavailable';
import { errorMessage } from '../lib/api';
import { formatTime } from '../lib/audio';
import { usePlayer } from '../lib/player';
import { useProjects, type Project } from '../lib/projects';
import type { Track } from '../lib/tracks';
import { useSession } from '../lib/session';

const date = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Everything about the project itself, in one overlay: details, visibility, deletion. */
function EditDetails({ p, open, onClose }: { p: Project; open: boolean; onClose: () => void }) {
  const { update, remove } = useProjects();
  const nav = useNavigate();
  const [confirmVis, setConfirmVis] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const meta = p.meta!;
  const canAdmin = p.role === 'admin' || p.role === 'owner';
  const isOwner = p.role === 'owner';

  useEffect(() => {
    if (open) {
      setConfirmVis(false);
      setConfirmName('');
      setError(null);
      setStatus(null);
    }
  }, [open]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(done);
      setConfirmVis(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit details" wide>
      {error && <Notice kind="error">{error}</Notice>}
      {status && <Notice kind="ok">{status}</Notice>}
      <ProjectForm
        initial={{ meta, visibility: p.visibility }}
        submitLabel="Save"
        busyLabel="Encrypting…"
        showVisibility={false}
        onSubmit={(v) => run(async () => { await update(p, { meta: v.meta }); onClose(); }, 'Saved.')}
      />

      {canAdmin && (
        <section className="modal-section" aria-labelledby="vis-h">
          <h3 id="vis-h">Visibility</h3>
          <p className="row-sub">
            {p.visibility === 'public'
              ? 'Public: anyone can find this project and see its name, description, genre and tags.'
              : 'Private: only you and the people you invite. Encrypted so that not even Arai can read it.'}
          </p>
          {!confirmVis ? (
            <button type="button" className="btn btn-sm" onClick={() => setConfirmVis(true)}>{p.visibility === 'public' ? 'Make private…' : 'Make public…'}</button>
          ) : (
            <div className="confirm-inline">
              <p className="muted">
                {p.visibility === 'public'
                  ? 'Its public details are removed from Arai straight away. Anyone who already saw or saved them may still have a copy.'
                  : 'Its name, description, genre and tags will be stored unencrypted and visible to anyone. Everything else stays encrypted. You can make it private again later.'}
              </p>
              <div className="form-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => update(p, { visibility: p.visibility === 'public' ? 'private' : 'public' }), p.visibility === 'public' ? 'The project is private now.' : 'The project is public now.')}>
                  {p.visibility === 'public' ? 'Make private' : 'Make public'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmVis(false)}>Cancel</button>
              </div>
            </div>
          )}
        </section>
      )}

      {isOwner && (
        <section className="modal-section danger" aria-labelledby="del-h">
          <h3 id="del-h">Delete project</h3>
          <p className="row-sub">It disappears for you and everyone you shared it with, and its public page goes offline. This cannot be undone.</p>
          <Field label={`Type the project name (${meta.name}) to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
          <button type="button" className="btn btn-danger btn-sm" disabled={busy || confirmName.trim() !== meta.name} onClick={() => run(async () => { await remove(p); nav('/', { viewTransition: true }); }, 'Deleted.')}>
            Delete project
          </button>
        </section>
      )}
    </Modal>
  );
}

export function ProjectPage() {
  const { id } = useParams();
  const { projects, focus } = useProjects();
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const count = tracks?.length ?? null;
  const player = usePlayer();
  const { user } = useSession();

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

  return (
    <div className="project-page">
      <header className="project-hero">
        <div className="cover-shared" style={{ viewTransitionName: `cover-${p.id}` }}>
          <Cover name={meta.name} color={meta.color} size="hero" />
        </div>
        <div className="project-hero-text">
          <p className="row-sub project-meta">
            {count ? `${count} track${count === 1 ? '' : 's'} · ${formatTime(tracks!.reduce((n, t) => n + (t.current?.meta?.duration ?? 0), 0))} · ` : ''}
            {p.visibility === 'public' ? 'public' : 'private'} · created {date(p.createdAt)}
            {p.role !== 'owner' && ` · you are ${p.role === 'admin' ? 'an admin' : `a ${p.role}`}`}
          </p>
          <h1>{meta.name}</h1>
          {p.role === 'owner' && user && <p className="row-sub project-owner">by {user.username}</p>}
          {meta.description && <p className="voice project-description">{meta.description}</p>}
          {(meta.genre || meta.tags.length > 0) && (
            <p className="project-tags">
              {meta.genre && <span className="tag">{meta.genre}</span>}
              {meta.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            </p>
          )}
          <div className="form-actions project-actions">
            {count !== null && count > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (player.item && tracks!.some((t) => t.id === player.item!.track.id)) return player.toggle();
                  const list = tracks!.filter((t) => t.current);
                  player.playQueue(list.map((t) => ({ project: p, track: t, version: t.current! })), 0);
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d={player.status === 'playing' && player.item?.project.id === p.id ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'} fill="currentColor" /></svg>
                {player.status === 'playing' && player.item?.project.id === p.id ? 'Pause' : 'Play'}
              </button>
            )}
            {canEdit && count !== null && count > 0 && (
              <button type="button" className="btn btn-icon-label" aria-label="Add tracks" onClick={() => setAddOpen(true)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                <span className="btn-label">Add tracks</span>
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn btn-icon-label" aria-label="Edit details" onClick={() => setEditOpen(true)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
                <span className="btn-label">Edit details</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <TracksSection project={p} addOpen={addOpen} setAddOpen={setAddOpen} onTracks={setTracks} />
      {canEdit && <EditDetails p={p} open={editOpen} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
