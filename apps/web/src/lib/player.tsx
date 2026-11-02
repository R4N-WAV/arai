import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Project } from './projects';
import { prefetch, streamUrl } from './stream';
import { browserPlaysAiff } from './aiff';
import { audioUrl, decodeWave, type Track, type TrackVersion, type WaveData } from './tracks';

export interface QueueItem {
  project: Project;
  track: Track;
  version: TrackVersion;
  /** Start position in seconds (jumping to a comment). */
  startAt?: number;
}

interface PlayerState {
  queue: QueueItem[];
  index: number;
  item: QueueItem | null;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  loadProgress: number;
  time: number;
  duration: number;
  volume: number;
  loop: boolean;
  rate: number;
  /** false = varispeed: pitch follows speed, like a tape machine. */
  pitchLock: boolean;
  /** Section loop (A–B), seconds. */
  ab: { a: number | null; b: number | null };
  wave: WaveData | null;
  playQueue: (items: QueueItem[], start: number) => void;
  toggle: () => void;
  seek: (t: number) => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  setLoop: (v: boolean) => void;
  setRate: (r: number) => void;
  setPitchLock: (v: boolean) => void;
  /** Cycles: set A at the playhead → set B → clear. */
  cycleAB: () => void;
  /** Stop and clear the queue (e.g. the playing track was deleted). */
  clear: () => void;
}

const Ctx = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlayerState['status']>('idle');
  const [loadProgress, setLoadProgress] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [loop, setLoop] = useState(false);
  const [rate, setRateState] = useState(1);
  const [pitchLock, setPitchLockState] = useState(true);
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const counted = useRef<string | null>(null);
  const abRef = useRef(ab);
  abRef.current = ab;
  const [wave, setWave] = useState<WaveData | null>(null);
  const loadToken = useRef(0);
  const prefetched = useRef(new Set<string>());
  const item = queue[index] ?? null;

  const load = useCallback(async (q: QueueItem[], i: number) => {
    const it = q[i];
    const el = audio.current;
    if (!it || !el) return;
    const token = ++loadToken.current;
    setStatus('loading');
    setAb({ a: null, b: null });
    setLoadProgress(0);
    setTime(0);
    setDuration(it.version.meta?.duration ?? 0);
    setWave(await decodeWave(it.version.meta));
    try {
      // Stream (starts after the first chunk); fall back to full decrypt.
      // AIFF outside Safari is converted in memory, so it skips the streaming path.
      let url = it.version.meta?.format === 'aiff' && !browserPlaysAiff() ? null : await streamUrl(it.project, it.version).catch(() => null);
      if (token !== loadToken.current) return;
      const startAt = it.startAt ?? it.track.trims?.[it.version.id]?.start ?? 0;
      const applyStart = () => {
        if (startAt > 0) el.addEventListener('loadedmetadata', () => (el.currentTime = startAt), { once: true });
      };
      if (url) {
        el.src = url;
        applyStart();
        el.playbackRate = rate;
        try {
          await el.play();
          return;
        } catch (e) {
          if ((e as DOMException)?.name === 'NotAllowedError') throw e;
          url = null; // stream expired or unsupported format: decrypt in memory instead
        }
      }
      const blobUrl = await audioUrl(it.project, it.version, (p) => token === loadToken.current && setLoadProgress(p));
      if (token !== loadToken.current) return;
      el.src = blobUrl;
      applyStart();
      el.playbackRate = rate;
      await el.play();
    } catch {
      if (token === loadToken.current) setStatus('error');
    }
  }, [rate]);

  const playQueue = useCallback((items: QueueItem[], start: number) => {
    setQueue(items);
    setIndex(start);
    void load(items, start);
  }, [load]);

  const go = useCallback((i: number) => {
    if (i < 0 || i >= queue.length) return;
    setIndex(i);
    void load(queue, i);
  }, [queue, load]);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const on = (name: string, fn: () => void) => (el.addEventListener(name, fn), () => el.removeEventListener(name, fn));
    const offs = [
      // 'playing' fires only when sound actually starts; 'waiting' when it stalls.
      on('playing', () => {
        setStatus('playing');
        // Count one play per load (daily totals only; see /projects/:id/plays).
        const cur = queue[index];
        if (cur && counted.current !== `${cur.version.id}:${loadToken.current}`) {
          counted.current = `${cur.version.id}:${loadToken.current}`;
          void fetch(`/api/tracks/${cur.track.id}/play`, { method: 'POST', headers: { 'X-Arai-CSRF': '1' }, credentials: 'same-origin' }).catch(() => undefined);
        }
      }),
      on('waiting', () => setStatus('loading')),
      on('pause', () => setStatus((s) => (s === 'loading' ? s : 'paused'))),
      on('timeupdate', () => {
        setTime(el.currentTime);
        const cur = queue[index];
        // Section loop, then the version's trim end (acts like the track ending).
        if (abRef.current.a !== null && abRef.current.b !== null && el.currentTime >= abRef.current.b) {
          el.currentTime = abRef.current.a;
          return;
        }
        const end = cur?.track.trims?.[cur.version.id]?.end;
        if (end && el.currentTime >= end) {
          if (el.loop) el.currentTime = cur.track.trims![cur.version.id]!.start ?? 0;
          else if (index < queue.length - 1) go(index + 1);
          else {
            el.pause();
            el.currentTime = end;
          }
          return;
        }
        // Warm the next track well before this one ends, so the switch is instant.
        const nextItem = queue[index + 1];
        if (nextItem && el.duration && el.currentTime > Math.min(10, el.duration * 0.25) && !prefetched.current.has(nextItem.version.id)) {
          prefetched.current.add(nextItem.version.id);
          void prefetch(nextItem.project, nextItem.version);
        }
      }),
      on('loadedmetadata', () => Number.isFinite(el.duration) && setDuration(el.duration)),
      on('ended', () => {
        if (index < queue.length - 1) go(index + 1);
        else setStatus('paused');
      }),
      on('error', () => setStatus('error')),
    ];
    return () => offs.forEach((f) => f());
  }, [index, queue, go]);

  // Operating-system media keys, lock screen and headphone buttons.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !item) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: item.track.title, artist: item.project.meta?.name ?? 'Arai', album: `Version ${item.version.number}` });
    const el = audio.current;
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(a, h);
      } catch {
        /* unsupported action */
      }
    };
    set('play', () => void el?.play());
    set('pause', () => el?.pause());
    set('previoustrack', () => (el && el.currentTime > 3 ? (el.currentTime = 0) : go(index - 1)));
    set('nexttrack', index < queue.length - 1 ? () => go(index + 1) : null);
    set('seekto', (d) => el && d.seekTime != null && (el.currentTime = d.seekTime));
    set('seekbackward', () => el && (el.currentTime = Math.max(0, el.currentTime - 10)));
    set('seekforward', () => el && (el.currentTime = el.currentTime + 10));
  }, [item, index, queue.length, go]);

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';
  }, [status]);

  // Keyboard: Space/K play-pause, ←/→ (J/L) seek, Shift+←/→ prev/next, ↑/↓ volume, M mute, R repeat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = audio.current;
      if (!el || !item || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="slider"],dialog[open]'))) return;
      const isButton = t?.tagName === 'BUTTON' || t?.tagName === 'A';
      switch (e.key) {
        case ' ':
          if (isButton) return; // let Space activate the focused button
          e.preventDefault();
          if (el.paused) void el.play();
          else el.pause();
          break;
        case 'k':
          el.paused ? void el.play() : el.pause();
          break;
        case 'ArrowRight':
        case 'l':
          if (e.shiftKey) go(index + 1);
          else el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 5);
          e.preventDefault();
          break;
        case 'ArrowLeft':
        case 'j':
          if (e.shiftKey) el.currentTime > 3 ? (el.currentTime = 0) : go(index - 1);
          else el.currentTime = Math.max(0, el.currentTime - 5);
          e.preventDefault();
          break;
        case 'ArrowUp':
          e.preventDefault();
          el.volume = Math.min(1, el.volume + 0.05);
          setVolumeState(el.volume);
          break;
        case 'ArrowDown':
          e.preventDefault();
          el.volume = Math.max(0, el.volume - 0.05);
          setVolumeState(el.volume);
          break;
        case 'm':
          el.muted = !el.muted;
          break;
        case 'r':
          el.loop = !el.loop;
          setLoop(el.loop);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, index, go]);

  const value = useMemo<PlayerState>(() => ({
    queue,
    index,
    item,
    status,
    loadProgress,
    time,
    duration,
    volume,
    loop,
    rate,
    pitchLock,
    ab,
    wave,
    playQueue,
    toggle: () => {
      const el = audio.current;
      if (!el || !item) return;
      if (el.paused) void el.play();
      else el.pause();
    },
    seek: (t) => {
      const el = audio.current;
      if (el && Number.isFinite(t)) el.currentTime = t;
      setTime(t);
    },
    next: () => go(index + 1),
    prev: () => {
      const el = audio.current;
      if (el && el.currentTime > 3) el.currentTime = 0;
      else go(index - 1);
    },
    setVolume: (v) => {
      setVolumeState(v);
      if (audio.current) audio.current.volume = v;
    },
    setLoop: (v) => {
      setLoop(v);
      if (audio.current) audio.current.loop = v;
    },
    clear: () => {
      loadToken.current++;
      audio.current?.pause();
      audio.current?.removeAttribute('src');
      setQueue([]);
      setIndex(0);
      setStatus('idle');
    },
    setRate: (r) => {
      setRateState(r);
      if (audio.current) {
        audio.current.preservesPitch = pitchLock; // speed without changing pitch, unless varispeed
        audio.current.playbackRate = r;
      }
    },
    setPitchLock: (v) => {
      setPitchLockState(v);
      if (audio.current) audio.current.preservesPitch = v;
    },
    cycleAB: () => {
      const t = audio.current?.currentTime ?? 0;
      setAb((x) => (x.a === null ? { a: t, b: null } : x.b === null ? (t > x.a + 0.25 ? { a: x.a, b: t } : { a: null, b: null }) : { a: null, b: null }));
    },
  }), [queue, index, item, status, loadProgress, time, duration, volume, loop, rate, pitchLock, ab, wave, playQueue, go]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio ref={audio} preload="auto" hidden />
    </Ctx.Provider>
  );
}

export function usePlayer(): PlayerState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer outside PlayerProvider');
  return v;
}
