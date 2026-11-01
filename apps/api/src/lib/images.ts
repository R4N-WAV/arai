/**
 * Minimal, allocation-free image header checks for public profile images.
 * Confirms the real format from magic bytes and reads pixel dimensions, so a
 * tiny file cannot expand into a huge bitmap in viewers' browsers.
 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export function inspectImage(b: Uint8Array): { mime: ImageMime; width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: signature + IHDR
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && String.fromCharCode(...b.subarray(12, 16)) === 'IHDR') {
    return { mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (b.length > 30 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { mime: 'image/webp', width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = dv.getUint32(21, true);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { mime: 'image/webp', width: w, height: h };
    }
    return null;
  }
  // JPEG: scan markers for a Start-Of-Frame segment
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
