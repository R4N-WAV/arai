import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ProjectCover } from '../components/Cover';
import { Notice } from '../components/Unavailable';
import { roleWithArticle, useProjects, type Project } from '../lib/projects';
import { useLibrary } from '../lib/library';
import { usePlayer } from '../lib/player';
import { loadTracks, type Track } from '../lib/tracks';
import { Modal } from '../components/Modal';
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

  return <LibraryGrid projects={projects} error={error} />;
}

type Sort = 'recent' | 'name' | 'created';
const trackCache = new Map<string, { at: number; tracks: Track[] }>();

function LibraryGrid({ projects, error }: { projects: Project[]; error: string | null }) {
  const { prefs, togglePin, addFolder, renameFolder, deleteFolder, setInFolder } = useLibrary();
  const player = usePlayer();
  const [filter, setFilter] = useState<string>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [q, setQ] = useState('');
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [trackHits, setTrackHits] = useState<Array<{ p: Project; t: Track }>>([]);
  const query = q.trim().toLowerCase();

  // Track titles are encrypted per project: load (and cache) them only when searching.
  useEffect(() => {
    if (query.length < 2) return setTrackHits([]);
    let alive = true;
    const h = setTimeout(async () => {
      const hits: Array<{ p: Project; t: Track }> = [];
      for (const p of projects.filter((x) => x.meta)) {
        let c = trackCache.get(p.id);
        if (!c || c.at !== p.updatedAt) {
          c = { at: p.updatedAt, tracks: await loadTracks(p).catch(() => []) };
          trackCache.set(p.id, c);
        }
        for (const t of c.tracks) if (t.title.toLowerCase().includes(query)) hits.push({ p, t });
      }
      if (alive) setTrackHits(hits.slice(0, 30));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [query, projects]);

  const folder = prefs.folders.find((f) => f.id === filter);
  const matches = (p: Project) =>
    !query || [p.meta?.name, p.meta?.genre, p.meta?.description, ...(p.meta?.tags ?? [])].some((x) => x?.toLowerCase().includes(query));
  const shown = projects
    .filter((p) => (filter === 'all' ? true : filter === 'pinned' ? prefs.pins.includes(p.id) : filter === 'private' || filter === 'public' ? p.visibility === filter : folder ? folder.projectIds.includes(p.id) : true))
    .filter(matches)
    .sort((a, b) => {
      const pin = Number(prefs.pins.includes(b.id)) - Number(prefs.pins.includes(a.id));
      if (pin) return pin;
      if (sort === 'name') return (a.meta?.name ?? '').localeCompare(b.meta?.name ?? '');
      if (sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
  const recent = prefs.recent.filter((r) => projects.some((p) => p.id === r.projectId)).slice(0, 6);
  const playRecent = async (r: (typeof recent)[number]) => {
    const p = projects.find((x) => x.id === r.projectId)!;
    const tracks = await loadTracks(p).catch(() => []);
    const list = tracks.filter((t) => t.current);
    const i = list.findIndex((t) => t.id === r.trackId);
    if (i >= 0) player.playQueue(list.map((t) => ({ project: p, track: t, version: t.current! })), i);
  };
  const playHit = async (p: Project, t: Track) => {
    const list = (trackCache.get(p.id)?.tracks ?? []).filter((x) => x.current);
    player.playQueue(list.map((x) => ({ project: p, track: x, version: x.current! })), Math.max(0, list.findIndex((x) => x.id === t.id)));
  };

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

      {recent.length > 0 && !query && (
        <section className="recent" aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-title">Recently played</h2>
          <ul className="recent-list">
            {recent.map((r) => {
              const p = projects.find((x) => x.id === r.projectId)!;
              return (
                <li key={r.trackId}>
                  <button type="button" className="recent-item" onClick={() => void playRecent(r)}>
                    <ProjectCover p={p} size="thumb" />
                    <span className="recent-text">
                      <span className="recent-title">{r.title}</span>
                      <span className="row-sub">{p.meta?.name}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="library-tools">
        <label className="visually-hidden" htmlFor="lib-q">Search your library</label>
        <input id="lib-q" className="input lib-search" type="search" placeholder="Search projects and tracks" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="visually-hidden" htmlFor="lib-sort">Sort</label>
        <select id="lib-sort" className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="recent">Recently changed</option>
          <option value="name">Name</option>
          <option value="created">Newest</option>
        </select>
      </div>
      <div className="filters" role="group" aria-label="Show projects">
        {(['all', 'pinned', 'private', 'public'] as const).map((f) => (
          <button key={f} type="button" className="filter" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'pinned' ? 'Pinned' : f === 'private' ? 'Private' : 'Public'}
          </button>
        ))}
        {prefs.folders.map((f) => (
          <button key={f.id} type="button" className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.name}
          </button>
        ))}
        <button type="button" className="filter filter-manage" onClick={() => setFoldersOpen(true)}>Folders…</button>
      </div>

      {trackHits.length > 0 && (
        <section className="section" aria-labelledby="hits-h">
          <h2 id="hits-h" className="section-title">Tracks</h2>
          <ul className="list">
            {trackHits.map(({ p, t }) => (
              <li key={t.id} className="row">
                <ProjectCover p={p} size="thumb" />
                <div className="row-main">
                  <div className="row-title">{t.title}</div>
                  <p className="row-sub">{p.meta?.name}</p>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => void playHit(p, t)}>Play<span className="visually-hidden"> {t.title}</span></button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {shown.length === 0 ? (
        query && trackHits.length ? null : <p className="muted">{query ? 'Nothing in your library matches that.' : filter === 'pinned' ? 'Nothing pinned yet. Use the pin on a cover.' : folder ? 'This folder is empty. Add projects in Folders….' : `No ${filter} projects.`}</p>
      ) : (
        <ul className="sleeves">
          {shown.map((p) => {
            const pinned = prefs.pins.includes(p.id);
            return (
              <li key={p.id} className="sleeve-item">
                <Link to={`/projects/${p.id}`} className="sleeve" viewTransition>
                  <div className="cover-shared" style={{ viewTransitionName: `cover-${p.id}` }}>
                    <ProjectCover p={p} />
                  </div>
                  <span className="sleeve-name">{p.meta?.name ?? 'Locked project'}</span>
                  <span className="sleeve-meta">
                    {p.visibility} · {p.role === 'owner' ? `created ${date(p.createdAt)}` : `shared with you`}
                  </span>
                </Link>
                <button type="button" className={`pin-btn${pinned ? ' on' : ''}`} aria-pressed={pinned} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${p.meta?.name ?? 'project'}`} onClick={() => togglePin(p.id)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" /></svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={foldersOpen} onClose={() => setFoldersOpen(false)} title="Folders">
        <p className="row-sub">Folders are private to you and stored encrypted. A project can be in several folders.</p>
        <form
          className="form-actions"
          style={{ margin: 'var(--s-4) 0' }}
          onSubmit={(e) => {
            e.preventDefault();
            const input = (e.currentTarget.elements.namedItem('fname') as HTMLInputElement);
            if (input.value.trim()) {
              addFolder(input.value);
              input.value = '';
            }
          }}
        >
          <label className="visually-hidden" htmlFor="fname">New folder name</label>
          <input id="fname" name="fname" className="input input-sm" placeholder="New folder" maxLength={60} />
          <button type="submit" className="btn btn-sm">Add folder</button>
        </form>
        {prefs.folders.map((f) => (
          <fieldset key={f.id} className="folder-edit">
            <legend className="visually-hidden">{f.name}</legend>
            <div className="form-actions">
              <label className="visually-hidden" htmlFor={`fn-${f.id}`}>Folder name</label>
              <input id={`fn-${f.id}`} className="input input-sm" defaultValue={f.name} maxLength={60} onBlur={(e) => renameFolder(f.id, e.target.value)} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => deleteFolder(f.id)}>Delete<span className="visually-hidden"> folder {f.name}</span></button>
            </div>
            <div className="folder-projects">
              {projects.filter((p) => p.meta).map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={f.projectIds.includes(p.id)} onChange={(e) => setInFolder(f.id, p.id, e.target.checked)} /> {p.meta!.name}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </Modal>
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
