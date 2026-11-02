import { CURRENT_KDF } from '@arai/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, newProject, rand, registered } from './helpers';

const change = (current: string, over: Record<string, unknown> = {}) => ({
  currentAuthKey: current, saltUsername: rand(16), saltEmail: rand(16), kdf: CURRENT_KDF,
  authKeyUsername: rand(), authKeyEmail: rand(), encAskUsername: blob(), encAskEmail: blob(), ...over,
});

describe('account control', () => {
  it('changes the password with the current one; other sessions end, this one stays', async () => {
    const { c, reg } = await registered('ac_pw');
    const other = new Client();
    const pre = await other.call('POST', '/auth/prelogin', { identifier: 'ac_pw' });
    expect(pre.status).toBe(200);
    expect((await other.call('POST', '/auth/login', { identifier: 'ac_pw', authKey: reg.authKeyUsername })).status).toBe(200);
    expect((await c.call('POST', '/account/password', change(rand()))).status).toBe(401);
    const next = change(reg.authKeyUsername);
    expect((await c.call('POST', '/account/password', next)).status).toBe(200);
    expect((await c.call('GET', '/auth/session')).status).toBe(200);
    expect((await other.call('GET', '/auth/session')).status).toBe(401);
    expect((await new Client().call('POST', '/auth/login', { identifier: 'ac_pw', authKey: reg.authKeyUsername })).status).toBe(401);
    expect((await new Client().call('POST', '/auth/login', { identifier: 'ac_pw', authKey: next.authKeyUsername })).status).toBe(200);
  });

  it('changes the username once the password is proven; names stay unique', async () => {
    const { c, reg } = await registered('ac_old');
    await registered('ac_taken');
    expect((await c.call('POST', '/account/username', { username: 'ac_new', currentAuthKey: rand() })).status).toBe(401);
    expect((await c.call('POST', '/account/username', { username: 'AC_TAKEN', currentAuthKey: reg.authKeyUsername })).status).toBe(409);
    expect((await c.call('POST', '/account/username', { username: 'ac_new', currentAuthKey: reg.authKeyUsername })).status).toBe(200);
    expect((await c.call('GET', '/auth/session')).json.user.username).toBe('ac_new');
    expect((await new Client().call('GET', '/profiles/ac_old')).status).toBe(404);
    expect((await new Client().call('GET', '/profiles/ac_new')).status).toBe(200);
  });

  it('deletes the account: data gone, name freed, sessions ended', async () => {
    const { c, reg } = await registered('ac_gone');
    const { c: friend } = await registered('ac_friend');
    const p = await newProject(c);
    await friend.call('POST', '/social/ac_gone/follow');
    expect((await c.call('POST', '/account/delete', { currentAuthKey: rand(), confirm: 'delete my account' })).status).toBe(401);
    expect((await c.call('POST', '/account/delete', { currentAuthKey: reg.authKeyUsername, confirm: 'yes' })).status).toBe(400);
    expect((await c.call('POST', '/account/delete', { currentAuthKey: reg.authKeyUsername, confirm: 'delete my account' })).status).toBe(200);
    expect((await c.call('GET', '/projects')).status).toBe(401);
    expect((await new Client().call('GET', '/profiles/ac_gone')).status).toBe(404);
    const row = await env.DB.prepare('SELECT deleted_at FROM projects WHERE id = ?').bind(p).first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeTruthy();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM follows f JOIN users u ON u.id = f.followee_id WHERE u.status = 'deleted' AND u.username LIKE 'deleted_%'").first<{ n: number }>())?.n).toBe(0);
    // The name can be registered again.
    await registered('ac_gone');
  });
});

describe('library preferences', () => {
  it('stores one encrypted blob per account, private to its owner', async () => {
    const { c } = await registered('pref_a');
    const { c: b } = await registered('pref_b');
    expect((await c.call('GET', '/account/prefs')).json.prefs).toBeNull();
    const enc = blob();
    expect((await c.call('PUT', '/account/prefs', { encData: enc })).status).toBe(200);
    expect((await c.call('GET', '/account/prefs')).json.prefs.encData).toBe(enc);
    expect((await b.call('GET', '/account/prefs')).json.prefs).toBeNull();
    expect((await c.call('PUT', '/account/prefs', { encData: 'not base64!' })).status).toBe(400);
  });
});
