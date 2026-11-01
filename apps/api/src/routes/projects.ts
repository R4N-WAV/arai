import { createProjectRequest, updateProjectRequest, type ProjectDto } from '@arai/shared';
import { Hono } from 'hono';
import { fromB64, toB64 } from '../lib/crypto.js';
import { requireProjectRole } from '../lib/projects.js';
import { purgeFiles } from './tracks.js';
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
  wrapped_key: ArrayBuffer | null;
  grant_sig: ArrayBuffer | null;
  granted_by: string | null;
  granter_sign_key: ArrayBuffer | null;
  created_at: number;
  updated_at: number;
}

// Membership-scoped query: a project is only ever returned to its members.
const SELECT = `SELECT p.id, m.role, p.visibility, p.key_version, p.enc_meta, p.public_meta, p.created_at, p.updated_at,
    k.wrapped_key, k.grant_sig, k.granted_by,
    (SELECT uk.ed25519_pub FROM user_keys uk WHERE uk.user_id = k.granted_by AND uk.revoked_at IS NULL ORDER BY uk.created_at DESC LIMIT 1) AS granter_sign_key
  FROM project_members m
  JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL
  LEFT JOIN project_keys k ON k.project_id = p.id AND k.key_version = p.key_version AND k.user_id = m.user_id
  WHERE m.user_id = ? AND m.revoked_at IS NULL`;

function dto(r: Row): ProjectDto {
  return {
    id: r.id,
    role: r.role,
    visibility: r.visibility,
    keyVersion: r.key_version,
    encMeta: toB64(r.enc_meta),
    publicMeta: r.public_meta ? JSON.parse(r.public_meta) : null,
    grant:
      r.wrapped_key && r.grant_sig && r.granted_by && r.granter_sign_key
        ? { wrappedKey: toB64(r.wrapped_key), signature: toB64(r.grant_sig), grantedBy: r.granted_by, granterSignKey: toB64(r.granter_sign_key) }
        : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const notFound = { error: 'not_found' } as const;

projects.get('/projects', async (c) => {
  const { results } = await c.env.DB.prepare(`${SELECT} ORDER BY p.updated_at DESC LIMIT 1000`).bind(c.get('session').user_id).all<Row>();
  return c.json({ projects: results.map(dto) });
});

projects.get('/projects/:id', async (c) => {
  const row = await c.env.DB.prepare(`${SELECT} AND p.id = ?`).bind(c.get('session').user_id, c.req.param('id')).first<Row>();
  return row ? c.json({ project: dto(row) }) : c.json(notFound, 404);
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
      c.env.DB.prepare(`INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)`).bind(body.id, userId, userId, now),
      c.env.DB.prepare(
        `INSERT INTO project_keys (project_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      ).bind(body.id, userId, fromB64(body.grant.wrappedKey), userId, fromB64(body.grant.signature), now),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  const row = await c.env.DB.prepare(`${SELECT} AND p.id = ?`).bind(userId, body.id).first<Row>();
  return c.json({ project: dto(row!) }, 201);
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
  const row = await c.env.DB.prepare(`${SELECT} AND p.id = ?`).bind(userId, id).first<Row>();
  return c.json({ project: dto(row!) });
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
  await c.env.DB.prepare("UPDATE projects SET deleted_at = ?, visibility = 'private', public_meta = NULL, published_at = NULL WHERE id = ?").bind(Date.now(), id).run();
  const files = await c.env.DB.prepare("SELECT id FROM files WHERE project_id = ? AND status != 'deleted'").bind(id).all<{ id: string }>();
  await purgeFiles(c.env, c.executionCtx, id, files.results.map((f) => f.id));
  return c.json({ ok: true });
});

export default projects;
