import { formatTime } from '../lib/audio';
import { usePlayer } from '../lib/player';
import { Cover } from './Cover';
import { Waveform } from './Waveform';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function PlayerBar() {
  const p = usePlayer();
  if (!p.item) return null;
  const { item } = p;
  const color = item.project.meta?.color ?? '#8a8f98';
  return (
    <section className="player" aria-label="Player">
      <div className="player-track">
        <Cover name="" color={color} size="thumb" />
        <div className="player-titles">
          <span className="player-title">{item.track.title}</span>
          <span className="player-sub">
            {item.project.meta?.name ?? 'Project'} · v{item.version.number}
            {p.status === 'loading' && ` · decrypting ${Math.round(p.loadProgress * 100)}%`}
            {p.status === 'error' && ' · could not play this file'}
          </span>
        </div>
      </div>
      <div className="player-controls">
        <button type="button" className="icon-btn" aria-label="Previous" onClick={p.prev}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h2v14H7zM20 5v14L10 12z" fill="currentColor" /></svg>
        </button>
        <button type="button" className="play-btn" aria-label={p.status === 'playing' ? 'Pause' : 'Play'} onClick={p.toggle} disabled={p.status === 'loading'}>
          {p.status === 'playing' ? (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
          )}
        </button>
        <button type="button" className="icon-btn" aria-label="Next" onClick={p.next} disabled={p.index >= p.queue.length - 1}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5h2v14h-2zM4 5v14l10-7z" fill="currentColor" /></svg>
        </button>
      </div>
      <div className="player-scrub">
        <span className="mono player-time">{formatTime(p.time)}</span>
        <Waveform peaks={p.peaks} current={p.time} duration={p.duration} onSeek={p.seek} label={`Seek in ${item.track.title}`} />
        <span className="mono player-time">{formatTime(p.duration)}</span>
      </div>
      <div className="player-extras">
        <button type="button" className="icon-btn" aria-label="Repeat this track" aria-pressed={p.loop} onClick={() => p.setLoop(!p.loop)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4" /></svg>
        </button>
        <label className="rate">
          <span className="visually-hidden">Playback speed</span>
          <select value={p.rate} onChange={(e) => p.setRate(Number(e.target.value))}>
            {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
        <label className="volume">
          <span className="visually-hidden">Volume</span>
          <input type="range" min={0} max={1} step={0.01} value={p.volume} onChange={(e) => p.setVolume(Number(e.target.value))} />
        </label>
      </div>
    </section>
  );
}
