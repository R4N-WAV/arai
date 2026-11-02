/**
 * What someone sees when they open a share link (or listen to a public
 * project): no account needed. Keys come from the URL fragment, which the
 * browser never sends to the server.
 */
import { decryptChunk, fromBase64Url } from '@arai/crypto';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { aiffToWav, browserPlaysAiff } from '../lib/aiff';
import { useAmbient } from '../components/Ambient';
import { CommentThread, type CommentsApi } from '../components/Comments';
import { Cover } from '../components/Cover';
import { HomeLink } from '../components/Logo';
import { Notice } from '../components/Unavailable';
import { api, ApiError } from '../lib/api';
import { formatTime } from '../lib/audio';
import { addGuestComment, guestComments, openShare, shareInfo, type OpenedShare } from '../lib/collab';
import { streamFor } from '../lib/stream';
import { decodeWave, type VersionMeta, type WaveData } from '../lib/tracks';

type Item = OpenedShare['payload']['tracks'][number];

async function decryptAll(s: OpenedShare, t: Item): Promise<Blob> {
  const key = await fromBase64Url(t.fileKey);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < t.file.chunkCount; i++) {
    const res = await fetch(`/api/share/${s.linkId}/files/${t.file.id}/chunks/${i}`, { headers: { 'X-Share-Token': s.token }, credentials: 'omit' });
    if (!res.ok) throw new Error('download_failed');
    parts.push(await decryptChunk(key, t.file.id, i, i === t.file.chunkCount - 1, new Uint8Array(await res.arrayBuffer())));
  }
  return new Blob(parts as BlobPart[], { type: (t.meta as VersionMeta | null)?.mime ?? 'application/octet-stream' });
}

function SharedPlayer({ s }: { s: OpenedShare }) {
  const { setSources } = useAmbient();
  const audio = useRef<HTMLAudioElement>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [wave, setWave] = useState<WaveData | null>(null);
  const [open, setOpen] = useState<number>(0);
  const [downloading, setDownloading] = useState(false);
  const p = s.payload;
  const tracks = p.tracks;
  const current = index !== null ? tracks[index] : null;

  useEffect(() => {
    setSources([p.project.color]);
    return () => setSources([]);
  }, [p.project.color, setSources]);
  useEffect(() => {
    void decodeWave((tracks[open]?.meta as VersionMeta | null) ?? null).then(setWave);
  }, [open, tracks]);

  const play = async (i: number, startAt = 0) => {
    const el = audio.current!;
    const t = tracks[i]!;
    setIndex(i);
    setOpen(i);
    setStatus('loading');
    setDuration((t.meta as VersionMeta | null)?.duration ?? 0);
    try {
      const key = await fromBase64Url(t.fileKey);
      const aiff = (t.meta as VersionMeta | null)?.format === 'aiff' && !browserPlaysAiff();
      let url = aiff ? null : await streamFor({ fileId: t.file.id, key, count: t.file.chunkCount, encSize: t.file.encSize, mime: (t.meta as VersionMeta | null)?.mime ?? 'application/octet-stream', base: `/api/share/${s.linkId}/files/`, shareToken: s.token });
      if (!url) {
        const blob = await decryptAll(s, t);
        url = URL.createObjectURL(aiff ? new Blob([aiffToWav(new Uint8Array(await blob.arrayBuffer())) as BlobPart], { type: 'audio/wav' }) : blob);
      }
      el.src = url;
      if (startAt > 0) el.addEventListener('loadedmetadata', () => (el.currentTime = startAt), { once: true });
      await el.play();
      void api('POST', `/share/${s.linkId}/play`, { token: s.token, versionId: t.versionId }).catch(() => undefined);
    } catch {
      setStatus('error');
    }
  };
  const toggle = (i: number) => {
    const el = audio.current!;
    if (index === i) {
      if (el.paused) void el.play();
      else el.pause();
    } else void play(i);
  };

  const download = async (t: Item) => {
    setDownloading(true);
    try {
      const blob = await decryptAll(s, t);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (t.meta as VersionMeta | null)?.fileName ?? `${t.title}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } finally {
      setDownloading(false);
    }
  };

  const commentsApi: CommentsApi = useMemo(() => {
    const versionId = tracks[open]?.versionId ?? '';
    return {
      load: async () => (await guestComments(s)).filter((c) => c.versionId === versionId),
      add: (text, at, parentId, name) => addGuestComment(s, versionId, { text, at, name: name || 'Guest' }, parentId),
      canResolve: () => false,
      canEdit: () => false,
      canDelete: () => false,
      guestName: true,
    };
  }, [s, open, tracks]);

  return (
    <div className="share-page">
      <header className="project-hero">
        <Cover name={p.project.name} color={p.project.color} size="hero" art={p.project.art ?? null} />
        <div className="project-hero-text">
          <p className="row-sub project-meta">{tracks.length} track{tracks.length === 1 ? '' : 's'} · shared with you</p>
          <h1>{p.project.name}</h1>
          {p.project.description && <p className="voice project-description">{p.project.description}</p>}
          {tracks.length > 0 && (
            <div className="form-actions project-actions">
              <button type="button" className="btn btn-primary" onClick={() => toggle(index ?? 0)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d={status === 'playing' ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'} fill="currentColor" /></svg>
                {status === 'playing' ? 'Pause' : 'Play'}
              </button>
            </div>
          )}
        </div>
      </header>

      <ol className="tracks" aria-label="Tracks">
        {tracks.map((t, i) => {
          const active = index === i;
          const playing = active && status === 'playing';
          return (
            <li key={t.versionId} className={`track${active ? ' active' : ''}`}>
              <div className="track-row share-track-row" onClick={(e) => !(e.target as HTMLElement).closest("button") && toggle(i)}>
                <button type="button" className="track-play" aria-label={playing ? `Pause ${t.title}` : `Play ${t.title}`} onClick={() => toggle(i)}>
                  {active && status === 'loading' ? <span className="spinner" aria-hidden="true" /> : playing ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
                  ) : (
                    <>
                      <span className="track-num">{i + 1}</span>
                      <svg className="track-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
                    </>
                  )}
                </button>
                <div className="track-main">
                  <span className="track-title">{t.title}</span>
                  <span className="row-sub">v{t.versionNumber}{active && status === 'error' && ' · could not play this file here'}</span>
                </div>
                {s.allowDownload && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={downloading} onClick={() => void download(t)}>
                    Download<span className="visually-hidden"> {t.title}</span>
                  </button>
                )}
                <button type="button" className="version-badge" aria-expanded={open === i} onClick={() => setOpen(i)} aria-label={`Show waveform${s.allowComments ? ' and comments' : ''} for ${t.title}`}>
                  {s.allowComments ? 'Comments' : 'Wave'}
                </button>
                <span className="mono track-time">{formatTime((t.meta as VersionMeta | null)?.duration)}</span>
              </div>
              {open === i && (
                <div className="versions-wrap open">
                  <div className="versions">
                    {s.allowComments ? (
                      <CommentThread
                        api={commentsApi}
                        wave={wave}
                        active={active}
                        time={time}
                        duration={duration}
                        onSeek={(x) => audio.current && (audio.current.currentTime = x)}
                        onJump={(x) => (active && audio.current ? (audio.current.currentTime = x) : void play(i, x))}
                        title={t.title}
                        version={{ id: t.versionId, meta: t.meta as VersionMeta | null }}
                      />
                    ) : null}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {current && (
        <p className="row-sub share-now" aria-live="polite">
          {status === 'playing' ? 'Playing' : status === 'loading' ? 'Decrypting' : 'Paused'}: {current.title} · {formatTime(time)} / {formatTime(duration)}
        </p>
      )}
      <audio
        ref={audio}
        onPlay={() => setStatus('playing')}
        onPause={() => setStatus('paused')}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onEnded={() => (index !== null && index < tracks.length - 1 ? void play(index + 1) : setStatus('paused'))}
        onError={() => setStatus('error')}
      />
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-page">
      <header className="public-bar">
        <HomeLink />
        <Link to="/signin" className="btn btn-ghost btn-sm">Sign in</Link>
      </header>
      <main id="main" className="content">{children}</main>
    </div>
  );
}

/** /s/:id#secret */
export function SharePage() {
  const { id = '' } = useParams();
  const secret = typeof location !== 'undefined' ? location.hash.slice(1) : '';
  const [needsPassword, setNeedsPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [opened, setOpened] = useState<OpenedShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      setError('This link is incomplete. Ask for the full link, including everything after #.');
      return;
    }
    shareInfo(id)
      .then(async (info) => {
        setNeedsPassword(info.hasPassword);
        if (!info.hasPassword) setOpened(await openShare(id, secret));
      })
      .catch(() => setError('This link has expired or was turned off.'));
  }, [id, secret]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setOpened(await openShare(id, secret, password));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'wrong_password' ? 'That password is not right.' : err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a few minutes.' : 'This link could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      {error && <Notice kind="error">{error}</Notice>}
      {opened ? (
        <SharedPlayer s={opened} />
      ) : needsPassword ? (
        <form className="auth-panel" onSubmit={submit}>
          <h1>Protected link</h1>
          <p className="voice">Someone shared music with you. Enter the password they gave you.</p>
          <label className="field">
            <span className="field-label">Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? 'Opening…' : 'Open'}</button>
        </form>
      ) : (
        !error && <p className="muted" role="status">Opening…</p>
      )}
    </Frame>
  );
}

/** /listen/:projectId: public projects, playable by anyone. */
export function ListenPage() {
  const { projectId = '' } = useParams();
  const [opened, setOpened] = useState<OpenedShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ link: { id: string; secret: string } | null }>('GET', `/public/projects/${projectId}`)
      .then(async (r) => {
        if (!r.link) throw new Error('none');
        setOpened(await openShare(r.link.id, r.link.secret));
      })
      .catch(() => setError('This project is not public, or it has no tracks to play yet.'));
  }, [projectId]);
  return (
    <Frame>
      {error && <Notice kind="error">{error}</Notice>}
      {opened ? <SharedPlayer s={opened} /> : !error && <p className="muted" role="status">Loading…</p>}
    </Frame>
  );
}
