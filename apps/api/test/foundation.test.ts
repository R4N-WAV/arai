import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from '../src/lib/audit.js';

const ORIGIN = 'https://arai.test';
const fetchApi = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${ORIGIN}${path}`, init));

describe('HTTP foundation', () => {
  it('serves health with strict security headers', async () => {
    const res = await fetchApi('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects cross-origin and header-less state-changing requests (CSRF)', async () => {
    const cross = await fetchApi('/api/anything', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Arai-CSRF': '1' } });
    expect(cross.status).toBe(403);
    const noHeader = await fetchApi('/api/anything', { method: 'POST', headers: { Origin: ORIGIN } });
    expect(noHeader.status).toBe(403);
    const ok = await fetchApi('/api/anything', { method: 'POST', headers: { Origin: ORIGIN, 'X-Arai-CSRF': '1' } });
    expect(ok.status).toBe(404); // passes the guard, no such route
  });

  it('enforces request size limits', async () => {
    const res = await fetchApi('/api/anything', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-Arai-CSRF': '1', 'Content-Type': 'application/json' },
      body: 'x'.repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it('returns opaque JSON 404s', async () => {
    const res = await fetchApi('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('schema constraints', () => {
  const insertUser = (id: string, username: string, email: string) =>
    env.DB.prepare('INSERT INTO users (id, username, email_normalized, created_at) VALUES (?, ?, ?, ?)').bind(id, username, email, Date.now()).run();

  it('enforces case-insensitive unique usernames in the database', async () => {
    await insertUser('u1', 'Producer', 'a@example.com');
    await expect(insertUser('u2', 'producer', 'b@example.com')).rejects.toThrow(/UNIQUE/);
  });

  it('enforces unique emails only once verified (unverified emails cannot be squatted)', async () => {
    await insertUser('e1', 'claimer1', 'same@example.com');
    await insertUser('e2', 'claimer2', 'same@example.com'); // both unverified: allowed
    const verify = (id: string) => env.DB.prepare('UPDATE users SET email_verified_at = 1 WHERE id = ?').bind(id).run();
    await verify('e1');
    await expect(verify('e2')).rejects.toThrow(/UNIQUE/);
  });

  it('rejects invalid usernames at the database level', async () => {
    await expect(insertUser('u4', 'ab', 'c@example.com')).rejects.toThrow(/CHECK/);
    await expect(insertUser('u5', 'bad name!', 'd@example.com')).rejects.toThrow(/CHECK/);
  });

  it('allows only one platform owner', async () => {
    await insertUser('o1', 'owner1', 'o1@example.com');
    await insertUser('o2', 'owner2', 'o2@example.com');
    const grant = (id: string) => env.DB.prepare("INSERT INTO platform_roles (user_id, role, granted_at) VALUES (?, 'owner', ?)").bind(id, Date.now()).run();
    await grant('o1');
    await expect(grant('o2')).rejects.toThrow(/UNIQUE/);
  });
});

describe('audit log', () => {
  it('builds a verifiable hash chain', async () => {
    await appendAudit(env.DB, { actorId: null, action: 'admin.bootstrap', target: 'user:x' });
    await appendAudit(env.DB, { actorId: 'x', action: 'user.suspend', target: 'user:y', details: { reason: 'spam' } });
    expect(await verifyAuditChain(env.DB)).toBeNull();
  });

  it('blocks UPDATE and DELETE at the database level', async () => {
    await appendAudit(env.DB, { actorId: null, action: 'test' });
    await expect(env.DB.prepare("UPDATE audit_log SET action = 'forged'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
  });

  it('detects a forged row inserted out of chain', async () => {
    await appendAudit(env.DB, { actorId: null, action: 'a' });
    await env.DB.prepare("INSERT INTO audit_log (at, actor_id, action, prev_hash, hash) VALUES (1, NULL, 'forged', 'x', 'y')").run();
    expect(await verifyAuditChain(env.DB)).not.toBeNull();
  });
});
