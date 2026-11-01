/**
 * Client-side audio inspection. The server only ever sees ciphertext, so
 * format checks happen here, on the real bytes (never the file extension).
 */
export interface AudioFormat {
  format: 'wav' | 'aiff' | 'flac' | 'mp3' | 'm4a' | 'ogg';
  mime: string;
  label: string;
}

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));

export async function sniff(file: Blob): Promise<AudioFormat | null> {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (b.length < 12) return null;
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { format: 'wav', mime: 'audio/wav', label: 'WAV' };
  if (ascii(b, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(b, 8, 4))) return { format: 'aiff', mime: 'audio/aiff', label: 'AIFF' };
  if (ascii(b, 0, 4) === 'fLaC') return { format: 'flac', mime: 'audio/flac', label: 'FLAC' };
  if (ascii(b, 0, 4) === 'OggS') return { format: 'ogg', mime: 'audio/ogg', label: 'OGG' };
  if (ascii(b, 4, 4) === 'ftyp') return { format: 'm4a', mime: 'audio/mp4', label: 'M4A' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return { format: 'mp3', mime: 'audio/mpeg', label: 'MP3' };
  return null;
}

export interface Analysis {
  duration: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** 0–255 amplitude per bucket, for the waveform. */
  peaks: Uint8Array | null;
}

export const PEAK_BUCKETS = 480;
const MAX_DECODE_BYTES = 150 * 1024 * 1024;

/** Duration and waveform via Web Audio. Best-effort: some formats (AIFF in Chromium) cannot be decoded. */
export async function analyse(file: Blob): Promise<Analysis> {
  const empty: Analysis = { duration: null, sampleRate: null, channels: null, peaks: null };
  if (file.size > MAX_DECODE_BYTES) return empty;
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const peaks = new Uint8Array(PEAK_BUCKETS);
    const per = Math.max(1, Math.floor(buf.length / PEAK_BUCKETS));
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    let max = 0;
    const raw = new Float32Array(PEAK_BUCKETS);
    for (let i = 0; i < PEAK_BUCKETS; i++) {
      let peak = 0;
      const start = i * per;
      // Sample a stride inside each bucket: plenty for a picture, fast for long files.
      const step = Math.max(1, Math.floor(per / 256));
      for (let j = start; j < Math.min(start + per, buf.length); j += step) {
        for (const ch of chans) peak = Math.max(peak, Math.abs(ch[j]!));
      }
      raw[i] = peak;
      max = Math.max(max, peak);
    }
    for (let i = 0; i < PEAK_BUCKETS; i++) peaks[i] = max ? Math.round((raw[i]! / max) * 255) : 0;
    return { duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, peaks };
  } catch {
    return empty;
  }
}

export function formatTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '–:––';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
