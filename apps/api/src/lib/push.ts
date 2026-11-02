/**
 * Web Push with VAPID (RFC 8292) and no payload (no RFC 8291 encryption
 * needed): the service worker fetches /api/push/summary to show text.
 */
import type { Env } from '../env.js';
import { toB64 } from './crypto.js';

/** Only real push services, never arbitrary URLs (prevents SSRF via subscriptions). */
const ALLOWED = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && ALLOWED.some((r) => r.test(u.hostname)) && endpoint.length <= 1000;
  } catch {
    return false;
  }
}

interface Vapid {
  key: CryptoKey;
  publicKey: string; // base64url uncompressed P-256 point
}
let cached: Vapid | null = null;

export async function vapid(env: Env): Promise<Vapid | null> {
  if (!env.VAPID_PRIVATE_JWK) return null;
  if (cached) return cached;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey & { x: string; y: string };
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: false }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const raw = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(raw(jwk.x), 1);
  point.set(raw(jwk.y), 33);
  cached = { key, publicKey: toB64(point) };
  return cached;
}

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function jwt(v: Vapid, audience: string, subject: string): Promise<string> {
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${toB64(sig)}`;
}

/** Wakes every device of these users. Gone subscriptions are removed. */
export async function pushTo(env: Env, userIds: string[], origin: string): Promise<void> {
  const v = await vapid(env);
  if (!v || userIds.length === 0) return;
  for (const userId of [...new Set(userIds)].slice(0, 50)) {
    const { results } = await env.DB.prepare('SELECT id, endpoint FROM push_subscriptions WHERE user_id = ? LIMIT 10').bind(userId).all<{ id: string; endpoint: string }>();
    for (const s of results) {
      if (!validEndpoint(s.endpoint)) continue;
      try {
        const res = await fetch(s.endpoint, {
          method: 'POST',
          headers: { Authorization: `vapid t=${await jwt(v, new URL(s.endpoint).origin, origin)}, k=${v.publicKey}`, TTL: '86400', Urgency: 'normal', 'Content-Length': '0' },
        });
        if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(s.id).run();
        else if (!res.ok) await env.DB.prepare('UPDATE push_subscriptions SET failed_at = ? WHERE id = ?').bind(Date.now(), s.id).run();
      } catch {
        /* push service unreachable: try again next time */
      }
    }
  }
}
