/**
 * Ambient light: turns project cover colours into glows that always blend
 * well together. Saturation is capped and lightness evened out, so clashing
 * artwork still mixes into a calm wash instead of a muddy or neon one.
 */
export interface Glow {
  /** CSS colour, e.g. "hsl(352 58% 46%)" */
  color: string;
  hue: number;
}

const HEX = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  let v = m[1]!;
  if (v.length === 3) v = v.replace(/./g, (c) => c + c);
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** One cover colour → one glow. Greys stay grey (no invented hue). */
export function toGlow(hex: string): Glow | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const s = Math.min(hsl.s, 62);
  const l = 40 + Math.min(Math.max(hsl.l, 20), 70) * 0.12; // 42–48%: same brightness band
  const h = Math.round(hsl.h);
  return { hue: h, color: `hsl(${h} ${Math.round(s)}% ${Math.round(l)}%)` };
}

/**
 * Many projects → at most `max` glows. Near-identical hues are merged so ten
 * red covers read as one strong red, not ten muddy blobs.
 */
export function ambientPalette(hexes: string[], max = 5): Glow[] {
  const glows: Glow[] = [];
  for (const hex of hexes) {
    const g = toGlow(hex);
    if (!g) continue;
    const near = glows.some((x) => Math.min(Math.abs(x.hue - g.hue), 360 - Math.abs(x.hue - g.hue)) < 18);
    if (!near) glows.push(g);
    if (glows.length >= max) break;
  }
  return glows;
}
