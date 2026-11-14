import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newProject, rand, registered } from './helpers';

const g = (v: number) => ({ keyVersion: v, wrappedKey: rand(80), signature: rand(64) });
const userId = async (name: string) => (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first<{ id: string }>())!.id;

describe('key grants outlive the person who signed them', () => {
  it('keeps a project open for people invited by an admin who later deleted their account', async () => {
    const { c: owner } = await registered('gr_owner');
    const { c: admin, reg: adminReg } = await registered('gr_admin');
    const { c: bob } = await registered('gr_bob');
    const p = await newProject(owner);
    expect((await owner.call('POST', `/projects/${p}/members`, { userId: await userId('gr_admin'), role: 'admin', grants: [g(1)] })).status).toBe(201);
    expect((await admin.call('POST', `/invites/${p}/accept`)).status).toBe(200);
    // The admin, not the owner, invites Bob: Bob's key grant is signed by the admin.
    expect((await admin.call('POST', `/projects/${p}/members`, { userId: await userId('gr_bob'), role: 'editor', grants: [g(1)] })).status).toBe(201);
    expect((await bob.call('POST', `/invites/${p}/accept`)).status).toBe(200);
    expect((await bob.call('GET', `/projects/${p}`)).json.project.grants).toHaveLength(1);

    expect((await admin.call('POST', '/account/delete', { currentAuthKey: adminReg.authKeyUsername, confirm: 'delete my account' })).status).toBe(200);

    // Bob still receives his grant together with the key that verifies it.
    const after = (await bob.call('GET', `/projects/${p}`)).json.project;
    expect(after.grants).toHaveLength(1);
    expect(after.grants[0].granterSignKey).toBe(adminReg.publicKeys.ed25519);
    // ...and the project is flagged so the owner's browser makes a fresh key the admin never had.
    expect(after.rotationDue).toBe(true);
  });

  it('tells members whether a public project can actually be played', async () => {
    const { c: owner } = await registered('gr_public');
    const r = await owner.call('POST', '/projects', { id: 'a'.repeat(26), visibility: 'public', encMeta: rand(80), grant: { wrappedKey: rand(80), signature: rand(64) }, publicMeta: { name: 'Open', description: '', genre: '', tags: [], color: '#112233' } });
    expect(r.status).toBe(201);
    // Public but without a listening link yet: the client creates one (see syncSharing).
    expect(r.json.project.listenable).toBe(false);
    const share = { id: 'b'.repeat(26), trackId: null, tokenHash: rand(32), hasPassword: false, allowDownload: false, allowComments: false, expiresAt: null, encPayload: rand(80), encSecret: rand(80), keyVersion: 1, files: [], publicSecret: rand(32) };
    expect((await owner.call('POST', `/projects/${r.json.project.id}/shares`, share)).status).toBe(201);
    expect((await owner.call('GET', `/projects/${r.json.project.id}`)).json.project.listenable).toBe(true);
  });
});
