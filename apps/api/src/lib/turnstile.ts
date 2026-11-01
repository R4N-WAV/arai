import type { Env } from '../env.js';

/**
 * Cloudflare Turnstile verification. If TURNSTILE_SECRET is unset the check
 * is skipped (local development only); `wrangler.jsonc` production vars must
 * set REQUIRE_TURNSTILE="true", which makes a missing secret fail closed.
 */
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return env.REQUIRE_TURNSTILE !== 'true';
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (ip !== 'unknown') body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}
