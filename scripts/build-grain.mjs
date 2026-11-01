// Writes a small tileable film-grain texture (apps/web/public/grain.png).
// A static tile is far cheaper to scroll over on phones than a live SVG noise filter.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 128;
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 4; // grey + alpha
const raw = Buffer.alloc((N * 2 + 1) * N);
let seed = 1337;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const o = y * (N * 2 + 1) + 1 + x * 2;
  raw[o] = rnd() > 0.5 ? 255 : 0;
  raw[o + 1] = Math.round(rnd() * 34); // faint
}
writeFileSync(new URL('../apps/web/public/grain.png', import.meta.url), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('grain.png written');
