import { CHUNK_OVERHEAD, CHUNK_SIZE } from '@arai/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, newProject, ORIGIN, pid, rand, registered } from './helpers';

const FULL = CHUNK_SIZE + CHUNK_OVERHEAD;
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

async function uploadFile(c: Client, projectId: string, sizes: number[]) {
  const id = pid();
  const encSize = sizes.reduce((a, b) => a + b, 0);
  const r = await c.call('POST', `/projects/${projectId}/files`, { id, kind: 'audio', encSize, chunkCount: sizes.length, encFileKey: blob(), keyVersion: 1 });
  expect(r.status).toBe(201);
  for (const [i, n] of sizes.entries()) expect((await c.call('PUT', `/files/${id}/chunks/${i}`, bytes(n, i + 1))).status).toBe(200);
  expect((await c.call('POST', `/files/${id}/complete`)).status).toBe(200);
  return id;
}

async function userId(name: string) {
  return (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first<{ id: string }>())!.id;
}
async function addMember(projectId: string, name: string, role: string) {
  await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role, created_at, accepted_at) VALUES (?, ?, ?, ?, ?)').bind(projectId, await userId(name), role, Date.now(), Date.now()).run();
}

describe('encrypted file upload', () => {
  it('stores chunks, completes, and serves them back byte-exact to members only', async () => {
    const { c } = await registered('up_owner');
    const { c: stranger } = await registered('up_stranger');
    const p = await newProject(c);
    const fileId = await uploadFile(c, p, [FULL, 500]);
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api/files/${fileId}/chunks/1`, { headers: { Cookie: c.cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(500);
    expect(got.every((b) => b === 2)).toBe(true);
    const denied = await exports.default.fetch(new Request(`${ORIGIN}/api/files/${fileId}/chunks/0`, { headers: { Cookie: stranger.cookie } }));
    expect(denied.status).toBe(404);
  });

  it('rejects wrong chunk sizes, out-of-range indexes and incomplete files', async () => {
    const { c } = await registered('up_bad');
    const p = await newProject(c);
    const id = pid();
    await c.call('POST', `/projects/${p}/files`, { id, kind: 'audio', encSize: FULL + 100, chunkCount: 2, encFileKey: blob(), keyVersion: 1 });
    expect((await c.call('PUT', `/files/${id}/chunks/0`, bytes(FULL - 1))).status).toBe(400);
    expect((await c.call('PUT', `/files/${id}/chunks/1`, bytes(99))).status).toBe(400);
    expect((await c.call('PUT', `/files/${id}/chunks/2`, bytes(100))).status).toBe(400);
    expect((await c.call('PUT', `/files/${id}/chunks/1`, bytes(100))).status).toBe(200);
    const done = await c.call('POST', `/files/${id}/complete`);
    expect(done.status).toBe(409);
    expect(done.json.received).toEqual([1]);
    // unfinished files cannot be streamed
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api/files/${id}/chunks/1`, { headers: { Cookie: c.cookie } }));
    expect(res.status).toBe(404);
  });

  it('rejects impossible layouts and oversized bodies', async () => {
    const { c } = await registered('up_layout');
    const p = await newProject(c);
    expect((await c.call('POST', `/projects/${p}/files`, { id: pid(), kind: 'audio', encSize: 10, chunkCount: 1, encFileKey: blob(), keyVersion: 1 })).status).toBe(400);
    expect((await c.call('POST', `/projects/${p}/files`, { id: pid(), kind: 'audio', encSize: FULL * 3, chunkCount: 2, encFileKey: blob(), keyVersion: 1 })).status).toBe(400);
    const id = pid();
    await c.call('POST', `/projects/${p}/files`, { id, kind: 'audio', encSize: FULL, chunkCount: 1, encFileKey: blob(), keyVersion: 1 });
    expect((await c.call('PUT', `/files/${id}/chunks/0`, bytes(FULL + 200))).status).toBe(413);
  });

  it('enforces the per-user quota', async () => {
    const { c } = await registered('up_quota');
    const p = await newProject(c);
    const big = { kind: 'audio', encSize: FULL * 199 + 100, chunkCount: 200, encFileKey: blob(), keyVersion: 1 }; // ≈ 209 MB
    expect((await c.call('POST', `/projects/${p}/files`, { id: pid(), ...big })).status).toBe(201);
    expect((await c.call('POST', `/projects/${p}/files`, { id: pid(), ...big })).status).toBe(201);
    const over = await c.call('POST', `/projects/${p}/files`, { id: pid(), ...big }); // would pass 500 MB
    expect(over.status).toBe(413);
    expect((await c.call('GET', '/account/storage')).json.used).toBe(2 * big.encSize);
  });

  it('lets listeners stream but not upload; only the uploader may write chunks', async () => {
    const { c: owner } = await registered('up_own2');
    const { c: listener } = await registered('up_lis2');
    const { c: editor } = await registered('up_edi2');
    const p = await newProject(owner);
    await addMember(p, 'up_lis2', 'listener');
    await addMember(p, 'up_edi2', 'editor');
    expect((await listener.call('POST', `/projects/${p}/files`, { id: pid(), kind: 'audio', encSize: 100, chunkCount: 1, encFileKey: blob(), keyVersion: 1 })).status).toBe(403);
    const id = pid();
    await owner.call('POST', `/projects/${p}/files`, { id, kind: 'audio', encSize: 100, chunkCount: 1, encFileKey: blob(), keyVersion: 1 });
    expect((await editor.call('PUT', `/files/${id}/chunks/0`, bytes(100))).status).toBe(403);
    expect((await owner.call('PUT', `/files/${id}/chunks/0`, bytes(100))).status).toBe(200);
    await owner.call('POST', `/files/${id}/complete`);
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api/files/${id}/chunks/0`, { headers: { Cookie: listener.cookie } }));
    expect(res.status).toBe(200);
  });
});

describe('tracks and versions', () => {
  it('creates a track, appends versions, switches back, and keeps history', async () => {
    const { c } = await registered('tr_owner');
    const p = await newProject(c);
    const f1 = await uploadFile(c, p, [300]);
    const t = pid();
    const v1 = pid();
    const created = await c.call('POST', `/projects/${p}/tracks`, { id: t, encMeta: blob(), keyVersion: 1, version: { id: v1, fileId: f1, encMeta: blob(), keyVersion: 1 } });
    expect(created.status).toBe(201);
    expect(created.json.track.currentVersionId).toBe(v1);
    const f2 = await uploadFile(c, p, [400]);
    const v2 = pid();
    const added = await c.call('POST', `/tracks/${t}/versions`, { id: v2, fileId: f2, encMeta: blob(), keyVersion: 1 });
    expect(added.json.track.versions.map((v: any) => v.number)).toEqual([1, 2]);
    expect(added.json.track.currentVersionId).toBe(v2);
    const restored = await c.call('PATCH', `/tracks/${t}`, { currentVersionId: v1 });
    expect(restored.json.track.currentVersionId).toBe(v1);
    expect(restored.json.track.versions).toHaveLength(2);
    const list = await c.call('GET', `/projects/${p}/tracks`);
    expect(list.json.tracks[0].versions[1].file.id).toBe(f2);
  });

  it('versions are append-only at the database level', async () => {
    const { c } = await registered('tr_append');
    const p = await newProject(c);
    const f = await uploadFile(c, p, [300]);
    await c.call('POST', `/projects/${p}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: f, encMeta: blob(), keyVersion: 1 } });
    await expect(env.DB.prepare('UPDATE track_versions SET file_id = file_id').run()).rejects.toThrow(/append-only/);
  });

  it('refuses unfinished, foreign or reused files', async () => {
    const { c } = await registered('tr_files');
    const p1 = await newProject(c);
    const p2 = await newProject(c);
    const pending = pid();
    await c.call('POST', `/projects/${p1}/files`, { id: pending, kind: 'audio', encSize: 100, chunkCount: 1, encFileKey: blob(), keyVersion: 1 });
    expect((await c.call('POST', `/projects/${p1}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: pending, encMeta: blob(), keyVersion: 1 } })).status).toBe(409);
    const other = await uploadFile(c, p2, [100]);
    expect((await c.call('POST', `/projects/${p1}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: other, encMeta: blob(), keyVersion: 1 } })).status).toBe(409);
    const f = await uploadFile(c, p1, [100]);
    expect((await c.call('POST', `/projects/${p1}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: f, encMeta: blob(), keyVersion: 1 } })).status).toBe(201);
    expect((await c.call('POST', `/projects/${p1}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: f, encMeta: blob(), keyVersion: 1 } })).status).toBe(409);
  });

  it('enforces roles and hides tracks from outsiders', async () => {
    const { c: owner } = await registered('tr_own3');
    const { c: editor } = await registered('tr_edi3');
    const { c: mallory } = await registered('tr_mal3');
    const p = await newProject(owner);
    await addMember(p, 'tr_edi3', 'editor');
    const f = await uploadFile(owner, p, [100]);
    const t = (await owner.call('POST', `/projects/${p}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: f, encMeta: blob(), keyVersion: 1 } })).json.track.id;
    expect((await mallory.call('GET', `/projects/${p}/tracks`)).status).toBe(404);
    expect((await mallory.call('PATCH', `/tracks/${t}`, { encMeta: blob(), keyVersion: 1 })).status).toBe(404);
    expect((await mallory.call('DELETE', `/tracks/${t}`)).status).toBe(404);
    expect((await editor.call('PATCH', `/tracks/${t}`, { encMeta: blob(), keyVersion: 1 })).status).toBe(200);
    expect((await editor.call('DELETE', `/tracks/${t}`)).status).toBe(403);
    expect((await owner.call('DELETE', `/tracks/${t}`)).status).toBe(200);
    expect((await owner.call('GET', `/projects/${p}/tracks`)).json.tracks).toEqual([]);
  });

  it('deleting a track or project releases its storage', async () => {
    const { c } = await registered('tr_purge');
    const p = await newProject(c);
    const f = await uploadFile(c, p, [5000]);
    const t = (await c.call('POST', `/projects/${p}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: pid(), fileId: f, encMeta: blob(), keyVersion: 1 } })).json.track.id;
    expect((await c.call('GET', '/account/storage')).json.used).toBe(5000);
    await c.call('DELETE', `/tracks/${t}`);
    expect((await c.call('GET', '/account/storage')).json.used).toBe(0);
    await uploadFile(c, p, [700]);
    await c.call('DELETE', `/projects/${p}`);
    expect((await c.call('GET', '/account/storage')).json.used).toBe(0);
  });

  it('requires authentication', async () => {
    const anon = new Client();
    expect((await anon.call('GET', `/projects/${pid()}/tracks`)).status).toBe(401);
    expect((await anon.call('PUT', `/files/${pid()}/chunks/0`, bytes(10))).status).toBe(401);
    expect(rand().length).toBeGreaterThan(0);
  });
});
