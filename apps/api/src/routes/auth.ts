import { CURRENT_KDF, loginRequest, preloginRequest, recoverChallengeRequest, recoverRequest, registerRequest, type Capabilities } from '@arai/shared';
import { reindexProfile } from './social.js';
import { Hono, type Context } from 'hono';
import type { AppBindings, Env } from '../env.js';
import { appendAudit } from '../lib/audit.js';
import { fromB64, hmac, ipHmac, requireSecret, timingSafeEqual, toB64 } from '../lib/crypto.js';
import { randomId } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clearSessionCookie, clientIp, createSession, loadSession, requireUser, uaSummary, type AuthedBindings } from '../lib/session.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { parseBody } from '../lib/validate.js';

const MIN = 60_000;
const auth = new Hono<AppBindings>();

const bad = (c: Context) => c.json({ error: 'invalid_request' }, 400);
const tooMany = (c: Context) => c.json({ error: 'too_many_attempts' }, 429);

export function capabilities(env: Env): Capabilities {
  return {
    emailDelivery: env.FEATURE_EMAIL === 'on',
    sms: env.FEATURE_SMS === 'on',
    gifs: env.FEATURE_GIFS === 'on' && !!env.GIF_API_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
  };
}

async function authHash(env: Env, key: string): Promise<Uint8Array> {
  return hmac(requireSecret(env.AUTH_PEPPER, 'AUTH_PEPPER'), fromB64(key));
}

async function ipKey(c: Context<AppBindings>): Promise<string> {
  return ipHmac(requireSecret(c.env.IP_HMAC_SECRET, 'IP_HMAC_SECRET'), clientIp(c));
}

function isEmail(identifier: string): boolean {
  return identifier.includes('@');
}

interface CredRow {
  id: string;
  username: string;
  email_normalized: string;
  email_verified_at: number | null;
  status: string;
  salt_username: ArrayBuffer;
  salt_email: ArrayBuffer;
  kdf_params: string;
  auth_hash_u: ArrayBuffer;
  auth_hash_e: ArrayBuffer;
  recovery_auth_hash: ArrayBuffer | null;
  enc_ask_username: ArrayBuffer;
  enc_ask_email: ArrayBuffer;
  enc_private_keys: ArrayBuffer;
}

const CRED_SELECT = `SELECT u.id, u.username, u.email_normalized, u.email_verified_at, u.status,
  c.salt_username, c.salt_email, c.kdf_params, c.auth_hash_u, c.auth_hash_e, c.recovery_auth_hash,
  v.enc_ask_username, v.enc_ask_email, v.enc_private_keys
  FROM users u JOIN credentials c ON c.user_id = u.id JOIN vaults v ON v.user_id = u.id`;

/** Email sign-in only works for verified emails (unverified ones are unclaimed). */
async function findByIdentifier(db: D1Database, identifier: string): Promise<CredRow | null> {
  return isEmail(identifier)
    ? db.prepare(`${CRED_SELECT} WHERE u.email_normalized = ? AND u.email_verified_at IS NOT NULL AND u.status != 'deleted'`).bind(identifier.toLowerCase()).first<CredRow>()
    : db.prepare(`${CRED_SELECT} WHERE u.username = ? AND u.status != 'deleted'`).bind(identifier).first<CredRow>();
}

export function userJson(u: { id?: string; user_id?: string; username: string; email_normalized: string; email_verified_at: number | null; status: string }) {
  return { id: (u.id ?? u.user_id)!, username: u.username, email: u.email_normalized, emailVerified: u.email_verified_at !== null, status: u.status };
}

auth.get('/config', (c) => c.json(capabilities(c.env)));

auth.post('/auth/username-available', async (c) => {
  const body = await parseBody(c, registerRequest.pick({ username: true }));
  if (!body) return bad(c);
  if (!(await rateLimit(c.env.DB, `uname:${await ipKey(c)}`, 30, MIN))) return tooMany(c);
  const row = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(body.username).first();
  return c.json({ available: !row });
});

auth.post('/auth/prelogin', async (c) => {
  const body = await parseBody(c, preloginRequest);
  if (!body) return bad(c);
  if (!(await rateLimit(c.env.DB, `prelogin:${await ipKey(c)}`, 60, MIN))) return tooMany(c);
  const id = body.identifier;
  const row = await findByIdentifier(c.env.DB, id);
  if (row) {
    const salt = isEmail(id) ? row.salt_email : row.salt_username;
    return c.json({ salt: toB64(salt), kdf: JSON.parse(row.kdf_params) });
  }
  // Unknown account: deterministic fake salt, same shape and parameters.
  const path = isEmail(id) ? 'email' : 'username';
  const fake = await hmac(requireSecret(c.env.KDF_SALT_SECRET, 'KDF_SALT_SECRET'), `${path}:${id.toLowerCase()}`);
  return c.json({ salt: toB64(fake.subarray(0, 16)), kdf: CURRENT_KDF });
});

auth.post('/auth/register', async (c) => {
  const body = await parseBody(c, registerRequest);
  if (!body) return bad(c);
  // Honeypot filled → pretend success, create nothing.
  if (body.website) return c.json({ ok: true }, 201);
  const ip = await ipKey(c);
  if (!(await rateLimit(c.env.DB, `register:${ip}`, 5, 60 * MIN))) return tooMany(c);
  if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c)))) return c.json({ error: 'bot_check_failed' }, 400);
  if (JSON.stringify(body.kdf) !== JSON.stringify(CURRENT_KDF)) return bad(c);

  // Usernames are public, so reporting a taken username is not an enumeration leak.
  // Email availability is never reported (unverified emails are not unique).
  const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(body.username).first();
  if (taken) return c.json({ error: 'username_taken' }, 409);

  const now = Date.now();
  const userId = randomId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO users (id, username, email_normalized, status, created_at) VALUES (?, ?, ?, 'active', ?)`).bind(userId, body.username, body.email, now),
      c.env.DB.prepare(
        `INSERT INTO credentials (user_id, salt_username, salt_email, kdf_params, auth_hash_u, auth_hash_e, recovery_auth_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(userId, fromB64(body.saltUsername), fromB64(body.saltEmail), JSON.stringify(body.kdf), await authHash(c.env, body.authKeyUsername), await authHash(c.env, body.authKeyEmail), await authHash(c.env, body.recoveryAuthKey), now),
      c.env.DB.prepare(
        `INSERT INTO vaults (user_id, enc_ask_username, enc_ask_email, enc_ask_recovery, enc_private_keys, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(userId, fromB64(body.vault.encAskUsername), fromB64(body.vault.encAskEmail), fromB64(body.vault.encAskRecovery), fromB64(body.vault.encPrivateKeys), now),
      c.env.DB.prepare(`INSERT INTO user_keys (id, user_id, x25519_pub, ed25519_pub, created_at) VALUES (?, ?, ?, ?, ?)`).bind(randomId(), userId, fromB64(body.publicKeys.x25519), fromB64(body.publicKeys.ed25519), now),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json({ error: 'username_taken' }, 409);
    throw e;
  }
  await c.env.DB.prepare('INSERT INTO login_events (id, user_id, at, success, ip_hmac, ua_summary, reason) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .bind(randomId(), userId, now, ip, uaSummary(c), 'registered')
    .run();
  await reindexProfile(c.env.DB, userId);
  await createSession(c, userId);
  return c.json({ ok: true }, 201);
});

auth.post('/auth/login', async (c) => {
  const body = await parseBody(c, loginRequest);
  if (!body) return bad(c);
  const ip = await ipKey(c);
  const idKey = toB64((await hmac(requireSecret(c.env.IP_HMAC_SECRET, 'IP_HMAC_SECRET'), `id:${body.identifier.toLowerCase()}`)).subarray(0, 12));
  const okIp = await rateLimit(c.env.DB, `login-ip:${ip}`, 30, 15 * MIN);
  const okId = await rateLimit(c.env.DB, `login-id:${idKey}`, 10, 15 * MIN);
  if (!okIp || !okId) return tooMany(c);
  if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c)))) return c.json({ error: 'bot_check_failed' }, 400);

  const row = await findByIdentifier(c.env.DB, body.identifier);
  const presented = await authHash(c.env, body.authKey);
  const viaEmail = isEmail(body.identifier);
  const expected = row ? new Uint8Array(viaEmail ? row.auth_hash_e : row.auth_hash_u) : new Uint8Array(32);
  const valid = row !== null && timingSafeEqual(presented, expected);
  const now = Date.now();
  const ua = uaSummary(c);

  if (!valid) {
    await c.env.DB.prepare('INSERT INTO login_events (id, user_id, at, success, ip_hmac, ua_summary, reason) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .bind(randomId(), row?.id ?? null, now, ip, ua, 'invalid_credentials')
      .run();
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  // Only reveal account state after the password proved correct.
  if (row.status !== 'active' && row.status !== 'restricted') return c.json({ error: 'account_unavailable' }, 403);

  const prior = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n, SUM(CASE WHEN ip_hmac = ? OR ua_summary = ? THEN 1 ELSE 0 END) AS known FROM login_events WHERE user_id = ? AND success = 1 AND at > ?',
  )
    .bind(ip, ua, row.id, now - 90 * 24 * 3600 * 1000)
    .first<{ n: number; known: number | null }>();
  const suspicious = (prior?.n ?? 0) > 0 && (prior?.known ?? 0) === 0 ? 1 : 0;
  await c.env.DB.prepare('INSERT INTO login_events (id, user_id, at, success, ip_hmac, ua_summary, suspicious) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .bind(randomId(), row.id, now, ip, ua, suspicious)
    .run();
  await createSession(c, row.id);
  return c.json({
    user: userJson(row),
    vault: { encAsk: toB64(viaEmail ? row.enc_ask_email : row.enc_ask_username), slot: viaEmail ? 'password-email' : 'password-username', encPrivateKeys: toB64(row.enc_private_keys) },
    newDevice: suspicious === 1,
  });
});

async function recoveryLimited(c: Context<AppBindings>, username: string): Promise<boolean> {
  const okIp = await rateLimit(c.env.DB, `recover-ip:${await ipKey(c)}`, 10, 60 * MIN);
  const okUser = await rateLimit(c.env.DB, `recover-u:${username.toLowerCase()}`, 10, 60 * MIN);
  return !okIp || !okUser;
}

async function checkRecovery(c: Context<AppBindings>, username: string, recoveryAuthKey: string): Promise<CredRow | null> {
  const row = await findByIdentifier(c.env.DB, username);
  const presented = await authHash(c.env, recoveryAuthKey);
  const expected = row?.recovery_auth_hash ? new Uint8Array(row.recovery_auth_hash) : new Uint8Array(32);
  return row && row.recovery_auth_hash && timingSafeEqual(presented, expected) ? row : null;
}

/** Step 1: prove recovery-key possession, receive the ASK wrapped by the recovery key. */
auth.post('/auth/recover/challenge', async (c) => {
  const body = await parseBody(c, recoverChallengeRequest);
  if (!body) return bad(c);
  if (await recoveryLimited(c, body.username)) return tooMany(c);
  const row = await checkRecovery(c, body.username, body.recoveryAuthKey);
  if (!row) return c.json({ error: 'invalid_recovery' }, 401);
  const v = await c.env.DB.prepare('SELECT enc_ask_recovery FROM vaults WHERE user_id = ?').bind(row.id).first<{ enc_ask_recovery: ArrayBuffer | null }>();
  if (!v?.enc_ask_recovery) return c.json({ error: 'invalid_recovery' }, 401);
  return c.json({ encAskRecovery: toB64(v.enc_ask_recovery) });
});

/**
 * Step 2 — email-less password reset by proving possession of the recovery key.
 * The account secret key is unchanged (re-wrapped client-side under the new
 * password), so encrypted content survives. All sessions are revoked.
 */
auth.post('/auth/recover', async (c) => {
  const body = await parseBody(c, recoverRequest);
  if (!body) return bad(c);
  if (await recoveryLimited(c, body.username)) return tooMany(c);
  if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c)))) return c.json({ error: 'bot_check_failed' }, 400);
  if (JSON.stringify(body.kdf) !== JSON.stringify(CURRENT_KDF)) return bad(c);
  const row = await checkRecovery(c, body.username, body.recoveryAuthKey);
  if (!row) return c.json({ error: 'invalid_recovery' }, 401);
  if (row.status !== 'active' && row.status !== 'restricted') return c.json({ error: 'account_unavailable' }, 403);

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE credentials SET salt_username = ?, salt_email = ?, auth_hash_u = ?, auth_hash_e = ?, updated_at = ? WHERE user_id = ?').bind(
      fromB64(body.saltUsername), fromB64(body.saltEmail), await authHash(c.env, body.authKeyUsername), await authHash(c.env, body.authKeyEmail), now, row.id,
    ),
    c.env.DB.prepare('UPDATE vaults SET enc_ask_username = ?, enc_ask_email = ?, version = version + 1, updated_at = ? WHERE user_id = ?').bind(
      fromB64(body.encAskUsername), fromB64(body.encAskEmail), now, row.id,
    ),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, row.id),
  ]);
  await appendAudit(c.env.DB, { actorId: row.id, action: 'account.password_recovered', target: `user:${row.id}` });
  await createSession(c, row.id);
  return c.json({ ok: true });
});

auth.post('/auth/logout', async (c) => {
  const s = await loadSession(c);
  if (s) await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(Date.now(), s.session_id).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

const authed = new Hono<AuthedBindings>();
authed.use('/auth/session', requireUser);
authed.use('/account/*', requireUser);

/** Current user + encrypted vault (client unlocks with the password, username path). */
authed.get('/auth/session', async (c) => {
  const s = c.get('session');
  const v = await c.env.DB.prepare(
    'SELECT c.salt_username, c.kdf_params, v.enc_ask_username, v.enc_private_keys FROM credentials c JOIN vaults v ON v.user_id = c.user_id WHERE c.user_id = ?',
  )
    .bind(s.user_id)
    .first<{ salt_username: ArrayBuffer; kdf_params: string; enc_ask_username: ArrayBuffer; enc_private_keys: ArrayBuffer }>();
  return c.json({
    user: userJson(s),
    unlock: v && { salt: toB64(v.salt_username), kdf: JSON.parse(v.kdf_params), encAsk: toB64(v.enc_ask_username), slot: 'password-username', encPrivateKeys: toB64(v.enc_private_keys) },
  });
});

authed.get('/account/sessions', async (c) => {
  const s = c.get('session');
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, last_seen_at, ua_summary FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 50`,
  )
    .bind(s.user_id, Date.now())
    .all<{ id: string; created_at: number; last_seen_at: number; ua_summary: string | null }>();
  return c.json({
    sessions: results.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, device: r.ua_summary, current: r.id === s.session_id })),
  });
});

authed.delete('/account/sessions/:id', async (c) => {
  const s = c.get('session');
  // Scoped to the caller's own sessions: another user's id is a no-op 404.
  const res = await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id'), s.user_id).run();
  if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  if (c.req.param('id') === s.session_id) clearSessionCookie(c);
  return c.json({ ok: true });
});

authed.post('/account/sessions/revoke-others', async (c) => {
  const s = c.get('session');
  const res = await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(Date.now(), s.user_id, s.session_id).run();
  return c.json({ revoked: res.meta.changes });
});

authed.get('/account/login-history', async (c) => {
  const s = c.get('session');
  const { results } = await c.env.DB.prepare('SELECT at, success, ua_summary, suspicious FROM login_events WHERE user_id = ? ORDER BY at DESC LIMIT 50')
    .bind(s.user_id)
    .all<{ at: number; success: number; ua_summary: string | null; suspicious: number }>();
  return c.json({ events: results.map((r) => ({ at: r.at, success: r.success === 1, device: r.ua_summary, newDevice: r.suspicious === 1 })) });
});

auth.route('/', authed);
export default auth;
