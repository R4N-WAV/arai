import { describe, expect, it } from 'vitest';
import { aiffToWav, isAiff } from '../src/lib/aiff';

/** Builds a big-endian 16-bit stereo AIFF with the given samples. */
function aiff(samples: number[], rate = 44100): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const dv = new DataView(data.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, false));
  const comm = new Uint8Array(26);
  const c = new DataView(comm.buffer);
  comm.set([0x43, 0x4f, 0x4d, 0x4d]); c.setUint32(4, 18);
  c.setUint16(8, 2); c.setUint32(10, samples.length / 2); c.setUint16(14, 16);
  // 44100 as 80-bit extended: exponent 16383+15, mantissa 44100 << 48
  c.setUint16(16, 16383 + 15); c.setUint32(18, 44100 * 2 ** 16); c.setUint32(22, 0);
  void rate;
  const ssnd = new Uint8Array(16 + data.length);
  const sv = new DataView(ssnd.buffer);
  ssnd.set([0x53, 0x53, 0x4e, 0x44]); sv.setUint32(4, 8 + data.length); ssnd.set(data, 16);
  const body = new Uint8Array(4 + comm.length + ssnd.length);
  body.set([0x41, 0x49, 0x46, 0x46]); body.set(comm, 4); body.set(ssnd, 4 + comm.length);
  const out = new Uint8Array(8 + body.length);
  out.set([0x46, 0x4f, 0x52, 0x4d]); new DataView(out.buffer).setUint32(4, body.length); out.set(body, 8);
  return out;
}

describe('AIFF to WAV', () => {
  it('rewrites the header and flips sample byte order', () => {
    const src = aiff([1000, -1000, 32767, -32768]);
    expect(isAiff(src)).toBe(true);
    const wav = aiffToWav(src);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(44100);
    expect(dv.getUint16(34, true)).toBe(16);
    expect([0, 1, 2, 3].map((i) => dv.getInt16(44 + i * 2, true))).toEqual([1000, -1000, 32767, -32768]);
  });
  it('refuses things that are not AIFF', () => {
    expect(() => aiffToWav(new Uint8Array(64))).toThrow();
  });
});
