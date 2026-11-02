import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { blob, Client, ORIGIN, pid, rand, registered } from './helpers';

// Smallest valid WebP header (VP8L, 32x32) padded to a plausible size.
function webp(): Uint8Array {
  const b = new Uint8Array(200);
  b.set([0x52, 0x49, 0x46, 0x46], 0); b.set([0x57, 0x45, 0x42, 0x50], 8); b.set([0x56, 0x50, 0x38, 0x4c], 12);
  b[20] = 0x2f;
  const bits = 31 | (31 << 14);
  new DataView(b.buffer).setUint32(21, bits, true);
  return b;
}
async function put(c: Client, path: string, body: Uint8Array, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(new Request(`${ORIGIN}/api${path}`, { method: 'PUT', headers: { Origin: ORIGIN, 'X-Arai-CSRF': '1', Cookie: c.cookie, 'Content-Type': 'application/octet-stream', ...headers }, body }));
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

describe('remembered devices', () => {
  it('gives each session one stable device secret that dies with the session', async () => {
    const { c } = await registered('dv_user');
    const a = (await c.call('POST', '/auth/device-secret')).json.secret;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await c.call('POST', '/auth/device-secret')).json.secret).toBe(a);
    await c.call('POST', '/auth/logout');
    expect((await c.call('POST', '/auth/device-secret')).status).toBe(401);
  });
});

describe('artwork', () => {
  it('stores encrypted art for members; a plain copy only while public', async () => {
    const { c } = await registered('art_owner');
    const { c: out } = await registered('art_out');
    const id = (await c.call('POST', '/projects', { id: pid(), visibility: 'private', encMeta: blob(), grant: { wrappedKey: rand(80), signature: rand(64) } })).json.project.id;
    const enc = crypto.getRandomValues(new Uint8Array(1000));
    expect((await put(c, `/projects/${id}/art`, enc, { 'X-Key-Version': '2' })).status).toBe(409);
    expect((await put(c, `/projects/${id}/art`, new Uint8Array(10), { 'X-Key-Version': '1' })).status).toBe(400);
    expect((await put(out, `/projects/${id}/art`, enc, { 'X-Key-Version': '1' })).status).toBe(404);
    expect((await put(c, `/projects/${id}/art`, enc, { 'X-Key-Version': '1' })).status).toBe(200);
    expect((await c.call('GET', `/projects/${id}`)).json.project.art.keyVersion).toBe(1);
    const got = await exports.default.fetch(new Request(`${ORIGIN}/api/projects/${id}/art`, { headers: { Cookie: c.cookie } }));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(enc);
    expect((await exports.default.fetch(new Request(`${ORIGIN}/api/projects/${id}/art`, { headers: { Cookie: out.cookie } }))).status).toBe(404);
    // Public copy needs a public project and a real image.
    expect((await put(c, `/projects/${id}/art/public`, webp())).status).toBe(409);
    await c.call('PATCH', `/projects/${id}`, { visibility: 'public', publicMeta: { name: 'Cover Test', description: '', genre: '', tags: [] } });
    expect((await put(c, `/projects/${id}/art/public`, new TextEncoder().encode('<svg onload=alert(1)>'.padEnd(100)))).status).toBe(400);
    expect((await put(c, `/projects/${id}/art/public`, webp())).status).toBe(200);
    const pub = await exports.default.fetch(new Request(`${ORIGIN}/api/public/projects/${id}/art`));
    expect(pub.headers.get('Content-Type')).toBe('image/webp');
    expect((await new Client().call('GET', '/profiles/art_owner')).json.profile.projects[0].art).toBeTruthy();
    // Going private removes the plain copy at once.
    await c.call('PATCH', `/projects/${id}`, { visibility: 'private', publicMeta: null });
    expect((await exports.default.fetch(new Request(`${ORIGIN}/api/public/projects/${id}/art`))).status).toBe(404);
  });
});
