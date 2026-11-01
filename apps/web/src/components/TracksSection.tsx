import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { formatBytes, formatTime } from '../lib/audio';
import { usePlayer } from '../lib/player';
import type { Project } from '../lib/projects';
import { decodePeaks, deleteTrack, loadTracks, makeCurrent, UPLOAD_ERRORS, UploadJob, type Track, type TrackVersion } from '../lib/tracks';
import { Notice } from './Unavailable';
import { Waveform } from './Waveform';

const ACCEPT = 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg';
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function MiniWave({ v }: { v: TrackVersion | null }) {
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  useEffect(() => {
    void decodePeaks(v?.meta ?? null).then(setPeaks);
  }, [v]);
  return <Waveform peaks={peaks} current={0} duration={0} count={64} className="waveform waveform-mini" label="Waveform" />;
}

export function TracksSection({ project }: { project: Project }) {
  const player = usePlayer();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [, force] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [storage, setStorage] = useState<{ used: number; quota: number; platformFull: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const versionTarget = useRef<Track | null>(null);
  const canEdit = project.role !== 'listener';
  const canAdmin = project.role === 'admin' || project.role === 'owner';

  const refresh = useCallback(async () => {
    try {
      setTracks(await loadTracks(project));
      if (canEdit) setStorage(await api('GET', '/account/storage'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [project, canEdit]);

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
    setDragging(false);
    if (canEdit) addFiles(e.dataTransfer.files);
  };

  const play = (track: Track, version?: TrackVersion) => {
    const list = (tracks ?? []).filter((t) => t.current);
    const items = list.map((t) => ({ project, track: t, version: t.id === track.id && version ? version : t.current! }));
    player.playQueue(items, Math.max(0, list.findIndex((t) => t.id === track.id)));
  };

  const isPlaying = (t: Track, v?: TrackVersion) => player.item?.track.id === t.id && (!v || player.item.version.id === v.id) && player.status === 'playing';

  return (
    <section className="section" aria-labelledby="tracks-h">
      <h2 id="tracks-h">Tracks</h2>
      {error && <Notice kind="error">{error}</Notice>}

      {canEdit && (
        <div
          className={dragging ? 'dropzone dragging' : 'dropzone'}
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="voice">Drop audio here</p>
          <p className="row-sub">WAV, AIFF, FLAC, MP3, M4A or OGG, up to 250 MB each. Encrypted in your browser before it uploads.</p>
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={storage?.platformFull}>
            Choose files
          </button>
          <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          {storage && (
            <p className="storage-meter">
              {storage.platformFull ? 'Arai’s free storage is full, so uploads are paused.' : `Using ${formatBytes(storage.used)} of ${formatBytes(storage.quota)}`}
            </p>
          )}
        </div>
      )}

      {jobs.length > 0 && (
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
      )}

      {tracks === null ? (
        <p className="muted" role="status">Loading tracks…</p>
      ) : tracks.length === 0 ? (
        <p className="voice" style={{ fontSize: 'var(--fs-lg)' }}>No tracks yet.</p>
      ) : (
        <ol className="tracks">
          {tracks.map((t, i) => (
            <li key={t.id} className="track">
              <div className="track-row">
                <button
                  type="button"
                  className="track-play"
                  aria-label={isPlaying(t) ? `Pause ${t.title}` : `Play ${t.title}`}
                  onClick={() => (player.item?.track.id === t.id ? player.toggle() : play(t))}
                  disabled={!t.current}
                >
                  {isPlaying(t) ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
                  ) : (
                    <span className="track-num">{i + 1}</span>
                  )}
                </button>
                <div className="track-main">
                  <span className="track-title">{t.title}</span>
                  <span className="row-sub">
                    v{t.current?.number ?? '–'} · {t.current?.meta ? t.current.meta.format.toUpperCase() : '—'}
                    {t.current?.meta?.format === 'aiff' && ' · plays in Safari for now'}
                  </span>
                </div>
                <MiniWave v={t.current} />
                <span className="mono track-time">{formatTime(t.current?.meta?.duration)}</span>
                <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                  Versions<span className="visually-hidden"> of {t.title}</span>
                </button>
              </div>

              {open === t.id && (
                <div className="versions">
                  <ul className="list">
                    {[...t.versions].reverse().map((v) => (
                      <li key={v.id} className="row">
                        <div className="row-main">
                          <div className="row-title">
                            Version {v.number}
                            {v.id === t.current?.id && <span className="tag tag-ok">Current</span>}
                          </div>
                          <p className="row-sub">
                            {day(v.createdAt)} · {v.meta ? `${v.meta.format.toUpperCase()} · ${formatTime(v.meta.duration)} · ${v.meta.fileName}` : 'details locked'}
                            {v.meta?.notes && ` · ${v.meta.notes}`}
                          </p>
                        </div>
                        <button type="button" className="btn btn-sm" onClick={() => play(t, v)}>
                          {isPlaying(t, v) ? 'Playing' : 'Play'}<span className="visually-hidden"> version {v.number}</span>
                        </button>
                        {canEdit && v.id !== t.current?.id && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={async () => { try { await makeCurrent(project, t, v.id); await refresh(); } catch (e) { setError(errorMessage(e)); } }}>
                            Make current<span className="visually-hidden"> (version {v.number})</span>
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="form-actions" style={{ marginTop: 'var(--s-4)' }}>
                    {canEdit && (
                      <button type="button" className="btn btn-sm" onClick={() => { versionTarget.current = t; versionInput.current?.click(); }}>
                        Upload new version
                      </button>
                    )}
                    {canAdmin && confirmDelete !== t.id && (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(t.id)}>Delete track…</button>
                    )}
                    {canAdmin && confirmDelete === t.id && (
                      <>
                        <span className="row-sub">Delete “{t.title}” and all its versions?</span>
                        <button type="button" className="btn btn-danger btn-sm" onClick={async () => { try { await deleteTrack(t); if (player.item?.track.id === t.id) player.clear(); setConfirmDelete(null); await refresh(); } catch (e) { setError(errorMessage(e)); } }}>Delete</button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
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
