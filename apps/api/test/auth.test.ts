import { CURRENT_KDF } from '@arai/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://arai.test';
let ipCounter = 0;
const rand = (n = 32) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const blob = () => rand(80);

class Client {
  cookie = '';
  ip = `198.51.100.${++ipCounter}`;
  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { Origin: ORIGIN, 'X-Arai-CSRF': '1', 'CF-Connecting-IP': this.ip, 'User-Agent': 'Mozilla/5.0 (X11; Linux) Firefox/140.0' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const m = /__Host-arai_s=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `__Host-arai_s=${m[1]}` : '';
    }
    return { status: res.status, json: (await res.json()) as any, setCookie: set };
  }
}

function registration(username: string, email = `${username.toLowerCase()}@example.com`) {
  return {
    username,
    email,
    saltUsername: rand(16),
    saltEmail: rand(16),
    kdf: CURRENT_KDF,
    authKeyUsername: rand(),
    authKeyEmail: rand(),
    recoveryAuthKey: rand(),
    vault: { encAskUsername: blob(), encAskEmail: blob(), encAskRecovery: blob(), encPrivateKeys: blob() },
    publicKeys: { x25519: rand(), ed25519: rand() },
  };
}

async function registered(username: string) {
  const c = new Client();
  const reg = registration(username);
  const r = await c.call('POST', '/auth/register', reg);
  expect(r.status).toBe(201);
  return { c, reg };
}

describe('capabilities', () => {
  it('reports email and SMS as unavailable (provider-gated, greyed out in UI)', async () => {
    const r = await new Client().call('GET', '/config');
    expect(r.json).toMatchObject({ emailDelivery: false, sms: false });
  });
});

describe('registration', () => {
  it('creates an active account, sets a hardened session cookie, and exposes session', async () => {
    const { c } = await registered('NewArtist');
    const r = await c.call('GET', '/auth/session');
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ username: 'NewArtist', emailVerified: false, status: 'active' });
    expect(r.json.unlock.kdf).toEqual(CURRENT_KDF);
  });

  it('sets __Host- cookie with HttpOnly, Secure, SameSite=Strict', async () => {
    const c = new Client();
    const r = await c.call('POST', '/auth/register', registration('cookiecheck'));
    expect(r.setCookie).toMatch(/^__Host-arai_s=/);
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/Secure/i);
    expect(r.setCookie).toMatch(/SameSite=Strict/i);
    expect(r.setCookie).toMatch(/Path=\//);
  });

  it('rejects taken usernames case-insensitively', async () => {
    await registered('TakenName');
    const r = await new Client().call('POST', '/auth/register', registration('takenname', 'other@example.com'));
    expect(r.status).toBe(409);
  });

  it('does not reveal whether an email is in use', async () => {
    await registered('emailowner');
    const r = await new Client().call('POST', '/auth/register', registration('emailsquatter', 'emailowner@example.com'));
    expect(r.status).toBe(201);
  });

  it('rejects malformed input and weakened KDF parameters', async () => {
    const c = new Client();
    expect((await c.call('POST', '/auth/register', { ...registration('ok_name'), username: 'x' })).status).toBe(400);
    expect((await c.call('POST', '/auth/register', { ...registration('ok_name2'), kdf: { ...CURRENT_KDF, opslimit: 2 } })).status).toBe(400);
    expect((await c.call('POST', '/auth/register', { ...registration('ok_name3'), authKeyUsername: 'short' })).status).toBe(400);
  });

  it('silently drops honeypot submissions', async () => {
    const c = new Client();
    const r = await c.call('POST', '/auth/register', { ...registration('botaccount'), website: 'http://spam' });
    expect(r.status).toBe(201);
    expect(r.setCookie).toBeNull();
    const row = await env.DB.prepare("SELECT 1 FROM users WHERE username = 'botaccount'").first();
    expect(row).toBeNull();
  });

  it('throttles registrations per IP', async () => {
    const c = new Client();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.call('POST', '/auth/register', registration(`burst_${i}`))).status);
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe('prelogin and login', () => {
  it('returns the stored salt for real accounts and indistinguishable fake salts otherwise', async () => {
    const { reg } = await registered('saltuser');
    const c = new Client();
    const real = await c.call('POST', '/auth/prelogin', { identifier: 'saltuser' });
    expect(real.json.salt).toBe(reg.saltUsername);
    const fake1 = await c.call('POST', '/auth/prelogin', { identifier: 'nobody_here' });
    const fake2 = await c.call('POST', '/auth/prelogin', { identifier: 'nobody_here' });
    expect(Object.keys(fake1.json).sort()).toEqual(Object.keys(real.json).sort());
    expect(fake1.json.kdf).toEqual(real.json.kdf);
    expect(fake1.json.salt).toBe(fake2.json.salt); // deterministic → no "random = fake" signal
    expect(fake1.json.salt).toHaveLength(real.json.salt.length);
  });

  it('treats unverified emails as unknown (no email sign-in until verified)', async () => {
    await registered('unverified');
    const c = new Client();
    const p = await c.call('POST', '/auth/prelogin', { identifier: 'unverified@example.com' });
    expect(p.status).toBe(200);
    const l = await c.call('POST', '/auth/login', { identifier: 'unverified@example.com', authKey: rand() });
    expect(l.status).toBe(401);
  });

  it('logs in with the correct authKey and returns the encrypted vault', async () => {
    const { reg } = await registered('loginuser');
    const c = new Client();
    const r = await c.call('POST', '/auth/login', { identifier: 'LOGINUSER', authKey: reg.authKeyUsername });
    expect(r.status).toBe(200);
    expect(r.json.vault).toEqual({ encAsk: reg.vault.encAskUsername, slot: 'password-username', encPrivateKeys: reg.vault.encPrivateKeys });
    expect((await c.call('GET', '/auth/session')).status).toBe(200);
  });

  it('gives identical errors for wrong password and unknown user', async () => {
    await registered('wrongpw');
    const c = new Client();
    const a = await c.call('POST', '/auth/login', { identifier: 'wrongpw', authKey: rand() });
    const b = await c.call('POST', '/auth/login', { identifier: 'ghost_user', authKey: rand() });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.json).toEqual(b.json);
  });

  it('blocks suspended accounts only after correct credentials', async () => {
    const { reg } = await registered('suspended1');
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE username = 'suspended1'").run();
    const c = new Client();
    expect((await c.call('POST', '/auth/login', { identifier: 'suspended1', authKey: rand() })).status).toBe(401);
    expect((await c.call('POST', '/auth/login', { identifier: 'suspended1', authKey: reg.authKeyUsername })).status).toBe(403);
  });

  it('rate-limits brute force per account', async () => {
    const { reg } = await registered('bruteme');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const attacker = new Client(); // fresh IP each time: per-account limit must still apply
      last = (await attacker.call('POST', '/auth/login', { identifier: 'bruteme', authKey: rand() })).status;
    }
    expect(last).toBe(429);
    expect((await new Client().call('POST', '/auth/login', { identifier: 'bruteme', authKey: reg.authKeyUsername })).status).toBe(429);
  });

  it('flags a login from a new device/network', async () => {
    const { reg } = await registered('travellr');
    const first = await new Client().call('POST', '/auth/login', { identifier: 'travellr', authKey: reg.authKeyUsername });
    expect(first.json.newDevice).toBe(false); // same browser as registration
    const c = new Client();
    c.ip = '203.0.113.200';
    const r = await exports.default.fetch(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-Arai-CSRF': '1', 'CF-Connecting-IP': c.ip, 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/605', 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'travellr', authKey: reg.authKeyUsername }),
      }),
    );
    expect(((await r.json()) as any).newDevice).toBe(true);
  });
});

describe('sessions', () => {
  it('logout revokes the session server-side', async () => {
    const { c } = await registered('logoutuser');
    const stolen = c.cookie;
    await c.call('POST', '/auth/logout');
    const thief = new Client();
    thief.cookie = stolen;
    expect((await thief.call('GET', '/auth/session')).status).toBe(401);
  });

  it('rejects forged, expired and idle sessions', async () => {
    const forged = new Client();
    forged.cookie = `__Host-arai_s=${rand()}`;
    expect((await forged.call('GET', '/auth/session')).status).toBe(401);

    const { c } = await registered('expiring');
    await env.DB.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = (SELECT id FROM users WHERE username = 'expiring')").run();
    expect((await c.call('GET', '/auth/session')).status).toBe(401);

    const { c: idle } = await registered('idleuser');
    await env.DB.prepare("UPDATE sessions SET last_seen_at = 1 WHERE user_id = (SELECT id FROM users WHERE username = 'idleuser')").run();
    expect((await idle.call('GET', '/auth/session')).status).toBe(401);
  });

  it('lists own sessions, revokes others, and cannot touch another user\'s sessions', async () => {
    const { c, reg } = await registered('multidev');
    const other = new Client();
    await other.call('POST', '/auth/login', { identifier: 'multidev', authKey: reg.authKeyUsername });
    const list = await c.call('GET', '/account/sessions');
    expect(list.json.sessions).toHaveLength(2);
    expect(list.json.sessions.filter((s: any) => s.current)).toHaveLength(1);

    const { c: mallory } = await registered('mallory');
    const victimSession = list.json.sessions.find((s: any) => !s.current).id;
    expect((await mallory.call('DELETE', `/account/sessions/${victimSession}`)).status).toBe(404);
    expect((await other.call('GET', '/auth/session')).status).toBe(200);

    expect((await c.call('POST', '/account/sessions/revoke-others')).json.revoked).toBe(1);
    expect((await other.call('GET', '/auth/session')).status).toBe(401);
    expect((await c.call('GET', '/auth/session')).status).toBe(200);
  });

  it('records login history for the account only', async () => {
    const { reg } = await registered('histuser');
    const c = new Client();
    await c.call('POST', '/auth/login', { identifier: 'histuser', authKey: rand() });
    await c.call('POST', '/auth/login', { identifier: 'histuser', authKey: reg.authKeyUsername });
    const h = await c.call('GET', '/account/login-history');
    expect(h.json.events.map((e: any) => e.success)).toEqual([true, false, true]); // login, failure, registration
  });

  it('requires authentication for account endpoints', async () => {
    expect((await new Client().call('GET', '/account/sessions')).status).toBe(401);
    expect((await new Client().call('GET', '/account/login-history')).status).toBe(401);
  });
});

describe('recovery-key password reset (email-less)', () => {
  const recovery = (reg: ReturnType<typeof registration>, recoveryAuthKey: string) => ({
    username: reg.username,
    recoveryAuthKey,
    saltUsername: rand(16),
    saltEmail: rand(16),
    kdf: CURRENT_KDF,
    authKeyUsername: rand(),
    authKeyEmail: rand(),
    encAskUsername: blob(),
    encAskEmail: blob(),
  });

  it('resets credentials with the recovery key and revokes all old sessions', async () => {
    const { c: oldDevice, reg } = await registered('forgetful');
    const c = new Client();
    const ch = await c.call('POST', '/auth/recover/challenge', { username: 'forgetful', recoveryAuthKey: reg.recoveryAuthKey });
    expect(ch.json.encAskRecovery).toBe(reg.vault.encAskRecovery);
    const req = recovery(reg, reg.recoveryAuthKey);
    const r = await c.call('POST', '/auth/recover', req);
    expect(r.status).toBe(200);
    expect((await oldDevice.call('GET', '/auth/session')).status).toBe(401);
    expect((await c.call('GET', '/auth/session')).status).toBe(200);
    // old password no longer works, new one does
    expect((await new Client().call('POST', '/auth/login', { identifier: 'forgetful', authKey: reg.authKeyUsername })).status).toBe(401);
    expect((await new Client().call('POST', '/auth/login', { identifier: 'forgetful', authKey: req.authKeyUsername })).status).toBe(200);
  });

  it('rejects a wrong recovery key without changing anything', async () => {
    const { reg } = await registered('safeuser');
    const r = await new Client().call('POST', '/auth/recover', recovery(reg, rand()));
    expect(r.status).toBe(401);
    expect((await new Client().call('POST', '/auth/recover/challenge', { username: 'safeuser', recoveryAuthKey: rand() })).status).toBe(401);
    expect((await new Client().call('POST', '/auth/recover/challenge', { username: 'no_such_user', recoveryAuthKey: rand() })).status).toBe(401);
    expect((await new Client().call('POST', '/auth/login', { identifier: 'safeuser', authKey: reg.authKeyUsername })).status).toBe(200);
  });
});
