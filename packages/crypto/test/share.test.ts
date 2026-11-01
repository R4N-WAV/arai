import { describe, expect, it } from 'vitest';
import { deriveShareKeys, newShareSecret, open, seal, shareTokenHash } from '../src/index.js';

const hex = (a: Uint8Array) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');

describe('share links', () => {
  it('derives distinct token and key, stable for the same inputs', async () => {
    const s = await newShareSecret();
    const a = await deriveShareKeys(s);
    const b = await deriveShareKeys(s);
    expect(hex(a.token)).toBe(hex(b.token));
    expect(hex(a.token)).not.toBe(hex(a.key));
    expect((await shareTokenHash(a.token)).length).toBe(32);
  });

  it('a password changes both token and key', async () => {
    const s = await newShareSecret();
    const a = await deriveShareKeys(s);
    const b = await deriveShareKeys(s, 'hunter2');
    expect(hex(a.token)).not.toBe(hex(b.token));
    const blob = await seal(b.key, new Uint8Array([1, 2, 3]), 'share/x/payload');
    await expect(open(a.key, blob, 'share/x/payload')).rejects.toThrow();
    expect(Array.from(await open((await deriveShareKeys(s, 'hunter2')).key, blob, 'share/x/payload'))).toEqual([1, 2, 3]);
  });

  it('rejects malformed secrets', async () => {
    await expect(deriveShareKeys('abc')).rejects.toThrow();
  });
});
