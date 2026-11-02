import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, newProject, pid, rand, registered } from './helpers';

async function userId(name: string) {
  return (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first<{ id: string }>())!.id;
}
async function makeRole(name: string, role: 'owner' | 'moderator') {
  await env.DB.prepare('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)').bind(await userId(name), role, 'test', Date.now()).run();
}

describe('administration', () => {
  it('is invisible to ordinary users', async () => {
    const { c } = await registered('ad_plain');
    for (const p of ['/admin/me', '/admin/stats', '/admin/reports', '/admin/audit']) expect((await c.call('GET', p)).status).toBe(404);
    expect((await c.call('GET', '/account/platform-role')).json).toEqual({ role: null });
  });

  it('moderators handle reports with public data only; actions are audited; only the owner bans', async () => {
    const { c: owner } = await registered('ad_owner');
    const { c: mod } = await registered('ad_mod');
    const { c: rep } = await registered('ad_rep');
    const { c: bad } = await registered('ad_bad');
    await makeRole('ad_owner', 'owner');
    await makeRole('ad_mod', 'moderator');
    expect((await mod.call('GET', '/admin/me')).json.role).toBe('moderator');
    const stats = (await mod.call('GET', '/admin/stats')).json;
    expect(stats.users).toBeGreaterThan(0);
    expect(stats).toHaveProperty('storageBytes');

    // A public project gets reported and hidden.
    const p = (await bad.call('POST', '/projects', { id: pid(), visibility: 'public', encMeta: blob(), grant: { wrappedKey: rand(80), signature: rand(64) }, publicMeta: { name: 'Spam Tape', description: 'buy now', genre: '', tags: [] } })).json.project.id;
    expect((await rep.call('POST', '/reports', { targetType: 'project', targetId: p, reason: 'spam' })).status).toBe(201);
    expect((await rep.call('POST', '/reports', { targetType: 'user', targetId: 'ad_bad', reason: 'harassment', evidence: 'the decrypted text they sent' })).status).toBe(201);
    const reports = (await mod.call('GET', '/admin/reports')).json.reports;
    const pr = reports.find((r: any) => r.target_type === 'project');
    expect(pr.target.label).toContain('Spam Tape');
    const ur = reports.find((r: any) => r.target_type === 'user');
    expect(ur.evidence).toBe('the decrypted text they sent');
    expect((await mod.call('POST', `/admin/reports/${pr.id}`, { action: 'hide_project', note: 'spam' })).status).toBe(200);
    expect((await new Client().call('GET', '/discover?q=spam')).json.projects).toHaveLength(0);
    expect((await new Client().call('GET', '/profiles/ad_bad')).json.profile.projects).toHaveLength(0);

    // Banning needs the owner; suspension signs the person out everywhere.
    expect((await mod.call('POST', `/admin/reports/${ur.id}`, { action: 'ban_user' })).status).toBe(403);
    expect((await mod.call('POST', `/admin/reports/${ur.id}`, { action: 'suspend_user' })).status).toBe(200);
    expect((await bad.call('GET', '/projects')).status).toBe(401);
    expect((await bad.call('GET', '/notifications')).status).toBe(401);
    // Moderators cannot act on the owner.
    expect((await rep.call('POST', '/reports', { targetType: 'user', targetId: 'ad_owner', reason: 'other' })).status).toBe(201);
    const or = (await mod.call('GET', '/admin/reports')).json.reports.find((r: any) => r.target?.label === '@ad_owner');
    expect((await mod.call('POST', `/admin/reports/${or.id}`, { action: 'suspend_user' })).status).toBe(403);

    const audit = (await owner.call('GET', '/admin/audit')).json;
    expect(audit.intact).toBe(true);
    expect(audit.entries.map((e: any) => e.action)).toEqual(expect.arrayContaining(['moderation.hide_project', 'moderation.suspend_user']));
    // Only the owner appoints moderators.
    expect((await mod.call('POST', '/admin/moderators', { username: 'ad_rep', grant: true })).status).toBe(403);
    expect((await owner.call('POST', '/admin/moderators', { username: 'ad_rep', grant: true })).status).toBe(200);
    expect((await rep.call('GET', '/admin/me')).json.role).toBe('moderator');
  });

  it('restricted accounts keep private work but cannot publish, share or message strangers', async () => {
    const { c } = await registered('ad_restricted');
    const p = await newProject(c);
    await env.DB.prepare("UPDATE users SET status = 'restricted' WHERE id = ?").bind(await userId('ad_restricted')).run();
    expect((await c.call('GET', `/projects/${p}`)).status).toBe(200);
    expect((await c.call('PATCH', `/projects/${p}`, { visibility: 'public', publicMeta: { name: 'x', description: '', genre: '', tags: [] } })).json.error).toBe('account_restricted');
    expect((await c.call('POST', '/conversations', { id: pid(), kind: 'dm', userIds: ['someone'], grants: [] })).status).toBe(400);
  });
});

describe('listening stats', () => {
  it('counts plays per track, rate-limited per listener, visible to members', async () => {
    const { c } = await registered('st_owner');
    const p = await newProject(c);
    const fileId = pid();
    await c.call('POST', `/projects/${p}/files`, { id: fileId, kind: 'audio', encSize: 300, chunkCount: 1, encFileKey: blob(), keyVersion: 1 });
    await c.call('PUT', `/files/${fileId}/chunks/0`, new Uint8Array(300));
    await c.call('POST', `/files/${fileId}/complete`);
    const t = (await c.call('POST', `/projects/${p}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId, encMeta: blob(), keyVersion: 1 } })).json.track.id;
    await c.call('POST', `/tracks/${t}/play`);
    await c.call('POST', `/tracks/${t}/play`);
    expect((await c.call('GET', `/projects/${p}/plays`)).json.plays[t]).toEqual({ total: 1, last30: 1, viaLinks: 0 });
    const { c: out } = await registered('st_out');
    expect((await out.call('POST', `/tracks/${t}/play`)).status).toBe(404);
  });
});
