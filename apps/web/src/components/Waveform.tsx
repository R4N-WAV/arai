import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatTime } from '../lib/audio';
import type { WaveData } from '../lib/tracks';

/**
 * Canvas waveform: mirrored peaks (soft) with an RMS core (solid), resampled
 * to the element's real pixel width, so it stays detailed at any size.
 * Seekable variant is a keyboard slider: ←/→ 5 s, PageUp/PageDown 30 s, Home/End.
 */
export function Waveform({
  data,
  current,
  duration,
  onSeek,
  label = 'Seek',
  className = 'waveform',
  color = '#f2efea',
}: {
  data: WaveData | null;
  current: number;
  duration: number;
  onSeek?: (t: number) => void;
  label?: string;
  className?: string;
  color?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const ratio = duration > 0 ? Math.min(1, current / duration) : 0;
  const seekable = !!onSeek && duration > 0;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e!.contentRect.width), h: Math.round(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const mid = size.h / 2;
    const cols = Math.max(1, Math.floor(size.w / 2)); // one column per 2 CSS px
    const sample = (arr: Uint8Array, x: number) => {
      const a = Math.floor((x / cols) * arr.length);
      const b = Math.max(a + 1, Math.floor(((x + 1) / cols) * arr.length));
      let m = 0;
      for (let i = a; i < b && i < arr.length; i++) if (arr[i]! > m) m = arr[i]!;
      return m / 255;
    };
    const playedX = ratio * size.w;
    for (let x = 0; x < cols; x++) {
      const px = x * 2;
      const peak = data ? Math.max(0.02, sample(data.peaks, x)) : 0.04;
      const body = data?.rms ? Math.max(0.015, sample(data.rms, x) * 1.35) : peak * 0.6;
      const played = px < playedX;
      ctx.fillStyle = played ? color : 'rgba(255,255,255,0.18)';
      ctx.globalAlpha = played ? 0.38 : 1;
      const ph = peak * (mid - 1);
      ctx.fillRect(px, mid - ph, 1.4, ph * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = played ? color : 'rgba(255,255,255,0.42)';
      const bh = Math.min(ph, body * (mid - 1));
      ctx.fillRect(px, mid - bh, 1.4, bh * 2);
    }
    if (hover !== null && seekable) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(Math.round(hover * size.w), 0, 1, size.h);
    }
  }, [data, size, ratio, hover, seekable, color]);

  const pos = (e: PointerEvent<HTMLDivElement>) => {
    const r = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!seekable) return;
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }[e.key];
    if (step !== undefined) onSeek!(Math.max(0, Math.min(duration, current + step)));
    else if (e.key === 'Home') onSeek!(0);
    else if (e.key === 'End') onSeek!(Math.max(0, duration - 0.5));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={wrap}
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
        onSeek!(pos(e) * duration);
      }}
      onPointerMove={(e) => {
        if (!seekable) return;
        setHover(pos(e));
        if (e.buttons === 1) onSeek!(pos(e) * duration);
      }}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
    >
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}
