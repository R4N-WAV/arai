import { CURRENT_KDF, googleRefreshRequest, googleTokenRequest, storageTokenRequest, totpEnableRequest, totpSetupRequest, prefsRequest, changePasswordRequest, changeUsernameRequest, deleteAccountRequest, loginRequest, preloginRequest, recoverChallengeRequest, recoverRequest, registerRequest, type Capabilities } from '@arai/shared';
import { reindexProfile } from './social.js';
import { purgeFiles } from './tracks.js';
import { base32, newRecoveryCodes, normaliseCode, openSecret, sealSecret, verifyTotp } from '../lib/totp.js';
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
    push: !!env.VAPID_PRIVATE_JWK,
    storage: {
      dropbox: env.DROPBOX_APP_KEY ?? null,
      gdrive: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_API_KEY ? env.GOOGLE_CLIENT_ID : null,
    },
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

  // Second factor (authenticator app): nothing else is released until it passes.
  const totp = await c.env.DB.prepare('SELECT secret_enc, last_step FROM totp_secrets WHERE user_id = ? AND enabled_at IS NOT NULL').bind(row.id).first<{ secret_enc: ArrayBuffer; last_step: number }>();
  if (totp) {
    if (!body.totpCode && !body.mfaRecoveryCode) return c.json({ error: 'mfa_required' }, 401);
    if (!(await rateLimit(c.env.DB, `mfa:${row.id}`, 10, 15 * MIN))) return tooMany(c);
    let ok = false;
    if (body.totpCode) {
      const step = await verifyTotp(await openSecret(c.env, row.id, totp.secret_enc), body.totpCode);
      if (step !== null && step > totp.last_step) {
        // Guarded update: the same code cannot be used twice, even concurrently.
        const r = await c.env.DB.prepare('UPDATE totp_secrets SET last_step = ? WHERE user_id = ? AND last_step < ?').bind(step, row.id, step).run();
        ok = r.meta.changes === 1;
      }
    } else if (body.mfaRecoveryCode) {
      const h = await hmac(requireSecret(c.env.AUTH_PEPPER, 'AUTH_PEPPER'), `mfa-recovery:${normaliseCode(body.mfaRecoveryCode)}`);
      const r = await c.env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').bind(now, row.id, h).run();
      ok = r.meta.changes === 1;
    }
    if (!ok) {
      await c.env.DB.prepare('INSERT INTO login_events (id, user_id, at, success, ip_hmac, ua_summary, reason) VALUES (?, ?, ?, 0, ?, ?, ?)').bind(randomId(), row.id, now, ip, ua, 'invalid_mfa').run();
      return c.json({ error: 'invalid_mfa' }, 401);
    }
  }

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
authed.use('/auth/device-secret', requireUser);

/**
 * Remembered device: the server half of this session's unlock key. Created
 * once per session; it disappears with the session (sign out or revoke).
 */
authed.post('/auth/device-secret', async (c) => {
  const s = c.get('session');
  const row = await c.env.DB.prepare('SELECT device_secret FROM sessions WHERE id = ?').bind(s.session_id).first<{ device_secret: ArrayBuffer | null }>();
  if (row?.device_secret) return c.json({ secret: toB64(row.device_secret) });
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await c.env.DB.prepare('UPDATE sessions SET device_secret = ? WHERE id = ? AND device_secret IS NULL').bind(secret, s.session_id).run();
  const again = await c.env.DB.prepare('SELECT device_secret FROM sessions WHERE id = ?').bind(s.session_id).first<{ device_secret: ArrayBuffer }>();
  return c.json({ secret: toB64(again!.device_secret) });
});
authed.get('/auth/device-secret', async (c) => {
  const row = await c.env.DB.prepare('SELECT device_secret FROM sessions WHERE id = ?').bind(c.get('session').session_id).first<{ device_secret: ArrayBuffer | null }>();
  return row?.device_secret ? c.json({ secret: toB64(row.device_secret) }) : c.json({ error: 'not_found' }, 404);
});
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

// ---- account control (phase 9) ----------------------------------------------

/** Proves the caller knows the current password (its username-path auth key). */
async function passwordOk(env: Env, db: D1Database, userId: string, authKey: string): Promise<boolean> {
  const row = await db.prepare('SELECT auth_hash_u FROM credentials WHERE user_id = ?').bind(userId).first<{ auth_hash_u: ArrayBuffer }>();
  return !!row && timingSafeEqual(await authHash(env, authKey), new Uint8Array(row.auth_hash_u));
}

authed.post('/account/password', async (c) => {
  const body = await parseBody(c, changePasswordRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await rateLimit(c.env.DB, `pw-change:${s.user_id}`, 10, 3600_000))) return tooMany(c);
  if (JSON.stringify(body.kdf) !== JSON.stringify(CURRENT_KDF)) return bad(c);
  if (!(await passwordOk(c.env, c.env.DB, s.user_id, body.currentAuthKey))) return c.json({ error: 'invalid_credentials' }, 401);
  const now = Date.now();
  // The account key itself is unchanged (re-wrapped in the browser), so all
  // encrypted content stays readable. Every other session is signed out.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE credentials SET salt_username = ?, salt_email = ?, auth_hash_u = ?, auth_hash_e = ?, updated_at = ? WHERE user_id = ?').bind(
      fromB64(body.saltUsername), fromB64(body.saltEmail), await authHash(c.env, body.authKeyUsername), await authHash(c.env, body.authKeyEmail), now, s.user_id,
    ),
    c.env.DB.prepare('UPDATE vaults SET enc_ask_username = ?, enc_ask_email = ?, version = version + 1, updated_at = ? WHERE user_id = ?').bind(fromB64(body.encAskUsername), fromB64(body.encAskEmail), now, s.user_id),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(now, s.user_id, s.session_id),
  ]);
  await appendAudit(c.env.DB, { actorId: s.user_id, action: 'account.password_changed', target: `user:${s.user_id}` });
  return c.json({ ok: true });
});

authed.post('/account/username', async (c) => {
  const body = await parseBody(c, changeUsernameRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await rateLimit(c.env.DB, `uname-change:${s.user_id}`, 3, 24 * 3600_000))) return tooMany(c);
  if (!(await passwordOk(c.env, c.env.DB, s.user_id, body.currentAuthKey))) return c.json({ error: 'invalid_credentials' }, 401);
  try {
    await c.env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(body.username, s.user_id).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json({ error: 'username_taken' }, 409);
    throw e;
  }
  await reindexProfile(c.env.DB, s.user_id);
  await appendAudit(c.env.DB, { actorId: s.user_id, action: 'account.username_changed', target: `user:${s.user_id}`, details: { from: s.username, to: body.username } });
  return c.json({ ok: true, username: body.username });
});

/**
 * Deletes the account. Projects you own are deleted for everyone (their audio
 * is purged), your messages are erased, your memberships, follows, friendships
 * and profile go. A tombstone row remains so foreign keys and the audit log
 * stay intact; the username is freed.
 */
authed.post('/account/delete', async (c) => {
  const body = await parseBody(c, deleteAccountRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await rateLimit(c.env.DB, `delete:${s.user_id}`, 5, 3600_000))) return tooMany(c);
  if (!(await passwordOk(c.env, c.env.DB, s.user_id, body.currentAuthKey))) return c.json({ error: 'invalid_credentials' }, 401);
  const owner = await c.env.DB.prepare("SELECT 1 FROM platform_roles WHERE user_id = ? AND role = 'owner'").bind(s.user_id).first();
  if (owner) return c.json({ error: 'platform_owner' }, 409);
  const id = s.user_id;
  const now = Date.now();
  const { results: owned } = await c.env.DB.prepare('SELECT id FROM projects WHERE owner_id = ? AND deleted_at IS NULL').bind(id).all<{ id: string }>();
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE projects SET deleted_at = ?, visibility = 'private', public_meta = NULL, published_at = NULL WHERE owner_id = ? AND deleted_at IS NULL").bind(now, id),
    db.prepare('UPDATE share_links SET revoked_at = ? WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) AND revoked_at IS NULL').bind(now, id),
    db.prepare('DELETE FROM project_art WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)').bind(id),
    db.prepare('UPDATE project_members SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, id),
    db.prepare('DELETE FROM project_keys WHERE user_id = ?').bind(id),
    // Projects they were in need a new key (they held the old one).
    db.prepare('UPDATE projects SET rotation_due = 1 WHERE id IN (SELECT project_id FROM project_members WHERE user_id = ?) AND owner_id != ?').bind(id, id),
    db.prepare('UPDATE messages SET enc_body = NULL, deleted_at = ? WHERE sender_id = ? AND deleted_at IS NULL').bind(now, id),
    db.prepare("UPDATE conversation_members SET status = 'left' WHERE user_id = ?").bind(id),
    db.prepare('DELETE FROM conversation_keys WHERE user_id = ?').bind(id),
    db.prepare("UPDATE conversations SET rotation_due = 1 WHERE kind = 'group' AND id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)").bind(id),
    db.prepare('UPDATE comments SET enc_body = NULL, deleted_at = ? WHERE author_id = ? AND deleted_at IS NULL').bind(now, id),
    db.prepare('DELETE FROM message_reactions WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').bind(id, id),
    db.prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?').bind(id, id),
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').bind(id, id),
    db.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?').bind(id, id),
    db.prepare('DELETE FROM profile_images WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM profiles WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM account_prefs WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM totp_secrets WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM storage_accounts WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(id),
    db.prepare("DELETE FROM search_index WHERE kind = 'user' AND ref = ?").bind(id),
    db.prepare('UPDATE user_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, id),
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, id),
    db.prepare('DELETE FROM vaults WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM credentials WHERE user_id = ?').bind(id),
    db.prepare("UPDATE users SET status = 'deleted', deleted_at = ?, username = ?, email_normalized = '' WHERE id = ?").bind(now, `deleted_${id.slice(0, 20).replace(/[^A-Za-z0-9_]/g, '')}`, id),
  ]);
  for (const p of owned) {
    const files = await db.prepare("SELECT id FROM files WHERE project_id = ? AND status != 'deleted'").bind(p.id).all<{ id: string }>();
    await purgeFiles(c.env, c.executionCtx, p.id, files.results.map((f) => f.id));
    await db.prepare("DELETE FROM search_index WHERE kind = 'project' AND ref = ?").bind(p.id).run();
  }
  await appendAudit(db, { actorId: id, action: 'account.deleted', target: `user:${id}`, details: { projects: owned.length } });
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---- private library preferences (phase 10) ------------------------------------
authed.get('/account/prefs', async (c) => {
  const row = await c.env.DB.prepare('SELECT enc_data, updated_at FROM account_prefs WHERE user_id = ?').bind(c.get('session').user_id).first<{ enc_data: ArrayBuffer; updated_at: number }>();
  return c.json({ prefs: row ? { encData: toB64(row.enc_data), updatedAt: row.updated_at } : null });
});
authed.put('/account/prefs', async (c) => {
  const body = await parseBody(c, prefsRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await rateLimit(c.env.DB, `prefs:${s.user_id}`, 600, 3600_000))) return tooMany(c);
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO account_prefs (user_id, enc_data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET enc_data = excluded.enc_data, updated_at = excluded.updated_at')
    .bind(s.user_id, fromB64(body.encData), now)
    .run();
  return c.json({ updatedAt: now });
});

// ---- bring-your-own storage (Dropbox / Google Drive) ---------------------------------
authed.get('/account/storage-accounts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT provider, enc_token, connected_at FROM storage_accounts WHERE user_id = ?').bind(c.get('session').user_id).all<{ provider: string; enc_token: ArrayBuffer; connected_at: number }>();
  return c.json({ accounts: results.map((r) => ({ provider: r.provider, encToken: toB64(r.enc_token), connectedAt: r.connected_at })) });
});
authed.put('/account/storage-accounts/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (provider !== 'dropbox' && provider !== 'gdrive') return bad(c);
  const body = await parseBody(c, storageTokenRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  await c.env.DB.prepare('INSERT INTO storage_accounts (user_id, provider, enc_token, connected_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET enc_token = excluded.enc_token')
    .bind(s.user_id, provider, fromB64(body.encToken), Date.now())
    .run();
  await appendAudit(c.env.DB, { actorId: s.user_id, action: 'account.storage_connected', target: `user:${s.user_id}`, details: { provider } });
  return c.json({ ok: true });
});
authed.delete('/account/storage-accounts/:provider', async (c) => {
  const s = c.get('session');
  await c.env.DB.prepare('DELETE FROM storage_accounts WHERE user_id = ? AND provider = ?').bind(s.user_id, c.req.param('provider')).run();
  return c.json({ ok: true });
});

/** Google's token exchange needs the client secret, so it runs here; tokens are returned, never stored. */
async function google(env: Env, params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
  return res.ok && data.access_token ? { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresIn: data.expires_in ?? 3600 } : null;
}
authed.post('/account/storage/google/token', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.json({ error: 'not_configured' }, 404);
  const body = await parseBody(c, googleTokenRequest);
  if (!body || body.redirectUri !== `${new URL(c.req.url).origin}/storage/callback`) return bad(c);
  if (!(await rateLimit(c.env.DB, `gtoken:${c.get('session').user_id}`, 30, 3600_000))) return tooMany(c);
  const t = await google(c.env, { grant_type: 'authorization_code', code: body.code, code_verifier: body.codeVerifier, redirect_uri: body.redirectUri });
  return t ? c.json(t) : c.json({ error: 'oauth_failed' }, 400);
});
authed.post('/account/storage/google/refresh', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.json({ error: 'not_configured' }, 404);
  const body = await parseBody(c, googleRefreshRequest);
  if (!body) return bad(c);
  if (!(await rateLimit(c.env.DB, `grefresh:${c.get('session').user_id}`, 120, 3600_000))) return tooMany(c);
  const t = await google(c.env, { grant_type: 'refresh_token', refresh_token: body.refreshToken });
  return t ? c.json(t) : c.json({ error: 'oauth_failed' }, 400);
});

// ---- authenticator app (TOTP) -----------------------------------------------------
authed.get('/account/totp', async (c) => {
  const id = c.get('session').user_id;
  const t = await c.env.DB.prepare('SELECT enabled_at FROM totp_secrets WHERE user_id = ?').bind(id).first<{ enabled_at: number | null }>();
  const left = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(id).first<{ n: number }>();
  return c.json({ enabled: !!t?.enabled_at, recoveryCodesLeft: t?.enabled_at ? left?.n ?? 0 : 0 });
});

authed.post('/account/totp/setup', async (c) => {
  const body = await parseBody(c, totpSetupRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await rateLimit(c.env.DB, `totp-setup:${s.user_id}`, 10, 3600_000))) return tooMany(c);
  if (!(await passwordOk(c.env, c.env.DB, s.user_id, body.currentAuthKey))) return c.json({ error: 'invalid_credentials' }, 401);
  const existing = await c.env.DB.prepare('SELECT enabled_at FROM totp_secrets WHERE user_id = ?').bind(s.user_id).first<{ enabled_at: number | null }>();
  if (existing?.enabled_at) return c.json({ error: 'already_enabled' }, 409);
  const secret = crypto.getRandomValues(new Uint8Array(20));
  await c.env.DB.prepare('INSERT INTO totp_secrets (user_id, secret_enc, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, created_at = excluded.created_at, enabled_at = NULL, last_step = 0')
    .bind(s.user_id, await sealSecret(c.env, s.user_id, secret), Date.now())
    .run();
  const b32 = base32(secret);
  const label = encodeURIComponent(`Arai:${s.username}`);
  return c.json({ secret: b32, uri: `otpauth://totp/${label}?secret=${b32}&issuer=Arai&algorithm=SHA1&digits=6&period=30` });
});

authed.post('/account/totp/enable', async (c) => {
  const body = await parseBody(c, totpEnableRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await rateLimit(c.env.DB, `totp-enable:${s.user_id}`, 10, 15 * MIN))) return tooMany(c);
  const t = await c.env.DB.prepare('SELECT secret_enc FROM totp_secrets WHERE user_id = ? AND enabled_at IS NULL').bind(s.user_id).first<{ secret_enc: ArrayBuffer }>();
  if (!t) return c.json({ error: 'not_set_up' }, 409);
  const step = await verifyTotp(await openSecret(c.env, s.user_id, t.secret_enc), body.code);
  if (step === null) return c.json({ error: 'invalid_mfa' }, 400);
  const codes = newRecoveryCodes();
  const pepper = requireSecret(c.env.AUTH_PEPPER, 'AUTH_PEPPER');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE totp_secrets SET enabled_at = ?, last_step = ? WHERE user_id = ?').bind(Date.now(), step, s.user_id),
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(s.user_id),
    ...(await Promise.all(codes.map(async (code) => c.env.DB.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)').bind(randomId(), s.user_id, await hmac(pepper, `mfa-recovery:${normaliseCode(code)}`))))),
  ]);
  await appendAudit(c.env.DB, { actorId: s.user_id, action: 'account.totp_enabled', target: `user:${s.user_id}` });
  return c.json({ recoveryCodes: codes });
});

authed.post('/account/totp/disable', async (c) => {
  const body = await parseBody(c, totpSetupRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await passwordOk(c.env, c.env.DB, s.user_id, body.currentAuthKey))) return c.json({ error: 'invalid_credentials' }, 401);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM totp_secrets WHERE user_id = ?').bind(s.user_id),
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(s.user_id),
  ]);
  await appendAudit(c.env.DB, { actorId: s.user_id, action: 'account.totp_disabled', target: `user:${s.user_id}` });
  return c.json({ ok: true });
});

authed.post('/account/totp/recovery-codes', async (c) => {
  const body = await parseBody(c, totpSetupRequest);
  if (!body) return bad(c);
  const s = c.get('session');
  if (!(await passwordOk(c.env, c.env.DB, s.user_id, body.currentAuthKey))) return c.json({ error: 'invalid_credentials' }, 401);
  const t = await c.env.DB.prepare('SELECT 1 FROM totp_secrets WHERE user_id = ? AND enabled_at IS NOT NULL').bind(s.user_id).first();
  if (!t) return c.json({ error: 'not_enabled' }, 409);
  const codes = newRecoveryCodes();
  const pepper = requireSecret(c.env.AUTH_PEPPER, 'AUTH_PEPPER');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(s.user_id),
    ...(await Promise.all(codes.map(async (code) => c.env.DB.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)').bind(randomId(), s.user_id, await hmac(pepper, `mfa-recovery:${normaliseCode(code)}`))))),
  ]);
  return c.json({ recoveryCodes: codes });
});

auth.route('/', authed);
export default auth;
