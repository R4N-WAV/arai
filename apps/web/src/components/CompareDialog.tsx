import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatTime } from '../lib/audio';
import { usePlayer } from '../lib/player';
import type { Project } from '../lib/projects';
import { audioUrl, decodeWave, type Track, type TrackVersion, type WaveData } from '../lib/tracks';
import { Modal } from './Modal';
import { Notice } from './Unavailable';
import { Waveform } from './Waveform';

/**
 * A/B compare: both versions run in sync from the same position through Web
 * Audio; switching only moves the volume, so the jump is instant and lands on
 * the same beat. Loudness matching turns the louder version down to the
 * quieter one's integrated loudness (BS.1770), so you hear the mix, not the level.
 */
export function CompareDialog({ project, track, open, onClose }: { project: Project; track: Track; open: boolean; onClose: () => void }) {
  const player = usePlayer();
  const versions = [...track.versions].reverse();
  const [aId, setA] = useState(track.current?.id ?? versions[0]?.id);
  const [bId, setB] = useState(versions.find((v) => v.id !== (track.current?.id ?? versions[0]?.id))?.id);
  const [side, setSide] = useState<'a' | 'b'>('a');
  const [match, setMatch] = useState(true);
  const [state, setState] = useState<'loading' | 'ready' | 'playing' | 'error'>('loading');
  const [time, setTime] = useState(0);
  const [wave, setWave] = useState<WaveData | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const bufs = useRef<{ a: AudioBuffer | null; b: AudioBuffer | null }>({ a: null, b: null });
  const nodes = useRef<{ src: AudioBufferSourceNode[]; ga: GainNode | null; gb: GainNode | null; started: number; offset: number }>({ src: [], ga: null, gb: null, started: 0, offset: 0 });
  const raf = useRef(0);
  const va = versions.find((v) => v.id === aId) ?? null;
  const vb = versions.find((v) => v.id === bId) ?? null;
  const duration = Math.max(bufs.current.a?.duration ?? 0, bufs.current.b?.duration ?? 0, va?.meta?.duration ?? 0, vb?.meta?.duration ?? 0);

  const gains = useCallback(() => {
    const la = va?.meta?.loudness, lb = vb?.meta?.loudness;
    if (!match || la == null || lb == null) return { a: 1, b: 1 };
    const target = Math.min(la, lb);
    return { a: 10 ** ((target - la) / 20), b: 10 ** ((target - lb) / 20) };
  }, [va, vb, match]);

  const stop = useCallback(() => {
    const n = nodes.current;
    if (ctx.current && n.src.length) n.offset += ctx.current.currentTime - n.started;
    n.src.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
    n.src = [];
    cancelAnimationFrame(raf.current);
  }, []);

  const start = useCallback((at: number) => {
    const c = ctx.current;
    if (!c || !bufs.current.a || !bufs.current.b) return;
    // Browsers keep an AudioContext suspended until a user gesture resumes it.
    if (c.state === 'suspended') void c.resume();
    stop();
    const g = gains();
    const ga = c.createGain();
    const gb = c.createGain();
    ga.gain.value = side === 'a' ? g.a : 0;
    gb.gain.value = side === 'b' ? g.b : 0;
    ga.connect(c.destination);
    gb.connect(c.destination);
    const when = c.currentTime + 0.05;
    const src = (['a', 'b'] as const).map((k) => {
      const s = c.createBufferSource();
      s.buffer = bufs.current[k];
      s.connect(k === 'a' ? ga : gb);
      if (at < s.buffer!.duration) s.start(when, at);
      return s;
    });
    nodes.current = { src, ga, gb, started: when, offset: at };
    setState('playing');
    const tick = () => {
      const t = nodes.current.offset + Math.max(0, c.currentTime - nodes.current.started);
      setTime(t);
      if (t >= duration) {
        stop();
        nodes.current.offset = 0;
        setState('ready');
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [gains, side, stop, duration]);

  // Load and decode both versions (decrypted in memory).
  useEffect(() => {
    if (!open || !va || !vb) return;
    let alive = true;
    player.status === 'playing' && player.toggle();
    setState('loading');
    ctx.current ??= new AudioContext();
    const decode = async (v: TrackVersion) => ctx.current!.decodeAudioData(await (await fetch(await audioUrl(project, v))).arrayBuffer());
    Promise.all([decode(va), decode(vb)])
      .then(([a, b]) => {
        if (!alive) return;
        bufs.current = { a, b };
        nodes.current.offset = 0;
        setTime(0);
        setState('ready');
      })
      .catch(() => alive && setState('error'));
    void decodeWave(va.meta).then((w) => alive && setWave(w));
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, aId, bId]);

  // Switching sides or matching only changes gains: no gap, same position.
  useEffect(() => {
    const n = nodes.current;
    const c = ctx.current;
    if (!c || !n.ga || !n.gb) return;
    const g = gains();
    n.ga.gain.setTargetAtTime(side === 'a' ? g.a : 0, c.currentTime, 0.004);
    n.gb.gain.setTargetAtTime(side === 'b' ? g.b : 0, c.currentTime, 0.004);
  }, [side, gains]);

  useEffect(() => () => void ctx.current?.close(), []);

  const toggle = () => (state === 'playing' ? (stop(), setState('ready')) : start(nodes.current.offset >= duration ? 0 : nodes.current.offset));
  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'b') setSide(k);
    else if (k === ' ' && !(e.target instanceof HTMLButtonElement)) toggle();
    else if (k === 'tab' && e.shiftKey === false && e.target === e.currentTarget) return;
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const diff = va?.meta?.loudness != null && vb?.meta?.loudness != null ? vb.meta.loudness - va.meta.loudness : null;
  const label = (v: TrackVersion) => `Version ${v.number}${v.id === track.current?.id ? ' (current)' : ''}`;

  return (
    <Modal open={open} onClose={() => { stop(); onClose(); }} title={`Compare versions of ${track.title}`} wide>
      <div className="compare" onKeyDown={onKey}>
        {state === 'error' && <Notice kind="error">These versions could not be decoded for comparison in this browser.</Notice>}
        <div className="compare-pick">
          <label className="field">
            <span className="field-label">A</span>
            <select className="input" value={aId} onChange={(e) => setA(e.target.value)}>
              {versions.map((v) => <option key={v.id} value={v.id} disabled={v.id === bId}>{label(v)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">B</span>
            <select className="input" value={bId} onChange={(e) => setB(e.target.value)}>
              {versions.map((v) => <option key={v.id} value={v.id} disabled={v.id === aId}>{label(v)}</option>)}
            </select>
          </label>
        </div>
        <Waveform data={wave} current={time} duration={duration} onSeek={state === 'loading' ? undefined : (t) => (state === 'playing' ? start(t) : ((nodes.current.offset = t), setTime(t)))} className="waveform waveform-detail" label="Position" />
        <div className="compare-controls">
          <button type="button" className="play-btn" aria-label={state === 'playing' ? 'Pause' : 'Play both'} disabled={state === 'loading' || state === 'error'} onClick={toggle}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={state === 'playing' ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'} fill="currentColor" /></svg>
          </button>
          <div className="ab-switch" role="radiogroup" aria-label="Listen to">
            {(['a', 'b'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={side === k} className={`ab-side${side === k ? ' on' : ''}`} onClick={() => setSide(k)}>
                {k.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="mono row-sub">{formatTime(time)} / {formatTime(duration)}</span>
          <label className="check">
            <input type="checkbox" checked={match} onChange={(e) => setMatch(e.target.checked)} /> Match loudness
          </label>
        </div>
        <p className="row-sub">
          {state === 'loading' ? 'Decrypting both versions…' : 'Press A or B to switch instantly at the same moment.'}
          {diff !== null && ` B is ${Math.abs(diff).toFixed(1)} dB ${diff > 0 ? 'louder' : 'quieter'} than A${match ? '; levels matched' : ''}.`}
        </p>
      </div>
    </Modal>
  );
}
