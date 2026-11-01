/** Server-side keyed hashing helpers (Web Crypto, constant-time compare). */
const enc = new TextEncoder();

export function requireSecret(value: string | undefined, name: string): string {
  // Fail closed: never run auth with a missing or placeholder secret.
  if (!value || value.length < 8) throw new Error(`missing secret ${name}`);
  return value;
}

export async function hmac(secret: string, data: Uint8Array | string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toB64(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Privacy-preserving IP identifier: keyed, rotates daily, never stores raw IPs. */
export async function ipHmac(secret: string, ip: string, now = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  return toB64((await hmac(secret, `${day}|${ip}`)).subarray(0, 12));
}
