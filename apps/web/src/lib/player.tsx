import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Project } from './projects';
import { audioUrl, decodePeaks, type Track, type TrackVersion } from './tracks';

export interface QueueItem {
  project: Project;
  track: Track;
  version: TrackVersion;
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
  peaks: Uint8Array | null;
  playQueue: (items: QueueItem[], start: number) => void;
  toggle: () => void;
  seek: (t: number) => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  setLoop: (v: boolean) => void;
  setRate: (r: number) => void;
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
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  const loadToken = useRef(0);
  const item = queue[index] ?? null;

  const load = useCallback(async (q: QueueItem[], i: number) => {
    const it = q[i];
    const el = audio.current;
    if (!it || !el) return;
    const token = ++loadToken.current;
    setStatus('loading');
    setLoadProgress(0);
    setTime(0);
    setDuration(it.version.meta?.duration ?? 0);
    setPeaks(await decodePeaks(it.version.meta));
    try {
      const url = await audioUrl(it.project, it.version, (p) => token === loadToken.current && setLoadProgress(p));
      if (token !== loadToken.current) return;
      el.src = url;
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
      on('play', () => setStatus('playing')),
      on('pause', () => setStatus((s) => (s === 'loading' ? s : 'paused'))),
      on('timeupdate', () => setTime(el.currentTime)),
      on('loadedmetadata', () => Number.isFinite(el.duration) && setDuration(el.duration)),
      on('ended', () => {
        if (index < queue.length - 1) go(index + 1);
        else setStatus('paused');
      }),
      on('error', () => setStatus('error')),
    ];
    return () => offs.forEach((f) => f());
  }, [index, queue, go]);

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
    peaks,
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
        audio.current.preservesPitch = true; // speed without changing pitch
        audio.current.playbackRate = r;
      }
    },
  }), [queue, index, item, status, loadProgress, time, duration, volume, loop, rate, peaks, playQueue, go]);

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
