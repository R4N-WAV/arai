/**
 * AIFF/AIFC (uncompressed) → WAV, in the browser, so AIFF uploads play and
 * analyse in every browser (Chromium and Firefox cannot decode AIFF). The
 * original file stays untouched; this is only for playback.
 */
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** 80-bit IEEE 754 extended float (big-endian), as used for AIFF sample rates. */
function extended(b: Uint8Array, o: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + o, 10);
  const exp = dv.getUint16(0) & 0x7fff;
  const hi = dv.getUint32(2);
  const lo = dv.getUint32(6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

export function isAiff(b: Uint8Array): boolean {
  return b.length > 12 && ascii(b, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(b, 8, 4));
}

export function aiffToWav(b: Uint8Array): Uint8Array {
  if (!isAiff(b)) throw new Error('not_aiff');
  const aifc = ascii(b, 8, 4) === 'AIFC';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let channels = 0, bits = 0, rate = 0, little = false, data: Uint8Array | null = null;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = ascii(b, o, 4);
    const size = dv.getUint32(o + 4);
    const body = o + 8;
    if (id === 'COMM') {
      channels = dv.getUint16(body);
      bits = dv.getUint16(body + 6);
      rate = extended(b, body + 8);
      if (aifc) {
        const comp = ascii(b, body + 18, 4);
        if (comp === 'sowt') little = true;
        else if (comp !== 'NONE') throw new Error('compressed_aifc');
      }
    } else if (id === 'SSND') {
      const offset = dv.getUint32(body);
      data = b.subarray(body + 8 + offset, Math.min(b.length, body + size));
    }
    o = body + size + (size & 1);
  }
  if (!data || !channels || !rate || ![8, 16, 24, 32].includes(bits)) throw new Error('unsupported_aiff');
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const len = frames * bytes * channels;
  const out = new Uint8Array(44 + len);
  const w = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  w.setUint32(4, 36 + len, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  w.setUint32(16, 16, true);
  w.setUint16(20, 1, true);
  w.setUint16(22, channels, true);
  w.setUint32(24, Math.round(rate), true);
  w.setUint32(28, Math.round(rate) * channels * bytes, true);
  w.setUint16(32, channels * bytes, true);
  w.setUint16(34, bits, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  w.setUint32(40, len, true);
  if (little) {
    out.set(data.subarray(0, len), 44);
  } else if (bytes === 1) {
    // AIFF 8-bit is signed, WAV 8-bit unsigned.
    for (let i = 0; i < len; i++) out[44 + i] = (data[i]! + 128) & 0xff;
  } else {
    for (let i = 0; i < len; i += bytes) for (let k = 0; k < bytes; k++) out[44 + i + k] = data[i + bytes - 1 - k]!;
  }
  return out;
}

export const browserPlaysAiff = () => typeof Audio !== 'undefined' && new Audio().canPlayType('audio/aiff') !== '';
