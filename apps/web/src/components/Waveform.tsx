import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { formatTime } from '../lib/audio';

/** Downsamples 0–255 peaks to `n` bars. With no peaks, a flat, honest line. */
function bars(peaks: Uint8Array | null, n: number): number[] {
  if (!peaks || peaks.length === 0) return Array.from({ length: n }, () => 0.12);
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * peaks.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j]!);
    return Math.max(0.06, m / 255);
  });
}

/**
 * Scrubbable waveform. Keyboard: ←/→ 5 s, PageUp/PageDown 30 s, Home/End.
 * Exposed to assistive tech as a slider with spoken time.
 */
export function Waveform({
  peaks,
  current,
  duration,
  onSeek,
  count = 120,
  label = 'Seek',
  className = 'waveform',
}: {
  peaks: Uint8Array | null;
  current: number;
  duration: number;
  onSeek?: (t: number) => void;
  count?: number;
  label?: string;
  className?: string;
}) {
  const data = useMemo(() => bars(peaks, count), [peaks, count]);
  const ref = useRef<HTMLDivElement>(null);
  const ratio = duration > 0 ? Math.min(1, current / duration) : 0;
  const seekable = !!onSeek && duration > 0;

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    if (!seekable || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    onSeek!(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!seekable) return;
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }[e.key];
    if (step !== undefined) onSeek!(Math.max(0, Math.min(duration, current + step)));
    else if (e.key === 'Home') onSeek!(0);
    else if (e.key === 'End') onSeek!(Math.max(0, duration - 0.5));
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className={className}
      role={seekable ? 'slider' : 'img'}
      tabIndex={seekable ? 0 : undefined}
      aria-label={label}
      aria-valuemin={seekable ? 0 : undefined}
      aria-valuemax={seekable ? Math.round(duration) : undefined}
      aria-valuenow={seekable ? Math.round(current) : undefined}
      aria-valuetext={seekable ? `${formatTime(current)} of ${formatTime(duration)}` : undefined}
      onPointerDown={(e) => {
        if (!seekable) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && fromPointer(e)}
      onKeyDown={onKey}
    >
      {data.map((h, i) => (
        <span key={i} className={i / data.length < ratio ? 'bar played' : 'bar'} style={{ height: `${Math.round(h * 100)}%` }} />
      ))}
    </div>
  );
}
