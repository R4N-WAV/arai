import { describe, expect, it } from 'vitest';
import { ambientPalette, hexToHsl, toGlow } from '../src/ambient';

const parts = (c: string) => c.match(/[\d.]+/g)!.map(Number);

describe('ambient palette', () => {
  it('parses hex colours', () => {
    expect(hexToHsl('#ff0000')).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl('#0f0')!.h).toBe(120);
    expect(hexToHsl('nope')).toBeNull();
  });

  it('caps saturation and evens out lightness', () => {
    for (const hex of ['#ff0000', '#00ff88', '#2200ff', '#fff8dc', '#101010']) {
      const [, s, l] = parts(toGlow(hex)!.color);
      expect(s).toBeLessThanOrEqual(62);
      expect(l).toBeGreaterThanOrEqual(42);
      expect(l).toBeLessThanOrEqual(49);
    }
  });

  it('keeps greys grey', () => {
    expect(parts(toGlow('#808080')!.color)[1]).toBe(0);
  });

  it('merges near-identical hues and limits the count', () => {
    expect(ambientPalette(['#e63946', '#e5383b', '#d62839'])).toHaveLength(1);
    expect(ambientPalette(['#e63946', '#2a9d8f', '#5e2bff', '#f4d35e', '#3a86ff', '#8ac926', '#ff8fab'], 5)).toHaveLength(5);
    expect(ambientPalette([])).toEqual([]);
    expect(ambientPalette(['bad', 'fff', '#2a9d8f'])).toHaveLength(1);
  });
});
