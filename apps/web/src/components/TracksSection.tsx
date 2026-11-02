import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { formatBytes, formatTime } from '../lib/audio';
import { useFlip } from '../lib/flip';
import { usePlayer } from '../lib/player';
import type { Project } from '../lib/projects';
import { decodeWave, deleteTrack, loadTracks, makeCurrent, UPLOAD_ERRORS, UploadJob, type Track, type TrackVersion, type WaveData } from '../lib/tracks';
import { Menu } from './Menu';
import { Modal } from './Modal';
import { Notice } from './Unavailable';
import { Waveform } from './Waveform';
import { VersionComments } from './Comments';
import { TrimDialog } from './TrimDialog';
import { isOffline, keepOffline, offlineSupported, removeOffline } from '../lib/offline';
import { syncShares } from '../lib/collab';

const ACCEPT = 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg';
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function useWave(v: TrackVersion | null): WaveData | null {
  const [w, setW] = useState<WaveData | null>(null);
  useEffect(() => {
    void decodeWave(v?.meta ?? null).then(setW);
  }, [v]);
  return w;
}

function Insights({ v, plays }: { v: TrackVersion; plays?: { total: number; last30: number; viaLinks: number } }) {
  const m = v.meta;
  const stat = (label: string, value: string | null | undefined) => (
    <div className="stat">
      <dt>{label}</dt>
      <dd className="mono">{value ?? '—'}</dd>
    </div>
  );
  return (
    <dl className="insights">
      {stat('Loudness', m?.loudness != null ? `${m.loudness.toFixed(1)} LUFS` : null)}
      {stat('Peak', m?.peakDb != null ? `${m.peakDb.toFixed(1)} dBFS` : null)}
      {stat('Sample rate', m?.sampleRate ? `${(m.sampleRate / 1000).toFixed(m.sampleRate % 1000 ? 1 : 0)} kHz` : null)}
      {stat('Bit depth', m?.bitDepth ? `${m.bitDepth}-bit` : m && ['mp3', 'm4a', 'ogg'].includes(m.format) ? 'lossy' : null)}
      {stat('Channels', m?.channels ? (m.channels === 1 ? 'Mono' : m.channels === 2 ? 'Stereo' : `${m.channels}`) : null)}
      {stat('Format', m?.format.toUpperCase())}
      {stat('Length', m?.duration ? formatTime(m.duration) : null)}
      {stat('Size', m ? formatBytes(m.size) : null)}
      {plays && stat('Plays', `${plays.last30} in 30 days · ${plays.total} total`)}
    </dl>
  );
}

function TrackRow(props: {
  t: Track;
  index: number;
  project: Project;
  open: boolean;
  dragging: boolean;
  canEdit: boolean;
  canAdmin: boolean;
  onToggle: () => void;
  onPlay: (v?: TrackVersion, startAt?: number) => void;
  onMakeCurrent: (v: TrackVersion) => void;
  onNewVersion: () => void;
  onDelete: () => void;
  onDragStart: (e: PointerEvent<HTMLButtonElement>) => void;
  onMoveKey: (dir: -1 | 1) => void;
  plays?: { total: number; last30: number; viaLinks: number };
  onChanged: (t: Track) => void;
}) {
  const { t, index, open, canEdit, canAdmin } = props;
  const player = usePlayer();
  const wave = useWave(t.current);
  const [confirm, setConfirm] = useState(false);
  const [trimming, setTrimming] = useState<TrackVersion | null>(null);
  const [offline, setOffline] = useState(() => (t.current ? isOffline(t.current.file.id) : false));
  const [saving, setSaving] = useState<number | null>(null);
  const active = player.item?.track.id === t.id;
  const toggleOffline = async () => {
    if (!t.current) return;
    if (offline) {
      await removeOffline(t.current.file.id);
      setOffline(false);
    } else {
      setSaving(0);
      try {
        await keepOffline(t.current, t.title, setSaving);
        setOffline(true);
      } finally {
        setSaving(null);
      }
    }
  };
  const playing = active && player.status === 'playing';
  const loading = active && player.status === 'loading';

  // The whole row plays; buttons and links inside keep their own behaviour.
  const onRowClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, .versions')) return;
    active ? player.toggle() : props.onPlay();
  };
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      props.onMoveKey(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  return (
    <li className={`track${active ? ' active' : ''}${props.dragging ? ' dragging' : ''}`} data-flip-id={t.id} data-dragging={props.dragging}>
      <div className="track-row" onClick={onRowClick}>
        {canEdit && (
          <button type="button" className="drag-handle" aria-label={`Reorder ${t.title}. Use arrow up and down to move.`} onPointerDown={props.onDragStart} onKeyDown={onHandleKey}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
          </button>
        )}
        <button type="button" className="track-play" aria-label={playing ? `Pause ${t.title}` : `Play ${t.title}`} onClick={() => (active ? player.toggle() : props.onPlay())} disabled={!t.current}>
          {loading ? <span className="spinner" aria-hidden="true" /> : playing ? (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
          ) : (
            <>
              <span className="track-num">{index + 1}</span>
              <svg className="track-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
            </>
          )}
        </button>
        <div className="track-main">
          <span className="track-title">{t.title}</span>
          <span className="row-sub">
            v{t.current?.number ?? '–'} · {t.current?.meta ? t.current.meta.format.toUpperCase() : '—'}
            {t.current && t.trims[t.current.id] && ' · trimmed'}
            {saving !== null ? ` · saving offline ${Math.round(saving * 100)}%` : offline && ' · offline'}
            {t.current?.meta?.format === 'aiff' && ' · plays in Safari for now'}
          </span>
        </div>
        <button type="button" className="version-badge" aria-expanded={open} aria-label={`Version ${t.current?.number ?? ''} of ${t.versions.length}. Show versions of ${t.title}`} onClick={props.onToggle}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="m12 4 8 4-8 4-8-4z" /><path d="m4 12 8 4 8-4M4 16l8 4 8-4" /></svg>
          v{t.current?.number ?? '–'}
        </button>
        <span className="mono track-time">{formatTime(t.current?.meta?.duration)}</span>
        <Menu
          label={`More for ${t.title}`}
          items={[
            { label: open ? 'Hide versions' : 'Versions and insights', onSelect: props.onToggle },
            ...(canEdit ? [{ label: 'Upload new version', onSelect: props.onNewVersion }] : []),
            ...(canEdit && t.current?.meta?.duration ? [{ label: 'Trim…', onSelect: () => setTrimming(t.current) }] : []),
            ...(offlineSupported() && t.current ? [{ label: offline ? 'Remove offline copy' : 'Keep offline', onSelect: () => void toggleOffline() }] : []),
            ...(canAdmin ? [{ label: 'Delete track…', onSelect: () => { if (!open) props.onToggle(); setConfirm(true); }, danger: true }] : []),
          ]}
        />
      </div>

      <div className={`versions-wrap${open ? ' open' : ''}`}>
        {open && (
          <div className="versions">
            {t.current && (
              <VersionComments
                project={props.project}
                version={t.current}
                wave={wave}
                active={active && player.item?.version.id === t.current.id}
                time={player.time}
                duration={player.duration}
                onSeek={player.seek}
                onJump={(at) => (active && player.item?.version.id === t.current!.id ? player.seek(at) : props.onPlay(t.current!, at))}
                title={t.title}
              />
            )}
            <ul className="list">
              {[...t.versions].reverse().map((v) => (
                <li key={v.id} className="version">
                  <div className="version-head">
                    <div className="row-main">
                      <div className="row-title">
                        Version {v.number}
                        {v.id === t.current?.id && <span className="tag tag-ok">Current</span>}
                      </div>
                      <p className="row-sub">
                        {day(v.createdAt)}{v.meta?.fileName && ` · ${v.meta.fileName}`}{v.meta?.notes && ` · ${v.meta.notes}`}
                        {t.trims[v.id] && ` · plays ${formatTime(t.trims[v.id]!.start)}–${t.trims[v.id]!.end ? formatTime(t.trims[v.id]!.end!) : 'end'}`}
                      </p>
                    </div>
                    <button type="button" className="btn btn-sm" onClick={() => props.onPlay(v)}>
                      {player.item?.version.id === v.id && player.status === 'playing' ? 'Playing' : 'Play'}<span className="visually-hidden"> version {v.number}</span>
                    </button>
                    {canEdit && v.meta?.duration && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTrimming(v)}>
                        Trim<span className="visually-hidden"> version {v.number}</span>
                      </button>
                    )}
                    {canEdit && v.id !== t.current?.id && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => props.onMakeCurrent(v)}>
                        Make current<span className="visually-hidden"> (version {v.number})</span>
                      </button>
                    )}
                  </div>
                  <Insights v={v} plays={v.id === t.current?.id ? props.plays : undefined} />
                </li>
              ))}
            </ul>
            <div className="form-actions" style={{ marginTop: 'var(--s-4)' }}>
              {canEdit && <button type="button" className="btn btn-sm" onClick={props.onNewVersion}>Upload new version</button>}

              {canAdmin && confirm && (
                <>
                  <span className="row-sub">Delete “{t.title}” and all its versions?</span>
                  <button type="button" className="btn btn-danger btn-sm" onClick={props.onDelete}>Delete</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>Cancel</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {trimming && <TrimDialog project={props.project} track={t} version={trimming} open onClose={() => setTrimming(null)} onSaved={props.onChanged} />}
    </li>
  );
}

export function TracksSection({ project, addOpen, setAddOpen, onTracks }: { project: Project; addOpen: boolean; setAddOpen: (v: boolean) => void; onTracks: (t: Track[]) => void }) {
  const player = usePlayer();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [plays, setPlays] = useState<Record<string, { total: number; last30: number; viaLinks: number }>>({});
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [, force] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [storage, setStorage] = useState<{ used: number; quota: number; platformFull: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const versionTarget = useRef<Track | null>(null);
  const listRef = useFlip<HTMLOListElement>(tracks?.map((t) => t.id).join());
  useEffect(() => {
    if (tracks) onTracks(tracks);
  }, [tracks, onTracks]);
  // Keep share links (and public listening) in step with the tracks.
  const shareSig = useRef<string | null>(null);
  useEffect(() => {
    if (!tracks || project.role === 'listener') return;
    const sig = tracks.map((t) => `${t.id}:${t.current?.id}:${t.title}`).join('|');
    const prev = shareSig.current;
    shareSig.current = sig;
    if (prev === null || prev === sig) return;
    const h = setTimeout(() => void syncShares(project, tracks).catch(() => undefined), 600);
    return () => clearTimeout(h);
  }, [tracks, project]);
  const canEdit = project.role !== 'listener';
  const canAdmin = project.role === 'admin' || project.role === 'owner';

  const refresh = useCallback(async () => {
    try {
      const list = await loadTracks(project);
      setTracks(list);
      onTracks(list);
      if (canEdit) setStorage(await api('GET', '/account/storage'));
      api<{ plays: typeof plays }>('GET', `/projects/${project.id}/plays`).then((r) => setPlays(r.plays)).catch(() => undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [project, canEdit, onTracks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startJob = (job: UploadJob) => {
    setJobs((j) => [...j, job]);
    void job.start().then((t) => t && refresh());
  };
  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    for (const f of Array.from(files)) startJob(new UploadJob(project, f, () => force((n) => n + 1)));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (canEdit) addFiles(e.dataTransfer.files);
  };

  const play = (track: Track, version?: TrackVersion, startAt?: number) => {
    const list = (tracks ?? []).filter((t) => t.current);
    const items = list.map((t) => ({ project, track: t, version: t.id === track.id && version ? version : t.current!, ...(t.id === track.id && startAt ? { startAt } : {}) }));
    player.playQueue(items, Math.max(0, list.findIndex((t) => t.id === track.id)));
  };

  // ---- reordering (drag the handle, or arrow keys on it) ----
  const persistOrder = async (list: Track[], movedId: string) => {
    const i = list.findIndex((t) => t.id === movedId);
    const prev = list[i - 1]?.position;
    const next = list[i + 1]?.position;
    const position = prev === undefined ? (next ?? 1) - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
    setTracks(list.map((t) => (t.id === movedId ? { ...t, position } : t)));
    try {
      await api('PATCH', `/tracks/${movedId}`, { position });
    } catch (e) {
      setError(errorMessage(e));
      void refresh();
    }
  };

  const move = (id: string, dir: -1 | 1) => {
    if (!tracks) return;
    const i = tracks.findIndex((t) => t.id === id);
    const j = i + dir;
    if (j < 0 || j >= tracks.length) return;
    const list = [...tracks];
    [list[i], list[j]] = [list[j]!, list[i]!];
    setTracks(list);
    setAnnounce(`${list[j]!.title} moved to position ${j + 1} of ${list.length}`);
    void persistOrder(list, id);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-flip-id="${id}"] .drag-handle`)?.focus());
  };

  // Re-place the dragged row synchronously after each reorder render (no one-frame jump).
  const dragPlace = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    dragPlace.current?.();
  }, [tracks]);

  /**
   * Smooth drag: the row follows the pointer every frame; it swaps with a
   * neighbour when its centre crosses that neighbour's midpoint (resting
   * layout, not animated boxes); neighbours glide (FLIP); the page scrolls
   * near the edges; on release the row settles into its slot.
   */
  const startDrag = (id: string) => (e: PointerEvent<HTMLButtonElement>) => {
    if (!tracks || e.button !== 0) return;
    e.preventDefault();
    const ol = listRef.current!;
    const el = e.currentTarget.closest('li') as HTMLLIElement;
    const grab = e.clientY - el.getBoundingClientRect().top;
    let list = [...tracks];
    let pointerY = e.clientY;
    let raf = 0;
    el.style.transition = 'none';
    setDraggingId(id);
    document.body.classList.add('is-dragging');

    const place = () => {
      const target = pointerY - ol.getBoundingClientRect().top - grab;
      el.style.transform = `translateY(${target - el.offsetTop}px)`;
      const rows = Array.from(ol.children) as HTMLElement[];
      let i = list.findIndex((t) => t.id === id);
      const centre = target + el.offsetHeight / 2;
      let to = i;
      while (to > 0 && centre < rows[to - 1]!.offsetTop + rows[to - 1]!.offsetHeight / 2) to--;
      while (to < rows.length - 1 && centre > rows[to + 1]!.offsetTop + rows[to + 1]!.offsetHeight / 2) to++;
      if (to !== i) {
        const [moved] = list.splice(i, 1);
        list.splice(to, 0, moved!);
        list = [...list];
        i = to;
        setTracks(list);
      }
    };
    dragPlace.current = place;

    const loop = () => {
      const edge = 72;
      if (pointerY < edge) window.scrollBy(0, -Math.ceil((edge - pointerY) / 6));
      else if (pointerY > window.innerHeight - edge) window.scrollBy(0, Math.ceil((pointerY - (window.innerHeight - edge)) / 6));
      place();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onMove = (ev: globalThis.PointerEvent) => {
      pointerY = ev.clientY;
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      dragPlace.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-dragging');
      // Settle into the slot.
      el.style.transition = 'transform 0.22s cubic-bezier(.2,.7,.2,1)';
      el.style.transform = 'translateY(0)';
      const done = () => {
        el.style.transition = '';
        el.style.transform = '';
        setDraggingId(null);
      };
      el.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 300);
      if (list.map((t) => t.id).join() !== tracks.map((t) => t.id).join()) {
        setAnnounce(`${list.find((t) => t.id === id)!.title} moved to position ${list.findIndex((t) => t.id === id) + 1}`);
        void persistOrder(list, id);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const uploads = jobs.length > 0 && (
    <ul className="uploads" aria-label="Uploads">
      {jobs.map((j) => (
        <li key={j.id} className="upload">
          <div className="row-main">
            <div className="row-title">{j.name}</div>
            <p className="row-sub" aria-live="polite">
              {j.state === 'preparing' && 'Checking and analysing…'}
              {j.state === 'uploading' && `Encrypting and uploading · ${Math.round(j.progress * 100)}%`}
              {j.state === 'finishing' && 'Finishing…'}
              {j.state === 'done' && 'Uploaded'}
              {j.state === 'cancelled' && 'Cancelled'}
              {j.state === 'failed' && (UPLOAD_ERRORS[j.error ?? ''] ?? 'Upload failed. Retry to continue where it stopped.')}
            </p>
            {(j.state === 'uploading' || j.state === 'finishing') && <progress max={1} value={j.progress} aria-label={`Upload progress for ${j.name}`} />}
          </div>
          {(j.state === 'uploading' || j.state === 'preparing') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => j.cancel()}>Cancel</button>}
          {(j.state === 'failed' || j.state === 'cancelled') && j.error !== 'unsupported_format' && j.error !== 'too_large' && (
            <button type="button" className="btn btn-sm" onClick={() => void j.start().then((t) => t && refresh())}>Retry</button>
          )}
          {(j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJobs((x) => x.filter((y) => y !== j))}>
              Dismiss<span className="visually-hidden"> {j.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  const dropzone = (
    <div className={dragOver ? 'dropzone dragging' : 'dropzone'} onDragOver={(e) => (e.preventDefault(), setDragOver(true))} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <p className="voice">Drop audio here</p>
      <p className="row-sub">WAV, AIFF, FLAC, MP3, M4A or OGG, up to 250 MB each. Encrypted in your browser before it uploads.</p>
      <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={storage?.platformFull}>Choose files</button>
      {storage && <p className="storage-meter">{storage.platformFull ? 'Arai’s free storage is full, so uploads are paused.' : `Using ${formatBytes(storage.used)} of ${formatBytes(storage.quota)}`}</p>}
    </div>
  );

  const empty = tracks !== null && tracks.length === 0;
  return (
    <section className="section" aria-labelledby="tracks-h">
      <h2 id="tracks-h" className={empty ? undefined : 'visually-hidden'}>Tracks</h2>
      <p className="visually-hidden" aria-live="polite">{announce}</p>
      {error && <Notice kind="error">{error}</Notice>}

      {empty && canEdit && dropzone}
      {!addOpen && uploads}

      {tracks === null ? (
        <p className="muted" role="status">Loading tracks…</p>
      ) : empty ? (
        !canEdit && <p className="voice" style={{ fontSize: 'var(--fs-lg)' }}>No tracks yet.</p>
      ) : (
        <ol className="tracks" ref={listRef}>
          {tracks.map((t, i) => (
            <TrackRow
              key={t.id}
              t={t}
              index={i}
              project={project}
              open={open === t.id}
              dragging={draggingId === t.id}
              canEdit={canEdit}
              canAdmin={canAdmin}
              onToggle={() => setOpen(open === t.id ? null : t.id)}
              onPlay={(v, at) => play(t, v, at)}
              plays={plays[t.id]}
              onChanged={(nt) => setTracks((prev) => (prev ?? []).map((x) => (x.id === nt.id ? nt : x)))}
              onMakeCurrent={async (v) => {
                try {
                  await makeCurrent(project, t, v.id);
                  await refresh();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
              onNewVersion={() => {
                versionTarget.current = t;
                versionInput.current?.click();
              }}
              onDelete={async () => {
                try {
                  await deleteTrack(t);
                  if (player.item?.track.id === t.id) player.clear();
                  await refresh();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
              onDragStart={startDrag(t.id)}
              onMoveKey={(dir) => move(t.id, dir)}
            />
          ))}
        </ol>
      )}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add tracks">
        {dropzone}
        {uploads}
      </Modal>

      <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
      <input
        ref={versionInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && versionTarget.current) startJob(new UploadJob(project, f, () => force((n) => n + 1), versionTarget.current));
        }}
      />
    </section>
  );
}
