import { describe, expect, it } from 'vitest';
import { blob, newProject, pid, rand, registered } from './helpers';

async function sha(b64: string) {
  const bin = Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bin));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const grant = (v: number) => ({ keyVersion: v, wrappedKey: rand(80), signature: rand(64) });

describe('invite links', () => {
  it('admins create them; a signed-in person with the token joins with self-sealed keys; uses are limited', async () => {
    const { c: owner } = await registered('il_owner');
    const { c: ed } = await registered('il_ed');
    const { c: joiner } = await registered('il_joiner');
    const { c: second } = await registered('il_second');
    const p = await newProject(owner);
    const token = rand(32);
    const body = { id: pid(), role: 'editor', tokenHash: await sha(token), encPayload: blob(), encSecret: blob(), keyVersion: 1, maxUses: 1, expiresInDays: 7 };
    expect((await ed.call('POST', `/projects/${p}/invite-links`, body)).status).toBe(404);
    expect((await owner.call('POST', `/projects/${p}/invite-links`, body)).status).toBe(201);
    expect((await owner.call('GET', `/projects/${p}/invite-links`)).json.links).toHaveLength(1);

    expect((await joiner.call('POST', `/join/${body.id}/open`, { token: rand(32) })).status).toBe(404);
    const open = await joiner.call('POST', `/join/${body.id}/open`, { token });
    expect(open.json).toMatchObject({ role: 'editor', keyVersion: 1, alreadyMember: false });
    expect((await joiner.call('POST', `/join/${body.id}`, { token, grants: [grant(1), grant(2)] })).status).toBe(409);
    expect((await joiner.call('POST', `/join/${body.id}`, { token, grants: [grant(1)] })).json.projectId).toBe(p);
    const proj = (await joiner.call('GET', `/projects/${p}`)).json.project;
    expect(proj.role).toBe('editor');
    expect(proj.grants).toHaveLength(1);
    // Single use: the next person cannot.
    expect((await second.call('POST', `/join/${body.id}/open`, { token })).status).toBe(404);
  });

  it('a key rotation revokes outstanding invite links', async () => {
    const { c: owner } = await registered('il_rot');
    const p = await newProject(owner);
    const token = rand(32);
    const id = pid();
    await owner.call('POST', `/projects/${p}/invite-links`, { id, role: 'listener', tokenHash: await sha(token), encPayload: blob(), encSecret: blob(), keyVersion: 1, maxUses: 5, expiresInDays: 7 });
    const ownerId = (await owner.call('GET', '/auth/session')).json.user.id;
    expect((await owner.call('POST', `/projects/${p}/rotate`, { keyVersion: 2, encMeta: blob(), grants: [{ userId: ownerId, wrappedKey: rand(80), signature: rand(64) }] })).status).toBe(200);
    const { c: late } = await registered('il_late');
    expect((await late.call('POST', `/join/${id}/open`, { token })).status).toBe(404);
  });
});
