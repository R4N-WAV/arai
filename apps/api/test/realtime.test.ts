import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, newProject, ORIGIN, pid, rand, registered } from './helpers';

const g = (v: number) => ({ keyVersion: v, wrappedKey: rand(80), signature: rand(64) });
const userId = async (name: string) => (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(name).first<{ id: string }>())!.id;

/** Opens the user's realtime socket and collects every project event it receives. */
async function listen(c: Client) {
  const res = await exports.default.fetch(new Request(`${ORIGIN}/api/realtime`, { headers: { Upgrade: 'websocket', Origin: ORIGIN, Cookie: c.cookie } }));
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const events: any[] = [];
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(String(e.data));
    if (d.type === 'project') events.push(d);
  });
  return {
    /** Waits for (and removes) the next event matching `what` for a project. */
    async next(projectId: string, what: string) {
      for (let i = 0; i < 100; i++) {
        const at = events.findIndex((e) => e.projectId === projectId && e.what === what);
        if (at >= 0) return events.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no "${what}" event arrived`);
    },
    close: () => ws.close(),
  };
}

async function newTrack(c: Client, projectId: string) {
  const fileId = pid();
  expect((await c.call('POST', `/projects/${projectId}/files`, { id: fileId, kind: 'audio', encSize: 300, chunkCount: 1, encFileKey: blob(), keyVersion: 1 })).status).toBe(201);
  expect((await c.call('PUT', `/files/${fileId}/chunks/0`, new Uint8Array(300).fill(9))).status).toBe(200);
  expect((await c.call('POST', `/files/${fileId}/complete`)).status).toBe(200);
  const versionId = pid();
  const r = await c.call('POST', `/projects/${projectId}/tracks`, { id: pid(), encMeta: blob(), keyVersion: 1, version: { id: versionId, fileId, encMeta: blob(), keyVersion: 1 } });
  expect(r.status).toBe(201);
  return { trackId: r.json.track.id as string, versionId, fileId };
}

describe('project changes reach open tabs', () => {
  it('announces invitations, acceptance, tracks, comments, details and removal to the people concerned', async () => {
    const { c: owner } = await registered('rt_owner');
    const { c: bob } = await registered('rt_bob');
    const { c: eve } = await registered('rt_eve');
    const p = await newProject(owner);
    const [o, b, e] = [await listen(owner), await listen(bob), await listen(eve)];

    // The invitee hears about the invitation straight away (their library is already open).
    expect((await owner.call('POST', `/projects/${p}/members`, { userId: await userId('rt_bob'), role: 'editor', grants: [g(1)] })).status).toBe(201);
    expect(await b.next(p, 'members')).toMatchObject({ type: 'project', projectId: p, what: 'members' });

    // The owner hears that it was accepted.
    await o.next(p, 'members');
    expect((await bob.call('POST', `/invites/${p}/accept`)).status).toBe(200);
    await o.next(p, 'members');

    // New tracks, comments and renamed details reach the other member.
    const t = await newTrack(owner, p);
    await b.next(p, 'tracks');
    expect((await bob.call('POST', `/versions/${t.versionId}/comments`, { id: pid(), keyVersion: 1, encBody: blob() })).status).toBe(201);
    expect(await o.next(p, 'comments')).toMatchObject({ versionId: t.versionId });
    expect((await owner.call('PATCH', `/projects/${p}`, { encMeta: blob() })).status).toBe(200);
    await b.next(p, 'details');

    // Someone who is removed is told, so their open tab lets go of the project.
    expect((await owner.call('DELETE', `/projects/${p}/members/${await userId('rt_bob')}`)).status).toBe(200);
    await b.next(p, 'members');

    // Nobody outside the project ever hears about it.
    await new Promise((r) => setTimeout(r, 100));
    await expect(e.next(p, 'members')).rejects.toThrow();
    for (const s of [o, b, e]) s.close();
  }, 20_000);
});

describe('keeping links and the library current', () => {
  it('lists the versions each link serves, so a link that fell behind can be spotted', async () => {
    const { c: owner } = await registered('rt_links');
    const p = await newProject(owner);
    const a = await newTrack(owner, p);
    const link = pid();
    const share = { id: link, trackId: null, tokenHash: rand(32), hasPassword: false, allowDownload: false, allowComments: false, expiresAt: null, encPayload: blob(), encSecret: blob(), keyVersion: 1 };
    const made = await owner.call('POST', `/projects/${p}/shares`, { ...share, files: [{ fileId: a.fileId, versionId: a.versionId }] });
    expect(made.status).toBe(201);
    expect(made.json.share.versionIds).toEqual([a.versionId]);
    const b = await newTrack(owner, p);
    // Not refreshed yet: the listing still shows only the first version.
    expect((await owner.call('GET', `/projects/${p}/shares`)).json.shares[0].versionIds).toEqual([a.versionId]);
    expect((await owner.call('PUT', `/projects/${p}/shares/${link}`, { encPayload: blob(), files: [a, b].map((x) => ({ fileId: x.fileId, versionId: x.versionId })) })).status).toBe(200);
    expect((await owner.call('GET', `/projects/${p}/shares`)).json.shares[0].versionIds.sort()).toEqual([a.versionId, b.versionId].sort());
  });

  it('counts a new version, a rename and a deleted track as a change to the project, but not a reorder', async () => {
    const { c: owner } = await registered('rt_touch');
    const p = await newProject(owner);
    const t = await newTrack(owner, p);
    const stamp = async () => (await owner.call('GET', `/projects/${p}`)).json.project.updatedAt as number;
    const settle = () => new Promise((r) => setTimeout(r, 5));

    let before = await stamp();
    await settle();
    expect((await owner.call('PATCH', `/tracks/${t.trackId}`, { position: 5 })).status).toBe(200);
    expect(await stamp()).toBe(before);

    expect((await owner.call('PATCH', `/tracks/${t.trackId}`, { encMeta: blob(), keyVersion: 1 })).status).toBe(200);
    expect(await stamp()).toBeGreaterThan(before);

    before = await stamp();
    await settle();
    expect((await owner.call('DELETE', `/tracks/${t.trackId}`)).status).toBe(200);
    expect(await stamp()).toBeGreaterThan(before);
  });
});
