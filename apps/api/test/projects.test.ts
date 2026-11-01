import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, rand, registered } from './helpers';

const pid = () => Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');
const createBody = (over: Record<string, unknown> = {}) => ({
  id: pid(),
  visibility: 'private',
  encMeta: blob(),
  grant: { wrappedKey: rand(80), signature: rand(64) },
  ...over,
});
const pub = { name: 'Tidal EP', description: 'Four songs about water', genre: 'ambient', tags: ['ep'] };

async function userId(username: string) {
  return (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: string }>())!.id;
}
async function addMember(projectId: string, username: string, role: string) {
  await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role, created_at, accepted_at) VALUES (?, ?, ?, ?, ?)').bind(projectId, await userId(username), role, Date.now(), Date.now()).run();
}

describe('projects: create and list', () => {
  it('creates a private project with an owner grant and lists it', async () => {
    const { c } = await registered('maker1');
    const body = createBody();
    const r = await c.call('POST', '/projects', body);
    expect(r.status).toBe(201);
    expect(r.json.project).toMatchObject({ id: body.id, role: 'owner', visibility: 'private', keyVersion: 1, encMeta: body.encMeta, publicMeta: null });
    expect(r.json.project.grants[0]).toMatchObject({ wrappedKey: body.grant.wrappedKey, signature: body.grant.signature });
    expect(r.json.project.grants[0].granterSignKey).toBeTruthy();
    const list = await c.call('GET', '/projects');
    expect(list.json.projects.map((p: any) => p.id)).toEqual([body.id]);
  });

  it('stores plaintext metadata only for public projects', async () => {
    const { c } = await registered('maker2');
    const priv = await c.call('POST', '/projects', createBody());
    const row = await env.DB.prepare('SELECT public_meta FROM projects WHERE id = ?').bind(priv.json.project.id).first<{ public_meta: string | null }>();
    expect(row!.public_meta).toBeNull();
    const p = await c.call('POST', '/projects', createBody({ visibility: 'public', publicMeta: pub }));
    expect(p.status).toBe(201);
    expect(p.json.project.publicMeta).toMatchObject(pub);
  });

  it('rejects inconsistent or malformed requests', async () => {
    const { c } = await registered('maker3');
    expect((await c.call('POST', '/projects', createBody({ visibility: 'public' }))).status).toBe(400);
    expect((await c.call('POST', '/projects', createBody({ publicMeta: pub }))).status).toBe(400);
    expect((await c.call('POST', '/projects', createBody({ id: 'NOT-AN-ID' }))).status).toBe(400);
    expect((await c.call('POST', '/projects', createBody({ encMeta: rand(20000) }))).status).toBe(400);
    expect((await c.call('POST', '/projects', createBody({ grant: { wrappedKey: rand(10), signature: rand(64) } }))).status).toBe(400);
  });

  it('refuses a duplicate id', async () => {
    const { c } = await registered('maker4');
    const body = createBody();
    expect((await c.call('POST', '/projects', body)).status).toBe(201);
    expect((await c.call('POST', '/projects', { ...body, encMeta: blob() })).status).toBe(409);
  });

  it('requires authentication', async () => {
    const anon = new Client();
    expect((await anon.call('GET', '/projects')).status).toBe(401);
    expect((await anon.call('POST', '/projects', createBody())).status).toBe(401);
  });
});

describe('projects: access control', () => {
  it('never shows another user’s project (404, not 403)', async () => {
    const { c: alice } = await registered('alice_p');
    const { c: mallory } = await registered('mallory_p');
    const id = (await alice.call('POST', '/projects', createBody())).json.project.id;
    expect((await mallory.call('GET', '/projects')).json.projects).toEqual([]);
    expect((await mallory.call('GET', `/projects/${id}`)).status).toBe(404);
    expect((await mallory.call('PATCH', `/projects/${id}`, { encMeta: blob() })).status).toBe(404);
    expect((await mallory.call('DELETE', `/projects/${id}`)).status).toBe(404);
    // and nothing changed
    const own = await alice.call('GET', `/projects/${id}`);
    expect(own.status).toBe(200);
  });

  it('enforces role levels: listener < editor < admin < owner', async () => {
    const { c: owner } = await registered('own_r');
    const { c: listener } = await registered('lis_r');
    const { c: editor } = await registered('edi_r');
    const { c: admin } = await registered('adm_r');
    const id = (await owner.call('POST', '/projects', createBody())).json.project.id;
    await addMember(id, 'lis_r', 'listener');
    await addMember(id, 'edi_r', 'editor');
    await addMember(id, 'adm_r', 'admin');

    expect((await listener.call('GET', `/projects/${id}`)).json.project.role).toBe('listener');
    expect((await listener.call('PATCH', `/projects/${id}`, { encMeta: blob() })).status).toBe(403);
    expect((await editor.call('PATCH', `/projects/${id}`, { encMeta: blob() })).status).toBe(200);
    expect((await editor.call('PATCH', `/projects/${id}`, { visibility: 'public', publicMeta: pub })).status).toBe(403);
    expect((await admin.call('PATCH', `/projects/${id}`, { visibility: 'public', publicMeta: pub })).status).toBe(200);
    expect((await admin.call('DELETE', `/projects/${id}`)).status).toBe(403);
    expect((await editor.call('DELETE', `/projects/${id}`)).status).toBe(403);
    expect((await owner.call('DELETE', `/projects/${id}`)).status).toBe(200);
  });

  it('revoked members lose access immediately', async () => {
    const { c: owner } = await registered('own_v');
    const { c: guest } = await registered('gst_v');
    const id = (await owner.call('POST', '/projects', createBody())).json.project.id;
    await addMember(id, 'gst_v', 'editor');
    expect((await guest.call('GET', `/projects/${id}`)).status).toBe(200);
    await env.DB.prepare('UPDATE project_members SET revoked_at = ? WHERE project_id = ? AND user_id = ?').bind(Date.now(), id, await userId('gst_v')).run();
    expect((await guest.call('GET', `/projects/${id}`)).status).toBe(404);
    expect((await guest.call('GET', '/projects')).json.projects).toEqual([]);
    expect((await guest.call('PATCH', `/projects/${id}`, { encMeta: blob() })).status).toBe(404);
  });
});

describe('projects: visibility and deletion', () => {
  it('switches public ↔ private and withdraws plaintext when going private', async () => {
    const { c } = await registered('vis_u');
    const id = (await c.call('POST', '/projects', createBody())).json.project.id;
    const up = await c.call('PATCH', `/projects/${id}`, { visibility: 'public', publicMeta: pub });
    expect(up.json.project.visibility).toBe('public');
    const down = await c.call('PATCH', `/projects/${id}`, { visibility: 'private', publicMeta: null });
    expect(down.json.project).toMatchObject({ visibility: 'private', publicMeta: null });
    const row = await env.DB.prepare('SELECT public_meta, published_at FROM projects WHERE id = ?').bind(id).first();
    expect(row).toEqual({ public_meta: null, published_at: null });
    // inconsistent combinations are rejected
    expect((await c.call('PATCH', `/projects/${id}`, { visibility: 'public' })).status).toBe(400);
    expect((await c.call('PATCH', `/projects/${id}`, { publicMeta: pub })).status).toBe(400);
    expect((await c.call('PATCH', `/projects/${id}`, {})).status).toBe(400);
  });

  it('deleting hides the project everywhere and withdraws its public copy', async () => {
    const { c } = await registered('del_u');
    const id = (await c.call('POST', '/projects', createBody({ visibility: 'public', publicMeta: pub }))).json.project.id;
    expect((await c.call('DELETE', `/projects/${id}`)).status).toBe(200);
    expect((await c.call('GET', `/projects/${id}`)).status).toBe(404);
    expect((await c.call('GET', '/projects')).json.projects).toEqual([]);
    const row = await env.DB.prepare('SELECT visibility, public_meta FROM projects WHERE id = ?').bind(id).first();
    expect(row).toEqual({ visibility: 'private', public_meta: null });
  });

  it('enforces one owner per project at the database level', async () => {
    const { c } = await registered('one_own');
    await registered('two_own');
    const id = (await c.call('POST', '/projects', createBody())).json.project.id;
    await expect(addMember(id, 'two_own', 'owner')).rejects.toThrow(/UNIQUE/);
  });
});
