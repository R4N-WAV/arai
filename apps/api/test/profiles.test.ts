import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, ORIGIN, pid, rand, registered } from './helpers';

function png(w: number, h: number, extra = 100) {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number) {
  // SOI, APP0 (len 16), SOF0 (len 17) with height/width
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  const dv = new DataView(b.buffer);
  dv.setUint16(25, h);
  dv.setUint16(27, w);
  return b;
}
const anonGet = (path: string) => exports.default.fetch(new Request(`${ORIGIN}/api${path}`, { headers: { 'CF-Connecting-IP': '192.0.2.99' } }));

describe('profiles', () => {
  it('is public, shows only public projects, and never private ones', async () => {
    const { c } = await registered('prof_pub');
    await c.call('POST', '/projects', { id: pid(), visibility: 'private', encMeta: blob(), grant: { wrappedKey: rand(80), signature: rand(64) } });
    await c.call('POST', '/projects', {
      id: pid(), visibility: 'public', encMeta: blob(), grant: { wrappedKey: rand(80), signature: rand(64) },
      publicMeta: { name: 'Tidal EP', description: 'Out now', genre: 'ambient', tags: [], color: '#2f7f6f' },
    });
    const res = await anonGet('/profiles/prof_pub');
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as any;
    expect(profile.username).toBe('prof_pub');
    expect(profile.projects).toHaveLength(1);
    expect(profile.projects[0].publicMeta).toMatchObject({ name: 'Tidal EP', color: '#2f7f6f' });
    expect(JSON.stringify(profile)).not.toContain('email');
  });

  it('updates profile text and links, rejecting unsafe links', async () => {
    const { c } = await registered('prof_edit');
    const ok = await c.call('PUT', '/account/profile', {
      displayName: 'Prof Edit', bio: 'Producer from Chennai.', location: 'Chennai',
      links: [{ url: 'https://open.spotify.com/artist/x', label: '' }, { url: 'https://soundcloud.com/x', label: 'SC' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.json.profile).toMatchObject({ displayName: 'Prof Edit', location: 'Chennai' });
    for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'data:text/html,hi']) {
      expect((await c.call('PUT', '/account/profile', { displayName: '', bio: '', location: '', links: [{ url, label: '' }] })).status).toBe(400);
    }
    expect((await c.call('PUT', '/account/profile', { displayName: 'x'.repeat(61), bio: '', location: '', links: [] })).status).toBe(400);
  });

  it('accepts real images within limits and serves them publicly', async () => {
    const { c } = await registered('prof_img');
    const up = await c.call('PUT', '/account/profile/avatar', png(256, 256));
    expect(up.status).toBe(200);
    expect(up.json.profile.avatar).toBeTypeOf('number');
    expect((await c.call('PUT', '/account/profile/banner', jpeg(1600, 500))).status).toBe(200);
    const img = await anonGet('/profiles/prof_img/avatar');
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect(bytes.length).toBe(png(256, 256).length);
    expect(bytes[0]).toBe(0x89);
    expect((await c.call('DELETE', '/account/profile/avatar')).json.profile.avatar).toBeNull();
    expect((await anonGet('/profiles/prof_img/avatar')).status).toBe(404);
  });

  it('rejects fake, oversized and huge-dimension images', async () => {
    const { c } = await registered('prof_bad');
    expect((await c.call('PUT', '/account/profile/avatar', new TextEncoder().encode('<svg onload=alert(1)>'))).status).toBe(400);
    expect((await c.call('PUT', '/account/profile/avatar', png(30000, 30000))).status).toBe(400); // decompression bomb
    expect((await c.call('PUT', '/account/profile/avatar', png(200, 200, 400 * 1024))).status).toBe(413);
    expect((await c.call('PUT', '/account/profile/wallpaper', png(10, 10))).status).toBe(404);
  });

  it('requires sign-in to edit, and hides suspended accounts', async () => {
    const anon = new Client();
    expect((await anon.call('PUT', '/account/profile', { displayName: '', bio: '', location: '', links: [] })).status).toBe(401);
    expect((await anon.call('PUT', '/account/profile/avatar', png(10, 10))).status).toBe(401);
    await registered('prof_gone');
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE username = 'prof_gone'").run();
    expect((await anonGet('/profiles/prof_gone')).status).toBe(404);
    expect((await anonGet('/profiles/no_such_person')).status).toBe(404);
  });
});
