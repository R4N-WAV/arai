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
  /** 0–255 peak amplitude per bucket. */
  peaks: Uint8Array | null;
  /** 0–255 RMS ("body") per bucket, drawn as the solid core of the waveform. */
  rms: Uint8Array | null;
  /** Integrated loudness, ITU-R BS.1770 (LUFS). */
  loudness: number | null;
  /** Highest sample peak in dBFS. */
  peakDb: number | null;
  bitDepth: number | null;
}

export const PEAK_BUCKETS = 1600;
const MAX_DECODE_BYTES = 150 * 1024 * 1024;

/** Bit depth from the container header (WAV, AIFF, FLAC); null for lossy formats. */
export async function readBitDepth(file: Blob, format: AudioFormat['format']): Promise<number | null> {
  const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const dv = new DataView(b.buffer);
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  try {
    if (format === 'wav') {
      for (let o = 12; o + 8 < b.length; ) {
        const size = dv.getUint32(o + 4, true);
        if (tag(o) === 'fmt ') return dv.getUint16(o + 22, true);
        o += 8 + size + (size & 1);
      }
    } else if (format === 'aiff') {
      for (let o = 12; o + 8 < b.length; ) {
        const size = dv.getUint32(o + 4);
        if (tag(o) === 'COMM') return dv.getUint16(o + 14);
        o += 8 + size + (size & 1);
      }
    } else if (format === 'flac' && tag(0) === 'fLaC') {
      // STREAMINFO: bits-per-sample is 5 bits spanning bytes 20–21 of the block (+1).
      return (((b[8 + 12]! & 0x01) << 4) | (b[8 + 13]! >> 4)) + 1;
    }
  } catch {
    return null;
  }
  return null;
}

/** BS.1770 K-weighting biquad pair for a sample rate (coefficients as in libebur128). */
function kWeighting(fs: number) {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let Q = 0.7071752369554196;
  let a0 = 1 + K / Q + K * K;
  const pre = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const rlb = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [pre, rlb];
}

export function integratedLoudness(channels: Float32Array[], fs: number): number | null {
  const n = channels[0]?.length ?? 0;
  const block = Math.round(fs * 0.4);
  const step = Math.round(fs * 0.1);
  if (n < block) return null;
  const filters = kWeighting(fs);
  const blocks = Math.floor((n - block) / step) + 1;
  const power = new Float64Array(blocks);
  for (const ch of channels.slice(0, 2)) {
    // Filtered squared signal, then sliding 400 ms means (75 % overlap).
    const sq = new Float64Array(n);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
    const [f, g] = filters as [typeof filters[0], typeof filters[0]];
    for (let i = 0; i < n; i++) {
      const x = ch[i]!;
      const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = g.b0 * y + g.b1 * z1 + g.b2 * z2 - g.a1 * w1 - g.a2 * w2;
      z2 = z1; z1 = y; w2 = w1; w1 = z;
      sq[i] = z * z;
    }
    let acc = 0;
    for (let i = 0; i < block; i++) acc += sq[i]!;
    for (let k = 0; k < blocks; k++) {
      power[k]! += acc / block;
      if (k < blocks - 1) for (let i = 0; i < step; i++) acc += sq[k * step + block + i]! - sq[k * step + i]!;
    }
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const abs = [...power].filter((p) => p > 0 && lufs(p) > -70);
  if (!abs.length) return null;
  const relGate = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((p) => lufs(p) > relGate);
  return rel.length ? Math.round(lufs(rel.reduce((a, b) => a + b, 0) / rel.length) * 10) / 10 : null;
}

/** Duration, waveform and loudness via Web Audio. Best-effort: some formats (AIFF in Chromium) cannot be decoded. */
export async function analyse(file: Blob, format?: AudioFormat['format']): Promise<Analysis> {
  const bitDepth = format ? await readBitDepth(file, format) : null;
  const empty: Analysis = { duration: null, sampleRate: null, channels: null, peaks: null, rms: null, loudness: null, peakDb: null, bitDepth };
  if (file.size > MAX_DECODE_BYTES) return empty;
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const per = buf.length / PEAK_BUCKETS;
    const rawPeak = new Float32Array(PEAK_BUCKETS);
    const rawRms = new Float32Array(PEAK_BUCKETS);
    let maxPeak = 0;
    for (let i = 0; i < PEAK_BUCKETS; i++) {
      const start = Math.floor(i * per);
      const end = Math.min(buf.length, Math.floor((i + 1) * per));
      let peak = 0, sum = 0, count = 0;
      const stride = Math.max(1, Math.floor((end - start) / 512));
      for (let j = start; j < end; j += stride) {
        for (const ch of chans) {
          const v = ch[j]!;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          sum += v * v;
          count++;
        }
      }
      rawPeak[i] = peak;
      rawRms[i] = count ? Math.sqrt(sum / count) : 0;
      if (peak > maxPeak) maxPeak = peak;
    }
    const norm = maxPeak || 1;
    const peaks = Uint8Array.from(rawPeak, (v) => Math.round((v / norm) * 255));
    const rms = Uint8Array.from(rawRms, (v) => Math.min(255, Math.round((v / norm) * 255)));
    let truePeak = 0;
    for (const ch of chans) for (let j = 0; j < ch.length; j++) { const a = Math.abs(ch[j]!); if (a > truePeak) truePeak = a; }
    return {
      duration: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      peaks,
      rms,
      loudness: integratedLoudness(chans, buf.sampleRate),
      peakDb: truePeak > 0 ? Math.round(20 * Math.log10(truePeak) * 10) / 10 : null,
      bitDepth,
    };
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
