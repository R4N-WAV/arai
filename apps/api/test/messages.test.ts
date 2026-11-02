import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, newProject, ORIGIN, pid, rand, registered } from './helpers';

async function userId(name: string) {
  return (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first<{ id: string }>())!.id;
}
const grant = (u: string) => ({ userId: u, wrappedKey: rand(80), signature: rand(64) });
const msg = (kv = 1) => ({ id: pid(), keyVersion: kv, encBody: blob() });

describe('direct messages', () => {
  it('friends land in the inbox; strangers become a limited message request', async () => {
    const { c: ana } = await registered('dm_ana');
    const { c: ben } = await registered('dm_ben');
    const { c: cat } = await registered('dm_cat');
    const [a, b, k] = [await userId('dm_ana'), await userId('dm_ben'), await userId('dm_cat')];
    await ana.call('POST', '/social/dm_ben/friend');
    await ben.call('POST', '/social/dm_ana/friend');

    // Grants must cover exactly both people.
    expect((await ana.call('POST', '/conversations', { id: pid(), kind: 'dm', userIds: [b], grants: [grant(a)] })).status).toBe(400);
    const dm = await ana.call('POST', '/conversations', { id: pid(), kind: 'dm', userIds: [b], grants: [grant(a), grant(b)] });
    expect(dm.status).toBe(201);
    const id = dm.json.conversation.id;
    expect(dm.json.conversation.members.find((m: any) => m.id === b).status).toBe('active');
    // Asking again returns the same DM.
    expect((await ben.call('POST', '/conversations', { id: pid(), kind: 'dm', userIds: [a], grants: [grant(a), grant(b)] })).json.conversation.id).toBe(id);

    const m1 = msg();
    expect((await ana.call('POST', `/conversations/${id}/messages`, m1)).status).toBe(201);
    expect((await ana.call('POST', `/conversations/${id}/messages`, msg(2))).status).toBe(409);
    expect((await cat.call('GET', `/conversations/${id}/messages`)).status).toBe(404);
    const inbox = (await ben.call('GET', '/conversations')).json.conversations;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id, unread: 1, myStatus: 'active' });
    expect(inbox[0].grants).toHaveLength(1);
    await ben.call('POST', `/conversations/${id}/read`);
    expect((await ben.call('GET', `/conversations/${id}`)).json.conversation.unread).toBe(0);

    // Only the sender edits or deletes; reactions come from a fixed set.
    expect((await ben.call('PATCH', `/messages/${m1.id}`, { keyVersion: 1, encBody: blob() })).status).toBe(403);
    expect((await ana.call('PATCH', `/messages/${m1.id}`, { keyVersion: 1, encBody: blob() })).json.message.editedAt).toBeTruthy();
    expect((await ben.call('POST', `/messages/${m1.id}/reactions/fire`)).json.message.reactions).toEqual([{ reaction: 'fire', userIds: [b] }]);
    expect((await ben.call('POST', `/messages/${m1.id}/reactions/<script>`)).status).toBe(400);
    expect((await ben.call('DELETE', `/messages/${m1.id}`)).status).toBe(403);
    const del = await ana.call('DELETE', `/messages/${m1.id}`);
    expect(del.json.message.encBody).toBeNull();
    expect(del.json.message.reactions).toEqual([]);

    // A stranger's DM is a request: three messages at most until accepted.
    const req = await cat.call('POST', '/conversations', { id: pid(), kind: 'dm', userIds: [a], grants: [grant(a), grant(k)] });
    const rid = req.json.conversation.id;
    for (let i = 0; i < 3; i++) expect((await cat.call('POST', `/conversations/${rid}/messages`, msg())).status).toBe(201);
    expect((await cat.call('POST', `/conversations/${rid}/messages`, msg())).json.error).toBe('request_pending');
    expect((await ana.call('GET', `/conversations/${rid}`)).json.conversation.myStatus).toBe('request');
    expect((await ana.call('POST', `/conversations/${rid}/messages`, msg())).json.error).toBe('accept_first');
    expect((await ana.call('POST', `/conversations/${rid}/accept`)).status).toBe(200);
    expect((await cat.call('POST', `/conversations/${rid}/messages`, msg())).status).toBe(201);

    // Blocking stops new DMs.
    await ana.call('POST', '/social/dm_cat/block');
    expect((await cat.call('POST', `/conversations/${rid}/messages`, msg())).status).toBe(403);
  });
});

describe('groups and project chats', () => {
  it('group admins add and remove; leaving marks the key for rotation to exactly the rest', async () => {
    const { c: ana } = await registered('gr_ana');
    const { c: ben } = await registered('gr_ben');
    const { c: cat } = await registered('gr_cat');
    await registered('gr_dan');
    const [a, b, k, d] = [await userId('gr_ana'), await userId('gr_ben'), await userId('gr_cat'), await userId('gr_dan')];
    const g = await ana.call('POST', '/conversations', { id: pid(), kind: 'group', userIds: [b, k], grants: [grant(a), grant(b), grant(k)], encMeta: blob() });
    expect(g.status).toBe(201);
    const id = g.json.conversation.id;
    expect(g.json.conversation.myRole).toBe('admin');
    expect((await ben.call('POST', `/conversations/${id}/members`, { userId: d, grants: [{ keyVersion: 1, wrappedKey: rand(80), signature: rand(64) }] })).status).toBe(403);
    expect((await ana.call('POST', `/conversations/${id}/members`, { userId: d, grants: [{ keyVersion: 1, wrappedKey: rand(80), signature: rand(64) }] })).status).toBe(201);
    await ben.call('POST', `/conversations/${id}/accept`);
    expect((await cat.call('DELETE', `/conversations/${id}/members/me`)).status).toBe(200);
    expect((await cat.call('GET', `/conversations/${id}/messages`)).status).toBe(404);
    expect((await ana.call('GET', `/conversations/${id}`)).json.conversation.rotationDue).toBe(true);
    expect((await ana.call('POST', `/conversations/${id}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(a), grant(b), grant(k), grant(d)] })).status).toBe(409);
    expect((await ana.call('POST', `/conversations/${id}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(a), grant(b), grant(d)] })).status).toBe(200);
    const conv = (await ben.call('GET', `/conversations/${id}`)).json.conversation;
    expect(conv.keyVersion).toBe(2);
    expect(conv.grants.map((x: any) => x.keyVersion)).toEqual([1, 2]);
    expect((await ben.call('POST', `/conversations/${id}/messages`, msg(1))).status).toBe(409);
    expect((await ben.call('POST', `/conversations/${id}/messages`, msg(2))).status).toBe(201);
  });

  it('project chats follow project membership and the project keyring', async () => {
    const { c: owner } = await registered('pc_owner');
    const { c: out } = await registered('pc_out');
    const p = await newProject(owner);
    const conv = await owner.call('GET', `/projects/${p}/conversation`);
    expect(conv.json.conversation).toMatchObject({ id: p, kind: 'project', projectId: p, keyVersion: 1 });
    expect(conv.json.conversation.grants).toHaveLength(1);
    expect((await out.call('GET', `/projects/${p}/conversation`)).status).toBe(404);
    expect((await out.call('POST', `/conversations/${p}/messages`, msg())).status).toBe(404);
    expect((await owner.call('POST', `/conversations/${p}/messages`, msg())).status).toBe(201);
    expect((await owner.call('GET', '/conversations')).json.conversations.map((x: any) => x.id)).toContain(p);
  });
});

describe('attachments and realtime', () => {
  it('stores encrypted attachment chunks for members only and counts them toward the quota', async () => {
    const { c: ana } = await registered('at_ana');
    const { c: ben } = await registered('at_ben');
    const { c: eve } = await registered('at_eve');
    const [a, b] = [await userId('at_ana'), await userId('at_ben')];
    await ben.call('POST', '/social/at_ana/follow'); // Ben follows Ana: her DM is not a request
    const id = (await ana.call('POST', '/conversations', { id: pid(), kind: 'dm', userIds: [b], grants: [grant(a), grant(b)] })).json.conversation.id;
    const fid = pid();
    const before = (await ana.call('GET', '/account/storage')).json.used;
    expect((await ana.call('POST', `/conversations/${id}/files`, { id: fid, encSize: 540, chunkCount: 1 })).status).toBe(201);
    expect((await ana.call('PUT', `/conv-files/${fid}/chunks/0`, new Uint8Array(540).fill(3))).status).toBe(200);
    expect((await ana.call('POST', `/conv-files/${fid}/complete`)).status).toBe(200);
    expect((await ana.call('GET', '/account/storage')).json.used).toBe(before + 540);
    const get = (cookie: string) => exports.default.fetch(new Request(`${ORIGIN}/api/conv-files/${fid}/chunks/0`, { headers: { Cookie: cookie } }));
    const okRes = await get(ben.cookie);
    expect(okRes.status).toBe(200);
    expect((await okRes.arrayBuffer()).byteLength).toBe(540);
    expect((await get(eve.cookie)).status).toBe(404);
  });

  it('the realtime socket needs a session, an upgrade and our own origin', async () => {
    const { c } = await registered('rt_user');
    const call = (headers: Record<string, string>) => exports.default.fetch(new Request(`${ORIGIN}/api/realtime`, { headers }));
    expect((await call({ Upgrade: 'websocket', Origin: ORIGIN })).status).toBe(401);
    expect((await call({ Cookie: c.cookie, Origin: ORIGIN })).status).toBe(426);
    expect((await call({ Cookie: c.cookie, Upgrade: 'websocket', Origin: 'https://evil.example' })).status).toBe(403);
    const ok = await call({ Cookie: c.cookie, Upgrade: 'websocket', Origin: ORIGIN });
    expect(ok.status).toBe(101);
    ok.webSocket?.accept();
    ok.webSocket?.close();
  });
});
