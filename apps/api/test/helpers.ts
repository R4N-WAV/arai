import { CURRENT_KDF } from '@arai/shared';
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';

export const ORIGIN = 'https://arai.test';
let ipCounter = 0;
export const rand = (n = 32) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const blob = () => rand(80);

export class Client {
  cookie = '';
  ip = `198.51.100.${++ipCounter}`;
  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { Origin: ORIGIN, 'X-Arai-CSRF': '1', 'CF-Connecting-IP': this.ip, 'User-Agent': 'Mozilla/5.0 (X11; Linux) Firefox/140.0' };
    if (body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      if (this.cookie) headers.Cookie = this.cookie;
      const res = await exports.default.fetch(new Request(`${ORIGIN}/api${path}`, { method, headers, body }));
      return { status: res.status, json: (await res.json().catch(() => ({}))) as any, setCookie: null as string | null };
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const m = /__Host-arai_s=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `__Host-arai_s=${m[1]}` : '';
    }
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any, setCookie: set };
  }
}

export function registration(username: string, email = `${username.toLowerCase()}@example.com`) {
  return {
    username,
    email,
    saltUsername: rand(16),
    saltEmail: rand(16),
    kdf: CURRENT_KDF,
    authKeyUsername: rand(),
    authKeyEmail: rand(),
    recoveryAuthKey: rand(),
    vault: { encAskUsername: blob(), encAskEmail: blob(), encAskRecovery: blob(), encPrivateKeys: blob() },
    publicKeys: { x25519: rand(), ed25519: rand() },
  };
}

export async function registered(username: string) {
  const c = new Client();
  const reg = registration(username);
  const r = await c.call('POST', '/auth/register', reg);
  expect(r.status).toBe(201);
  return { c, reg };
}


export const pid = () => Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');
export async function newProject(c: Client) {
  const r = await c.call('POST', '/projects', { id: pid(), visibility: 'private', encMeta: blob(), grant: { wrappedKey: rand(80), signature: rand(64) } });
  return r.json.project.id as string;
}
