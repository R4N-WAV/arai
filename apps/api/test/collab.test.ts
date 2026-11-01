import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, newProject, ORIGIN, pid, rand, registered } from './helpers';

const g = (v: number) => ({ keyVersion: v, wrappedKey: rand(80), signature: rand(64) });

async function userId(name: string) {
  return (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first<{ id: string }>())!.id;
}
async function uploadFile(c: Client, projectId: string, keyVersion = 1) {
  const id = pid();
  expect((await c.call('POST', `/projects/${projectId}/files`, { id, kind: 'audio', encSize: 300, chunkCount: 1, encFileKey: blob(), keyVersion })).status).toBe(201);
  expect((await c.call('PUT', `/files/${id}/chunks/0`, new Uint8Array(300).fill(9))).status).toBe(200);
  expect((await c.call('POST', `/files/${id}/complete`)).status).toBe(200);
  return id;
}
async function newTrack(c: Client, projectId: string, keyVersion = 1) {
  const fileId = await uploadFile(c, projectId, keyVersion);
  const versionId = pid();
  const r = await c.call('POST', `/projects/${projectId}/tracks`, { id: pid(), encMeta: blob(), keyVersion, version: { id: versionId, fileId, encMeta: blob(), keyVersion } });
  expect(r.status).toBe(201);
  return { trackId: r.json.track.id as string, versionId, fileId };
}
async function invite(owner: Client, p: string, name: string, role = 'editor', versions = 1) {
  const r = await owner.call('POST', `/projects/${p}/members`, { userId: await userId(name), role, grants: Array.from({ length: versions }, (_, i) => g(i + 1)) });
  expect(r.status).toBe(201);
}

describe('invitations and members', () => {
  it('invites by username; the invitee sees an invitation, not the project, until accepting', async () => {
    const { c: owner } = await registered('cl_owner');
    const { c: bob } = await registered('cl_bob');
    const p = await newProject(owner);
    const found = await owner.call('GET', '/users/lookup/cl_bob');
    expect(found.status).toBe(200);
    expect(found.json.user.boxKey).toBeTruthy();
    expect((await owner.call('GET', '/users/lookup/nobody_here')).status).toBe(404);

    // Every key version is required.
    expect((await owner.call('POST', `/projects/${p}/members`, { userId: found.json.user.id, role: 'editor', grants: [g(2)] })).status).toBe(409);
    await invite(owner, p, 'cl_bob');
    expect((await owner.call('POST', `/projects/${p}/members`, { userId: found.json.user.id, role: 'editor', grants: [g(1)] })).status).toBe(409);

    expect((await bob.call('GET', `/projects/${p}`)).status).toBe(404);
    expect((await bob.call('GET', `/projects/${p}/tracks`)).status).toBe(404);
    const inv = await bob.call('GET', '/invites');
    expect(inv.json.invites).toHaveLength(1);
    expect(inv.json.invites[0]).toMatchObject({ id: p, role: 'editor', invitedBy: 'cl_owner' });
    expect(inv.json.invites[0].grants).toHaveLength(1);
    const notes = await bob.call('GET', '/notifications');
    expect(notes.json.notifications[0]).toMatchObject({ kind: 'invite', actor: 'cl_owner', targetId: p });

    const acc = await bob.call('POST', `/invites/${p}/accept`);
    expect(acc.status).toBe(200);
    expect((await bob.call('GET', `/projects/${p}`)).status).toBe(200);
    expect((await bob.call('GET', '/invites')).json.invites).toHaveLength(0);
    const members = (await bob.call('GET', `/projects/${p}/members`)).json.members;
    expect(members.map((m: any) => [m.username, m.role, m.pending])).toEqual([['cl_owner', 'owner', false], ['cl_bob', 'editor', false]]);
  });

  it('enforces who may invite, promote and remove', async () => {
    const { c: owner } = await registered('cl_own2');
    const { c: admin } = await registered('cl_adm2');
    const { c: ed } = await registered('cl_ed2');
    await registered('cl_x2');
    const p = await newProject(owner);
    await invite(owner, p, 'cl_adm2', 'admin');
    await admin.call('POST', `/invites/${p}/accept`);
    await invite(admin, p, 'cl_ed2', 'editor');
    await ed.call('POST', `/invites/${p}/accept`);
    // Editors cannot invite; admins cannot create admins.
    expect((await ed.call('POST', `/projects/${p}/members`, { userId: await userId('cl_x2'), role: 'listener', grants: [g(1)] })).status).toBe(403);
    expect((await admin.call('POST', `/projects/${p}/members`, { userId: await userId('cl_x2'), role: 'admin', grants: [g(1)] })).status).toBe(403);
    expect((await admin.call('PATCH', `/projects/${p}/members/${await userId('cl_ed2')}`, { role: 'admin' })).status).toBe(403);
    expect((await admin.call('PATCH', `/projects/${p}/members/${await userId('cl_ed2')}`, { role: 'listener' })).status).toBe(200);
    expect((await admin.call('DELETE', `/projects/${p}/members/${await userId('cl_own2')}`)).status).toBe(403);
    expect((await ed.call('DELETE', `/projects/${p}/members/${await userId('cl_adm2')}`)).status).toBe(403);
    // Owner removes the admin; the removed admin loses access and the key is due for rotation.
    expect((await owner.call('DELETE', `/projects/${p}/members/${await userId('cl_adm2')}`)).status).toBe(200);
    expect((await admin.call('GET', `/projects/${p}`)).status).toBe(404);
    expect((await owner.call('GET', `/projects/${p}`)).json.project.rotationDue).toBe(true);
    const keys = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_keys WHERE project_id = ? AND user_id = ?').bind(p, await userId('cl_adm2')).first<{ n: number }>();
    expect(keys!.n).toBe(0);
  });

  it('rotates the key for exactly the remaining members; old versions stay in the keyring', async () => {
    const { c: owner } = await registered('cl_own3');
    const { c: bob } = await registered('cl_bob3');
    const { c: eve } = await registered('cl_eve3');
    const p = await newProject(owner);
    const t1 = await newTrack(owner, p, 1);
    for (const [cl, n] of [[bob, 'cl_bob3'], [eve, 'cl_eve3']] as const) {
      await invite(owner, p, n);
      await cl.call('POST', `/invites/${p}/accept`);
    }
    await eve.call('DELETE', `/projects/${p}/members/me`); // eve leaves
    const ownerId = await userId('cl_own3');
    const bobId = await userId('cl_bob3');
    const eveId = await userId('cl_eve3');
    const grant = (u: string) => ({ userId: u, wrappedKey: rand(80), signature: rand(64) });
    // Must not include the departed member, must include everyone else, must be the next version.
    expect((await owner.call('POST', `/projects/${p}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(ownerId), grant(bobId), grant(eveId)] })).status).toBe(409);
    expect((await owner.call('POST', `/projects/${p}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(ownerId)] })).status).toBe(409);
    expect((await owner.call('POST', `/projects/${p}/rotate`, { keyVersion: 3, encMeta: blob(), grants: [grant(ownerId), grant(bobId)] })).status).toBe(409);
    expect((await bob.call('POST', `/projects/${p}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(ownerId), grant(bobId)] })).status).toBe(403);
    expect((await owner.call('POST', `/projects/${p}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(ownerId), grant(bobId)] })).status).toBe(200);
    expect((await owner.call('POST', `/projects/${p}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [grant(ownerId), grant(bobId)] })).status).toBe(409);
    const proj = (await bob.call('GET', `/projects/${p}`)).json.project;
    expect(proj.keyVersion).toBe(2);
    expect(proj.rotationDue).toBe(false);
    expect(proj.grants.map((x: any) => x.keyVersion)).toEqual([1, 2]);
    // New content must use the new key; old tracks keep their version tag.
    expect((await owner.call('POST', `/projects/${p}/files`, { id: pid(), kind: 'audio', encSize: 300, chunkCount: 1, encFileKey: blob(), keyVersion: 1 })).status).toBe(409);
    const t2 = await newTrack(owner, p, 2);
    const tracks = (await bob.call('GET', `/projects/${p}/tracks`)).json.tracks;
    expect(tracks.find((t: any) => t.id === t1.trackId).keyVersion).toBe(1);
    expect(tracks.find((t: any) => t.id === t2.trackId).keyVersion).toBe(2);
    // A new invitee needs both versions.
    await registered('cl_new3');
    expect((await owner.call('POST', `/projects/${p}/members`, { userId: await userId('cl_new3'), role: 'listener', grants: [g(2)] })).status).toBe(409);
    await invite(owner, p, 'cl_new3', 'listener', 2);
  });
});

describe('comments', () => {
  it('members comment, reply one level deep, resolve and delete with the right roles', async () => {
    const { c: owner } = await registered('cm_owner');
    const { c: lis } = await registered('cm_lis');
    const { c: out } = await registered('cm_out');
    const p = await newProject(owner);
    const { versionId } = await newTrack(owner, p);
    await invite(owner, p, 'cm_lis', 'listener');
    await lis.call('POST', `/invites/${p}/accept`);

    const top = pid();
    expect((await lis.call('POST', `/versions/${versionId}/comments`, { id: top, keyVersion: 1, encBody: blob() })).status).toBe(201);
    expect((await out.call('POST', `/versions/${versionId}/comments`, { id: pid(), keyVersion: 1, encBody: blob() })).status).toBe(404);
    expect((await out.call('GET', `/versions/${versionId}/comments`)).status).toBe(404);
    expect((await lis.call('POST', `/versions/${versionId}/comments`, { id: pid(), keyVersion: 2, encBody: blob() })).status).toBe(409);
    const reply = pid();
    expect((await owner.call('POST', `/versions/${versionId}/comments`, { id: reply, parentId: top, keyVersion: 1, encBody: blob() })).status).toBe(201);
    expect((await owner.call('POST', `/versions/${versionId}/comments`, { id: pid(), parentId: reply, keyVersion: 1, encBody: blob() })).status).toBe(400);
    // Only the author edits; listeners cannot resolve others' comments; editors+ can.
    expect((await owner.call('PATCH', `/comments/${top}`, { keyVersion: 1, encBody: blob() })).status).toBe(403);
    expect((await lis.call('PATCH', `/comments/${top}`, { keyVersion: 1, encBody: blob() })).json.comment.editedAt).toBeTruthy();
    expect((await lis.call('PATCH', `/comments/${reply}`, { resolved: true })).status).toBe(403);
    expect((await owner.call('PATCH', `/comments/${top}`, { resolved: true })).json.comment.resolved).toBe(true);
    expect((await lis.call('DELETE', `/comments/${reply}`)).status).toBe(403);
    expect((await owner.call('DELETE', `/comments/${top}`)).status).toBe(200);
    const list = (await lis.call('GET', `/versions/${versionId}/comments`)).json.comments;
    expect(list).toHaveLength(2);
    expect(list.find((c: any) => c.id === top).encBody).toBeNull();
    const notes = await owner.call('GET', '/notifications');
    expect(notes.json.notifications.some((n: any) => n.kind === 'comment' && n.actor === 'cm_lis')).toBe(true);
  });
});

async function sha(b64: string) {
  const bin = Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bin));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const anon = () => {
  const c = new Client();
  return c;
};

describe('share links', () => {
  it('opens only with the right token, streams only listed files, and stops when revoked or expired', async () => {
    const { c: owner } = await registered('sh_owner');
    const p = await newProject(owner);
    const a = await newTrack(owner, p);
    const b = await newTrack(owner, p);
    const token = rand(32);
    const id = pid();
    const create = await owner.call('POST', `/projects/${p}/shares`, {
      id, trackId: a.trackId, tokenHash: await sha(token), hasPassword: true, allowDownload: false, allowComments: true, expiresAt: null,
      encPayload: blob(), encSecret: blob(), keyVersion: 1, files: [{ fileId: a.fileId, versionId: a.versionId }],
    });
    expect(create.status).toBe(201);
    // A file from another project cannot be smuggled into a link.
    const { c: other } = await registered('sh_other');
    const op = await newProject(other);
    const foreign = await newTrack(other, op);
    expect((await owner.call('POST', `/projects/${p}/shares`, {
      id: pid(), trackId: null, tokenHash: await sha(rand(32)), hasPassword: false, allowDownload: false, allowComments: false, expiresAt: null,
      encPayload: blob(), encSecret: blob(), keyVersion: 1, files: [{ fileId: foreign.fileId, versionId: foreign.versionId }],
    })).status).toBe(400);

    const guest = anon();
    expect((await guest.call('GET', `/share/${id}`)).json).toEqual({ hasPassword: true });
    expect((await guest.call('POST', `/share/${id}/open`, { token: rand(32) })).status).toBe(403);
    const opened = await guest.call('POST', `/share/${id}/open`, { token });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ allowDownload: false, allowComments: true });

    const chunk = (fileId: string, t: string) => exports.default.fetch(new Request(`${ORIGIN}/api/share/${id}/files/${fileId}/chunks/0`, { headers: { 'X-Share-Token': t } }));
    expect((await chunk(a.fileId, token)).status).toBe(200);
    expect((await chunk(a.fileId, rand(32))).status).toBe(404);
    expect((await chunk(b.fileId, token)).status).toBe(404);

    // Guest comments only on versions in the link; members see them with the link reference.
    expect((await guest.call('POST', `/share/${id}/comments`, { token, id: pid(), versionId: b.versionId, encBody: blob() })).status).toBe(400);
    expect((await guest.call('POST', `/share/${id}/comments`, { token, id: pid(), versionId: a.versionId, encBody: blob() })).status).toBe(201);
    expect((await guest.call('POST', `/share/${id}/comments/list`, { token })).json.comments).toHaveLength(1);
    const member = (await owner.call('GET', `/versions/${a.versionId}/comments`)).json;
    expect(member.comments[0].linkId).toBe(id);
    expect(member.links[id].encSecret).toBeTruthy();

    // Payload refresh can add the second track.
    expect((await owner.call('PUT', `/projects/${p}/shares/${id}`, { encPayload: blob(), files: [{ fileId: a.fileId, versionId: a.versionId }, { fileId: b.fileId, versionId: b.versionId }] })).status).toBe(200);
    expect((await chunk(b.fileId, token)).status).toBe(200);

    expect((await owner.call('DELETE', `/projects/${p}/shares/${id}`)).status).toBe(200);
    expect((await guest.call('POST', `/share/${id}/open`, { token })).status).toBe(404);
    expect((await chunk(a.fileId, token)).status).toBe(404);

    // Expired links stop working.
    const id2 = pid();
    const t2 = rand(32);
    await owner.call('POST', `/projects/${p}/shares`, {
      id: id2, trackId: null, tokenHash: await sha(t2), hasPassword: false, allowDownload: true, allowComments: false, expiresAt: Date.now() + 60_000,
      encPayload: blob(), encSecret: blob(), keyVersion: 1, files: [{ fileId: a.fileId, versionId: a.versionId }],
    });
    expect((await guest.call('POST', `/share/${id2}/open`, { token: t2 })).status).toBe(200);
    expect((await guest.call('POST', `/share/${id2}/comments`, { token: t2, id: pid(), versionId: a.versionId, encBody: blob() })).status).toBe(403);
    await env.DB.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, id2).run();
    expect((await guest.call('POST', `/share/${id2}/open`, { token: t2 })).status).toBe(404);
  });

  it('public listening links exist only while the project is public', async () => {
    const { c: owner } = await registered('sh_pub');
    const p = await newProject(owner);
    const a = await newTrack(owner, p);
    const body = (secret: string) => ({
      id: pid(), trackId: null, tokenHash: rand(32), hasPassword: false, allowDownload: false, allowComments: false, expiresAt: null,
      encPayload: blob(), encSecret: blob(), keyVersion: 1, files: [{ fileId: a.fileId, versionId: a.versionId }], publicSecret: secret,
    });
    expect((await owner.call('POST', `/projects/${p}/shares`, body(rand(32)))).status).toBe(400);
    await owner.call('PATCH', `/projects/${p}`, { visibility: 'public', publicMeta: { name: 'Open Air', description: '', genre: '', tags: [] } });
    const secret = rand(32);
    const created = await owner.call('POST', `/projects/${p}/shares`, body(secret));
    expect(created.status).toBe(201);
    const pub = await anon().call('GET', `/public/projects/${p}`);
    expect(pub.json.link).toEqual({ id: created.json.share.id, secret });
    expect((await anon().call('GET', '/profiles/sh_pub')).json.profile.projects[0].listenable).toBe(true);
    await owner.call('PATCH', `/projects/${p}`, { visibility: 'private', publicMeta: null });
    expect((await anon().call('GET', `/public/projects/${p}`)).status).toBe(404);
    expect((await anon().call('GET', `/share/${created.json.share.id}`)).status).toBe(404);
  });
});

describe('social', () => {
  it('follows, friends, blocks and notifications', async () => {
    const { c: ana } = await registered('so_ana');
    const { c: ben } = await registered('so_ben');
    expect((await ana.call('POST', '/social/so_ben/follow')).status).toBe(200);
    expect((await ben.call('GET', '/social/so_ana')).json).toMatchObject({ followsYou: true, following: false });
    expect((await ana.call('POST', '/social/so_ben/friend')).json.friend).toBe('requested');
    expect((await ben.call('GET', '/social/me/friends')).json.incoming.map((p: any) => p.username)).toEqual(['so_ana']);
    expect((await ben.call('POST', '/social/so_ana/friend')).json.friend).toBe('friends');
    expect((await ana.call('GET', '/social/so_ben')).json.friend).toBe('friends');
    const n = (await ben.call('GET', '/notifications')).json;
    expect(n.notifications.map((x: any) => x.kind).sort()).toEqual(['follow', 'friend_request']);
    expect(n.unread).toBe(2);
    await ben.call('POST', '/notifications/read');
    expect((await ben.call('GET', '/notifications')).json.unread).toBe(0);

    // Blocking ends everything and hides each from the other.
    expect((await ben.call('POST', '/social/so_ana/block')).status).toBe(200);
    expect((await ana.call('GET', '/social/so_ben')).json).toMatchObject({ following: false, friend: 'none' });
    expect((await ana.call('POST', '/social/so_ben/follow')).status).toBe(404);
    expect((await ana.call('GET', '/users/lookup/so_ben')).status).toBe(404);
    expect((await ben.call('GET', '/social/me/blocked')).json.people.map((p: any) => p.username)).toEqual(['so_ana']);
    expect((await ana.call('POST', '/reports', { targetType: 'user', targetId: 'so_ben', reason: 'harassment', details: 'test' })).status).toBe(201);
    const r = await env.DB.prepare("SELECT target_id, status FROM reports WHERE reason = 'harassment'").first<{ target_id: string; status: string }>();
    expect(r).toEqual({ target_id: await userId('so_ben'), status: 'open' });
  });

  it('discovery finds public projects and people, never private ones', async () => {
    const { c } = await registered('so_finder');
    await c.call('PUT', '/account/profile', { displayName: 'Mira Wavelength', bio: 'synths', location: '', links: [] });
    const make = async (name: string, visibility: 'public' | 'private') =>
      c.call('POST', '/projects', {
        id: pid(), visibility, encMeta: blob(), grant: { wrappedKey: rand(80), signature: rand(64) },
        publicMeta: visibility === 'public' ? { name, description: 'late night tape loops', genre: 'ambient', tags: ['loops'] } : undefined,
      });
    await make('Saltmarsh Tapes', 'public');
    await make('Secret Saltmarsh', 'private');
    const r = await anon().call('GET', '/discover?q=saltm');
    expect(r.status).toBe(200);
    expect(r.json.projects.map((p: any) => p.publicMeta.name)).toEqual(['Saltmarsh Tapes']);
    expect((await anon().call('GET', '/discover?q=wavelength')).json.people.map((p: any) => p.username)).toEqual(['so_finder']);
    expect((await anon().call('GET', '/discover?q=loops')).json.projects).toHaveLength(1);
    // FTS syntax in user input is treated as text.
    expect((await anon().call('GET', '/discover?q=' + encodeURIComponent('" OR * NEAR('))).status).toBe(200);
  });
});
