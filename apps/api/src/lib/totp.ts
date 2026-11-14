/** TOTP (RFC 6238): HMAC-SHA1, 30 s steps, 6 digits; secrets sealed at rest. */
import type { Env } from '../env.js';
import { hmac, requireSecret } from './crypto.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export async function totpAt(secret: Uint8Array, step: number): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step);
  new DataView(msg.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19]! & 0xf;
  const code = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Returns the matched step (±1 step of clock drift), or null. */
export async function verifyTotp(secret: Uint8Array, code: string, now = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) if ((await totpAt(secret, s)) === code) return s;
  return null;
}

async function sealKey(env: Env): Promise<CryptoKey> {
  const raw = await hmac(requireSecret(env.AUTH_PEPPER, 'AUTH_PEPPER'), 'arai/totp-seal/v1');
  return crypto.subtle.importKey('raw', raw.slice(0, 32) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealSecret(env: Env, userId: string, secret: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId) }, await sealKey(env), secret as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}
export async function openSecret(env: Env, userId: string, blob: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const b = new Uint8Array(blob);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: new TextEncoder().encode(userId) }, await sealKey(env), b.slice(12)));
}

/** Recovery codes: 10 groups of xxxx-xxxx from an unambiguous alphabet. */
export function newRecoveryCodes(): string[] {
  const alpha = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => {
    const b = crypto.getRandomValues(new Uint8Array(8));
    const s = Array.from(b, (x) => alpha[x % alpha.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export const normaliseCode = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');
