import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { encodeCanvas } from '../lib/images';

/**
 * Scale-and-crop for any picture (profile picture, header, cover art…).
 * Drag to move, slider / wheel / pinch to zoom; keyboard: arrows move, +/− zoom.
 * The visible frame is rendered at the target size and re-encoded (metadata stripped).
 */
export function ImageCropper({
  file,
  aspect,
  output,
  maxBytes,
  round = false,
  onCancel,
  onDone,
}: {
  file: File;
  aspect: number; // width / height
  output: { w: number; h: number };
  maxBytes: number;
  round?: boolean;
  onCancel: () => void;
  onDone: (blob: Blob) => void;
}) {
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [url, setUrl] = useState<string>('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // offset of image centre from frame centre, in frame px
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [fw, setFw] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number } | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    createImageBitmap(file).then(setImg, () => setError('That file is not an image this browser can read.'));
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFw(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fh = fw / aspect;
  // Base scale makes the image just cover the frame; zoom multiplies it.
  const base = img ? Math.max(fw / img.width, fh / img.height) : 1;
  const scale = base * zoom;
  const dispW = img ? img.width * scale : 0;
  const dispH = img ? img.height * scale : 0;
  const clamp = (p: { x: number; y: number }, s = scale) => {
    if (!img) return p;
    const mx = Math.max(0, (img.width * s - fw) / 2);
    const my = Math.max(0, (img.height * s - fh) / 2);
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  };
  const setZoomClamped = (z: number) => {
    const nz = Math.max(1, Math.min(6, z));
    setZoom(nz);
    setPan((p) => clamp(p, base * nz));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), z: zoom };
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      setZoomClamped(pinch.current.z * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.current.d));
    } else if (pointers.current.size === 1) {
      setPan((p) => clamp({ x: p.x + e.clientX - prev.x, y: p.y + e.clientY - prev.y }));
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => setZoomClamped(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) setPan((p) => clamp({ x: p.x + moves[e.key]![0], y: p.y + moves[e.key]![1] }));
    else if (e.key === '+' || e.key === '=') setZoomClamped(zoom * 1.1);
    else if (e.key === '-') setZoomClamped(zoom / 1.1);
    else return;
    e.preventDefault();
  };

  async function done() {
    if (!img || !fw) return;
    setBusy(true);
    try {
      // Frame → source rectangle.
      const sw = fw / scale;
      const sh = fh / scale;
      const sx = img.width / 2 - pan.x / scale - sw / 2;
      const sy = img.height / 2 - pan.y / scale - sh / 2;
      const outW = Math.min(output.w, Math.round(sw));
      const outH = Math.round(outW / aspect);
      const c = document.createElement('canvas');
      c.width = Math.max(1, outW);
      c.height = Math.max(1, outH);
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      onDone(await encodeCanvas(c, maxBytes));
    } catch (e) {
      setError((e as Error).message === 'image_too_large' ? 'That image is too large even after compressing.' : 'The picture could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cropper">
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      <div
        ref={frame}
        className={`crop-frame${round ? ' round' : ''}`}
        style={{ aspectRatio: String(aspect) }}
        tabIndex={0}
        role="application"
        aria-label="Picture position. Drag or use the arrow keys to move, plus and minus to zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKey}
      >
        {url && img && (
          <img
            src={url}
            alt=""
            draggable={false}
            style={{ width: dispW, height: dispH, transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}
          />
        )}
      </div>
      <label className="zoom">
        <span>Zoom</span>
        <input type="range" min={1} max={6} step={0.01} value={zoom} onChange={(e) => setZoomClamped(Number(e.target.value))} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={!img || busy} onClick={() => void done()}>{busy ? 'Preparing…' : 'Use picture'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
