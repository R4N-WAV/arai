import { createProjectRequest, updateProjectRequest, type ProjectDto } from '@arai/shared';
import { Hono } from 'hono';
import { fromB64, toB64 } from '../lib/crypto.js';
import { requireProjectRole } from '../lib/projects.js';
import { purgeFiles } from './tracks.js';
import { reindexProject } from './social.js';
import { inspectImage } from '../lib/images.js';
import { rateLimit } from '../lib/ratelimit.js';
import { requireUser, type AuthedBindings } from '../lib/session.js';
import { parseBody } from '../lib/validate.js';

const MAX_OWNED = 500;
const projects = new Hono<AuthedBindings>();
projects.use('/projects', requireUser);
projects.use('/projects/*', requireUser);

interface Row {
  id: string;
  role: ProjectDto['role'];
  visibility: ProjectDto['visibility'];
  key_version: number;
  enc_meta: ArrayBuffer;
  public_meta: string | null;
  rotation_due: number;
  art_at: number | null;
  art_key_version: number | null;
  accepted_at: number | null;
  invited_by: string | null;
  created_at: number;
  updated_at: number;
}
interface KeyRow {
  project_id: string;
  key_version: number;
  wrapped_key: ArrayBuffer;
  grant_sig: ArrayBuffer;
  granted_by: string;
  granter_sign_key: ArrayBuffer | null;
}

// Membership-scoped query: a project is only ever returned to its members.
const SELECT = `SELECT p.id, m.role, p.visibility, p.key_version, p.enc_meta, p.public_meta, p.rotation_due, p.created_at, p.updated_at,
    (SELECT updated_at FROM project_art WHERE project_id = p.id) AS art_at, (SELECT key_version FROM project_art WHERE project_id = p.id) AS art_key_version,
    m.accepted_at, (SELECT u.username FROM users u WHERE u.id = m.added_by) AS invited_by
  FROM project_members m
  JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL
  WHERE m.user_id = ? AND m.revoked_at IS NULL`;
export const ACCEPTED = ' AND m.accepted_at IS NOT NULL';

/** Loads the caller's keyring for the given project rows and builds DTOs. */
export async function projectDtos(db: D1Database, userId: string, rows: Row[]): Promise<ProjectDto[]> {
  if (rows.length === 0) return [];
  const keys = new Map<string, KeyRow[]>();
  // D1 caps bound parameters; fetch keyrings in slices.
  for (let i = 0; i < rows.length; i += 80) {
    const ids = rows.slice(i, i + 80).map((r) => r.id);
    const { results } = await db
      .prepare(
        `SELECT k.project_id, k.key_version, k.wrapped_key, k.grant_sig, k.granted_by,
           (SELECT uk.ed25519_pub FROM user_keys uk WHERE uk.user_id = k.granted_by AND uk.revoked_at IS NULL ORDER BY uk.created_at DESC LIMIT 1) AS granter_sign_key
         FROM project_keys k WHERE k.user_id = ? AND k.project_id IN (${ids.map(() => '?').join(',')}) ORDER BY k.key_version`,
      )
      .bind(userId, ...ids)
      .all<KeyRow>();
    for (const k of results) keys.set(k.project_id, [...(keys.get(k.project_id) ?? []), k]);
  }
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    visibility: r.visibility,
    keyVersion: r.key_version,
    encMeta: toB64(r.enc_meta),
    publicMeta: r.public_meta ? JSON.parse(r.public_meta) : null,
    grants: (keys.get(r.id) ?? [])
      .filter((k) => k.granter_sign_key)
      .map((k) => ({ keyVersion: k.key_version, wrappedKey: toB64(k.wrapped_key), signature: toB64(k.grant_sig), grantedBy: k.granted_by, granterSignKey: toB64(k.granter_sign_key!) })),
    rotationDue: r.rotation_due === 1,
    art: r.art_at && r.art_key_version ? { at: r.art_at, keyVersion: r.art_key_version } : null,
    ...(r.accepted_at === null && r.invited_by ? { invitedBy: r.invited_by } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function one(db: D1Database, userId: string, id: string): Promise<ProjectDto | null> {
  const row = await db.prepare(`${SELECT}${ACCEPTED} AND p.id = ?`).bind(userId, id).first<Row>();
  return row ? (await projectDtos(db, userId, [row]))[0]! : null;
}
export { SELECT as PROJECT_SELECT, type Row as ProjectRow };

const notFound = { error: 'not_found' } as const;

projects.get('/projects', async (c) => {
  const userId = c.get('session').user_id;
  const { results } = await c.env.DB.prepare(`${SELECT}${ACCEPTED} ORDER BY p.updated_at DESC LIMIT 1000`).bind(userId).all<Row>();
  return c.json({ projects: await projectDtos(c.env.DB, userId, results) });
});

projects.get('/projects/:id', async (c) => {
  const project = await one(c.env.DB, c.get('session').user_id, c.req.param('id'));
  return project ? c.json({ project }) : c.json(notFound, 404);
});

projects.post('/projects', async (c) => {
  const body = await parseBody(c, createProjectRequest);
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  const userId = c.get('session').user_id;
  if (!(await rateLimit(c.env.DB, `project-create:${userId}`, 60, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const owned = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ? AND deleted_at IS NULL').bind(userId).first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_OWNED) return c.json({ error: 'project_limit' }, 409);

  const now = Date.now();
  const pub = body.publicMeta ? JSON.stringify(body.publicMeta) : null;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO projects (id, owner_id, visibility, key_version, enc_meta, public_meta, created_at, updated_at, published_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(body.id, userId, body.visibility, fromB64(body.encMeta), pub, now, now, pub ? now : null),
      c.env.DB.prepare(`INSERT INTO project_members (project_id, user_id, role, added_by, created_at, accepted_at) VALUES (?, ?, 'owner', ?, ?, ?)`).bind(body.id, userId, userId, now, now),
      c.env.DB.prepare(
        `INSERT INTO project_keys (project_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      ).bind(body.id, userId, fromB64(body.grant.wrappedKey), userId, fromB64(body.grant.signature), now),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  if (pub) await reindexProject(c.env.DB, body.id);
  return c.json({ project: await one(c.env.DB, userId, body.id) }, 201);
});

projects.patch('/projects/:id', async (c) => {
  const body = await parseBody(c, updateProjectRequest);
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  const id = c.req.param('id');
  const userId = c.get('session').user_id;
  // Changing who can see the project needs admin; editing metadata needs editor.
  const min = body.visibility !== undefined ? 'admin' : 'editor';
  const member = await requireProjectRole(c.env.DB, id, userId, min);
  if (!member) {
    // Members who lack the role get 403; outsiders get 404 (no existence leak).
    const any = await requireProjectRole(c.env.DB, id, userId, 'listener');
    return any ? c.json({ error: 'forbidden' }, 403) : c.json(notFound, 404);
  }
  // Restricted accounts keep their private work but cannot publish.
  if (body.visibility === 'public' && c.get('session').status === 'restricted') return c.json({ error: 'account_restricted' }, 403);
  const current = await c.env.DB.prepare('SELECT visibility FROM projects WHERE id = ?').bind(id).first<{ visibility: string }>();
  const nextVis = body.visibility ?? current!.visibility;
  if (body.visibility === undefined && body.publicMeta !== undefined && (current!.visibility === 'public') !== (body.publicMeta !== null)) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const args: unknown[] = [now];
  if (body.encMeta !== undefined) {
    sets.push('enc_meta = ?');
    args.push(fromB64(body.encMeta));
  }
  if (body.publicMeta !== undefined) {
    sets.push('public_meta = ?');
    args.push(body.publicMeta ? JSON.stringify(body.publicMeta) : null);
  }
  if (body.visibility !== undefined) {
    sets.push('visibility = ?', 'published_at = ?');
    args.push(nextVis, nextVis === 'public' ? now : null);
  }
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
  // Going private withdraws the public listening link straight away.
  if (nextVis === 'private') {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND is_public = 1 AND revoked_at IS NULL').bind(now, id),
      c.env.DB.prepare('UPDATE project_art SET public_data = NULL, public_mime = NULL WHERE project_id = ?').bind(id),
    ]);
  }
  await reindexProject(c.env.DB, id);
  return c.json({ project: await one(c.env.DB, userId, id) });
});

projects.delete('/projects/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('session').user_id;
  const member = await requireProjectRole(c.env.DB, id, userId, 'owner');
  if (!member) {
    const any = await requireProjectRole(c.env.DB, id, userId, 'listener');
    return any ? c.json({ error: 'forbidden' }, 403) : c.json(notFound, 404);
  }
  // Soft delete: hidden everywhere immediately; public copy withdrawn.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE projects SET deleted_at = ?, visibility = 'private', public_meta = NULL, published_at = NULL WHERE id = ?").bind(Date.now(), id),
    c.env.DB.prepare('UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL').bind(Date.now(), id),
  ]);
  await reindexProject(c.env.DB, id);
  const files = await c.env.DB.prepare("SELECT id FROM files WHERE project_id = ? AND status != 'deleted'").bind(id).all<{ id: string }>();
  await purgeFiles(c.env, c.executionCtx, id, files.results.map((f) => f.id));
  return c.json({ ok: true });
});

// ---- artwork ------------------------------------------------------------------

const MAX_ART = 600 * 1024;

projects.put('/projects/:id/art', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('session').user_id;
  if (!(await requireProjectRole(c.env.DB, id, userId, 'editor'))) {
    const any = await requireProjectRole(c.env.DB, id, userId, 'listener');
    return any ? c.json({ error: 'forbidden' }, 403) : c.json(notFound, 404);
  }
  const kv = Number(c.req.header('X-Key-Version'));
  const p = await c.env.DB.prepare('SELECT key_version FROM projects WHERE id = ?').bind(id).first<{ key_version: number }>();
  if (kv !== p!.key_version) return c.json({ error: 'stale_key' }, 409);
  const data = new Uint8Array(await c.req.arrayBuffer());
  // Ciphertext: XChaCha20-Poly1305 blob (24-byte nonce + 16-byte tag at least).
  if (data.byteLength < 64 || data.byteLength > MAX_ART) return c.json({ error: 'invalid_image' }, 400);
  if (!(await rateLimit(c.env.DB, `art:${userId}`, 60, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO project_art (project_id, key_version, enc_data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET key_version = excluded.key_version, enc_data = excluded.enc_data, public_data = NULL, public_mime = NULL, updated_at = excluded.updated_at',
    ).bind(id, kv, data, now),
    c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, id),
  ]);
  return c.json({ art: { at: now, keyVersion: kv } });
});

/** Plain copy for a public project (shown on profiles, Discover and the listen page). */
projects.put('/projects/:id/art/public', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('session').user_id;
  if (!(await requireProjectRole(c.env.DB, id, userId, 'editor'))) return c.json(notFound, 404);
  const p = await c.env.DB.prepare('SELECT visibility FROM projects WHERE id = ?').bind(id).first<{ visibility: string }>();
  if (p?.visibility !== 'public') return c.json({ error: 'not_public' }, 409);
  const data = new Uint8Array(await c.req.arrayBuffer());
  const info = data.byteLength <= MAX_ART ? inspectImage(data) : null;
  if (!info || info.width > 2000 || info.height > 2000 || info.width < 16 || info.height < 16) return c.json({ error: 'invalid_image' }, 400);
  const res = await c.env.DB.prepare('UPDATE project_art SET public_data = ?, public_mime = ? WHERE project_id = ?').bind(data, info.mime, id).run();
  if (!res.meta.changes) return c.json({ error: 'no_art' }, 409);
  return c.json({ ok: true });
});

projects.get('/projects/:id/art', async (c) => {
  const id = c.req.param('id');
  if (!(await requireProjectRole(c.env.DB, id, c.get('session').user_id, 'listener'))) return c.json(notFound, 404);
  const row = await c.env.DB.prepare('SELECT enc_data, key_version FROM project_art WHERE project_id = ?').bind(id).first<{ enc_data: ArrayBuffer | number[]; key_version: number }>();
  if (!row) return c.json(notFound, 404);
  return new Response(new Uint8Array(row.enc_data as ArrayLike<number>), { headers: { 'Content-Type': 'application/octet-stream', 'X-Key-Version': String(row.key_version), 'Cache-Control': 'private, no-cache' } });
});

projects.delete('/projects/:id/art', async (c) => {
  const id = c.req.param('id');
  if (!(await requireProjectRole(c.env.DB, id, c.get('session').user_id, 'editor'))) return c.json(notFound, 404);
  await c.env.DB.prepare('DELETE FROM project_art WHERE project_id = ?').bind(id).run();
  return c.json({ ok: true });
});

export default projects;
