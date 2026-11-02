import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/api';
import { formatTime } from '../lib/audio';
import { usePlayer } from '../lib/player';
import type { Project } from '../lib/projects';
import { decodeWave, setTrim, type Track, type TrackVersion, type WaveData } from '../lib/tracks';
import { Modal } from './Modal';
import { Notice } from './Unavailable';
import { Waveform } from './Waveform';

/** Non-destructive trim: start and end points are stored (encrypted) with the track; the file is untouched. */
export function TrimDialog({ project, track, version, open, onClose, onSaved }: { project: Project; track: Track; version: TrackVersion; open: boolean; onClose: () => void; onSaved: (t: Track) => void }) {
  const player = usePlayer();
  const total = version.meta?.duration ?? 0;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(total);
  const [wave, setWave] = useState<WaveData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = track.trims[version.id];
    setStart(t?.start ?? 0);
    setEnd(t?.end ?? total);
    setError(null);
    void decodeWave(version.meta).then(setWave);
  }, [open, track, version, total]);
  const step = total > 600 ? 1 : 0.1;
  const save = async (clear = false) => {
    setBusy(true);
    try {
      onSaved(await setTrim(project, track, version.id, clear ? null : { start: Math.max(0, start), end: end < total - 0.05 ? end : null }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Trim version ${version.number}`}>
      {error && <Notice kind="error">{error}</Notice>}
      <p className="row-sub">Playback starts and stops at these points for everyone. The uploaded file stays exactly as it is.</p>
      <div className="trim-wave">
        <Waveform data={wave} current={0} duration={total} className="waveform waveform-detail" label={`Waveform of ${track.title}`} />
        <span className="trim-shade" style={{ left: 0, width: `${(start / (total || 1)) * 100}%` }} aria-hidden="true" />
        <span className="trim-shade" style={{ right: 0, width: `${(1 - end / (total || 1)) * 100}%` }} aria-hidden="true" />
      </div>
      <label className="field">
        <span className="field-label">Start: <span className="mono">{formatTime(start)}</span></span>
        <input type="range" min={0} max={total} step={step} value={start} onChange={(e) => setStart(Math.min(Number(e.target.value), end - 0.5))} />
      </label>
      <label className="field">
        <span className="field-label">End: <span className="mono">{formatTime(end)}</span></span>
        <input type="range" min={0} max={total} step={step} value={end} onChange={(e) => setEnd(Math.max(Number(e.target.value), start + 0.5))} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>Save trim</button>
        <button type="button" className="btn btn-sm" onClick={() => player.playQueue([{ project, track: { ...track, trims: { ...track.trims, [version.id]: { start, end: end < total ? end : null } } }, version }], 0)}>Preview</button>
        {track.trims[version.id] && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save(true)}>Remove trim</button>}
      </div>
    </Modal>
  );
}
