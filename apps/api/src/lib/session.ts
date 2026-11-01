import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppBindings } from '../env.js';
import { ipHmac, requireSecret, sha256, toB64 } from './crypto.js';
import { randomId } from './ids.js';

export const SESSION_COOKIE = 'arai_s'; // sent as __Host-arai_s
export const IDLE_MS = 7 * 24 * 3600 * 1000;
export const ABSOLUTE_MS = 30 * 24 * 3600 * 1000;
const TOUCH_MS = 5 * 60 * 1000;

export function clientIp(c: Context<AppBindings>): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

export function uaSummary(c: Context<AppBindings>): string {
  const ua = c.req.header('User-Agent') ?? '';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return `${browser} on ${os}`;
}

export async function createSession(c: Context<AppBindings>, userId: string): Promise<string> {
  const token = new Uint8Array(32);
  crypto.getRandomValues(token);
  const now = Date.now();
  const id = randomId();
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, ip_hmac, ua_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, await sha256(token), now, now, now + ABSOLUTE_MS, await ipHmac(requireSecret(c.env.IP_HMAC_SECRET, 'IP_HMAC_SECRET'), clientIp(c)), uaSummary(c))
    .run();
  setCookie(c, SESSION_COOKIE, toB64(token), {
    prefix: 'host', // __Host-: Secure, Path=/, no Domain
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: ABSOLUTE_MS / 1000,
  });
  return id;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
}

interface SessionRow {
  session_id: string;
  user_id: string;
  last_seen_at: number;
  username: string;
  email_normalized: string;
  email_verified_at: number | null;
  status: string;
}

/** Resolve the current session (or null). Expired/revoked sessions never resolve. */
export async function loadSession(c: Context<AppBindings>): Promise<SessionRow | null> {
  const raw = getCookie(c, SESSION_COOKIE, 'host');
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const now = Date.now();
  const tokenBytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.last_seen_at, u.username, u.email_normalized, u.email_verified_at, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at > ?
        AND u.status IN ('active', 'restricted')`,
  )
    .bind(await sha256(tokenBytes), now, now - IDLE_MS)
    .first<SessionRow>();
  if (!row) return null;
  if (now - row.last_seen_at > TOUCH_MS) {
    await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.session_id).run();
  }
  return row;
}

export type AuthedBindings = AppBindings & { Variables: AppBindings['Variables'] & { session: SessionRow } };

export const requireUser: MiddlewareHandler<AuthedBindings> = async (c, next) => {
  const s = await loadSession(c as unknown as Context<AppBindings>);
  if (!s) return c.json({ error: 'unauthenticated' }, 401);
  c.set('session', s);
  await next();
};
