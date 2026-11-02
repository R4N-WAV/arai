/**
 * Collaboration: members & invitations, key rotation, comments, share links
 * and public listening. The server only ever handles ciphertext, sealed key
 * grants and SHA-256 hashes of share tokens; every key is made client-side.
 */
import {
  createCommentRequest,
  createShareRequest,
  guestCommentRequest,
  inviteRequest,
  openShareRequest,
  roleRequest,
  rotateRequest,
  updateCommentRequest,
  updateShareRequest,
  roleRank,
  type CommentDto,
  type MemberDto,
  type Role,
  type ShareDto,
  type UserKeysDto,
} from '@arai/shared';
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env.js';
import { appendAudit } from '../lib/audit.js';
import { fromB64, ipHmac, requireSecret, sha256, timingSafeEqual, toB64 } from '../lib/crypto.js';
import { requireProjectRole } from '../lib/projects.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, requireUser, type AuthedBindings } from '../lib/session.js';
import { parseBody } from '../lib/validate.js';
import { ACCEPTED, PROJECT_SELECT, projectDtos, type ProjectRow } from './projects.js';
import { notify } from './social.js';
import { countPlay } from './tracks.js';

const collab = new Hono<AuthedBindings>();
for (const p of ['/users/lookup/*', '/projects/:id/members', '/projects/:id/members/*', '/projects/:id/rotate', '/invites', '/invites/*', '/versions/*', '/comments/*', '/projects/:id/shares', '/projects/:id/shares/*']) {
  collab.use(p, requireUser);
}

const bad = (c: Context) => c.json({ error: 'invalid_request' }, 400);
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);
const forbidden = (c: Context) => c.json({ error: 'forbidden' }, 403);

async function gate(c: Context<AuthedBindings>, projectId: string, min: Role) {
  const userId = c.get('session').user_id;
  const m = await requireProjectRole(c.env.DB, projectId, userId, min);
  if (m) return { ok: true as const, role: m.role };
  const any = min === 'listener' ? null : await requireProjectRole(c.env.DB, projectId, userId, 'listener');
  return { ok: false as const, res: any ? forbidden(c) : notFound(c) };
}

interface KeyUserRow {
  id: string;
  username: string;
  display_name: string | null;
  x25519_pub: ArrayBuffer;
  ed25519_pub: ArrayBuffer;
}
const USER_KEYS = `SELECT u.id, u.username, pr.display_name,
    k.x25519_pub, k.ed25519_pub
  FROM users u
  JOIN user_keys k ON k.id = (SELECT id FROM user_keys WHERE user_id = u.id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)
  LEFT JOIN profiles pr ON pr.user_id = u.id`;
const keysDto = (r: KeyUserRow): UserKeysDto => ({ id: r.id, username: r.username, displayName: r.display_name ?? '', boxKey: toB64(r.x25519_pub), signKey: toB64(r.ed25519_pub) });

// ---- people -------------------------------------------------------------------

collab.get('/users/lookup/:username', async (c) => {
  const userId = c.get('session').user_id;
  if (!(await rateLimit(c.env.DB, `lookup:${userId}`, 120, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const row = await c.env.DB.prepare(`${USER_KEYS} WHERE u.username = ? AND u.status = 'active' AND u.deleted_at IS NULL`).bind(c.req.param('username')).first<KeyUserRow>();
  if (!row) return notFound(c);
  // Respect blocks in both directions.
  const blocked = await c.env.DB.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').bind(userId, row.id, row.id, userId).first();
  if (blocked) return notFound(c);
  return c.json({ user: keysDto(row) });
});

// ---- members & invitations ----------------------------------------------------

collab.get('/projects/:id/members', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'listener');
  if (!g.ok) return g.res;
  const { results } = await c.env.DB.prepare(
    `${USER_KEYS} JOIN project_members m ON m.user_id = u.id AND m.project_id = ? AND m.revoked_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, m.created_at`.replace('SELECT u.id', 'SELECT m.role, m.accepted_at, m.created_at, u.id'),
  )
    .bind(id)
    .all<KeyUserRow & { role: MemberDto['role']; accepted_at: number | null; created_at: number }>();
  const members: MemberDto[] = results.map((r) => ({ ...keysDto(r), role: r.role, pending: r.accepted_at === null, createdAt: r.created_at }));
  return c.json({ members });
});

collab.post('/projects/:id/members', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'admin');
  if (!g.ok) return g.res;
  const body = await parseBody(c, inviteRequest);
  if (!body) return bad(c);
  const me = c.get('session').user_id;
  if (body.role === 'admin' && g.role !== 'owner') return forbidden(c);
  if (!(await rateLimit(c.env.DB, `invite:${me}`, 100, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const project = await c.env.DB.prepare('SELECT key_version FROM projects WHERE id = ?').bind(id).first<{ key_version: number }>();
  const versions = new Set(body.grants.map((x) => x.keyVersion));
  // The invitee must receive every key version, exactly once each.
  if (versions.size !== body.grants.length || versions.size !== project!.key_version || [...versions].some((v) => v < 1 || v > project!.key_version)) {
    return c.json({ error: 'grants_incomplete' }, 409);
  }
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").bind(body.userId).first<{ id: string }>();
  if (!target) return notFound(c);
  const blocked = await c.env.DB.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').bind(me, body.userId, body.userId, me).first();
  if (blocked) return notFound(c);
  const existing = await c.env.DB.prepare('SELECT role, revoked_at FROM project_members WHERE project_id = ? AND user_id = ?').bind(id, body.userId).first<{ role: string; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) return c.json({ error: 'already_member' }, 409);
  const now = Date.now();
  await c.env.DB.batch([
    existing
      ? c.env.DB.prepare('UPDATE project_members SET role = ?, added_by = ?, created_at = ?, revoked_at = NULL, accepted_at = NULL WHERE project_id = ? AND user_id = ?').bind(body.role, me, now, id, body.userId)
      : c.env.DB.prepare('INSERT INTO project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, body.userId, body.role, me, now),
    c.env.DB.prepare('DELETE FROM project_keys WHERE project_id = ? AND user_id = ?').bind(id, body.userId),
    ...body.grants.map((x) =>
      c.env.DB.prepare('INSERT INTO project_keys (project_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        id, x.keyVersion, body.userId, fromB64(x.wrappedKey), me, fromB64(x.signature), now,
      ),
    ),
  ]);
  await appendAudit(c.env.DB, { actorId: me, action: 'project.invite', target: id, details: { userId: body.userId, role: body.role } });
  await notify(c.env.DB, body.userId, 'invite', me, id, c.var.wake);
  return c.json({ ok: true }, 201);
});

collab.patch('/projects/:id/members/:userId', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'admin');
  if (!g.ok) return g.res;
  const body = await parseBody(c, roleRequest);
  if (!body) return bad(c);
  const m = await c.env.DB.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL').bind(id, c.req.param('userId')).first<{ role: Role }>();
  if (!m) return notFound(c);
  // Only the owner touches admins; nobody changes the owner.
  if (m.role === 'owner' || ((m.role === 'admin' || body.role === 'admin') && g.role !== 'owner')) return forbidden(c);
  await c.env.DB.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').bind(body.role, id, c.req.param('userId')).run();
  await appendAudit(c.env.DB, { actorId: c.get('session').user_id, action: 'project.role', target: id, details: { userId: c.req.param('userId'), role: body.role } });
  return c.json({ ok: true });
});

/** Remove a member (admin), decline an invitation or leave (self). */
collab.delete('/projects/:id/members/:userId', async (c) => {
  const id = c.req.param('id');
  const me = c.get('session').user_id;
  const targetId = c.req.param('userId') === 'me' ? me : c.req.param('userId');
  const target = await c.env.DB.prepare(
    'SELECT m.role FROM project_members m JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL WHERE m.project_id = ? AND m.user_id = ? AND m.revoked_at IS NULL',
  )
    .bind(id, targetId)
    .first<{ role: Role }>();
  if (!target) return notFound(c);
  if (target.role === 'owner') return forbidden(c);
  if (targetId !== me) {
    const g = await gate(c, id, 'admin');
    if (!g.ok) return g.res;
    if (target.role === 'admin' && g.role !== 'owner') return forbidden(c);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE project_members SET revoked_at = ? WHERE project_id = ? AND user_id = ?').bind(now, id, targetId),
    c.env.DB.prepare('DELETE FROM project_keys WHERE project_id = ? AND user_id = ?').bind(id, targetId),
    // They held the key: the next admin client rotates it.
    c.env.DB.prepare('UPDATE projects SET rotation_due = 1 WHERE id = ?').bind(id),
  ]);
  await appendAudit(c.env.DB, { actorId: me, action: targetId === me ? 'project.leave' : 'project.remove_member', target: id, details: { userId: targetId } });
  return c.json({ ok: true });
});

collab.post('/projects/:id/rotate', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'admin');
  if (!g.ok) return g.res;
  const body = await parseBody(c, rotateRequest);
  if (!body) return bad(c);
  const p = await c.env.DB.prepare('SELECT key_version FROM projects WHERE id = ?').bind(id).first<{ key_version: number }>();
  if (body.keyVersion !== p!.key_version + 1) return c.json({ error: 'stale_key' }, 409);
  const { results } = await c.env.DB.prepare('SELECT user_id FROM project_members WHERE project_id = ? AND revoked_at IS NULL').bind(id).all<{ user_id: string }>();
  const want = new Set(results.map((r) => r.user_id));
  const got = new Set(body.grants.map((x) => x.userId));
  // Exactly the current members (accepted or invited), nobody else.
  if (got.size !== body.grants.length || got.size !== want.size || [...got].some((u) => !want.has(u))) return c.json({ error: 'members_changed' }, 409);
  const me = c.get('session').user_id;
  const now = Date.now();
  try {
    await c.env.DB.batch([
      // Guarded on the old version so two concurrent rotations cannot both win.
      c.env.DB.prepare('UPDATE projects SET key_version = ?, enc_meta = ?, rotation_due = 0, updated_at = ? WHERE id = ? AND key_version = ?').bind(body.keyVersion, fromB64(body.encMeta), now, id, body.keyVersion - 1),
      ...body.grants.map((x) =>
        c.env.DB.prepare('INSERT INTO project_keys (project_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
          id, body.keyVersion, x.userId, fromB64(x.wrappedKey), me, fromB64(x.signature), now,
        ),
      ),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'stale_key' }, 409);
    throw e;
  }
  await appendAudit(c.env.DB, { actorId: me, action: 'project.rotate_key', target: id, details: { keyVersion: body.keyVersion } });
  return c.json({ ok: true });
});

collab.get('/invites', async (c) => {
  const userId = c.get('session').user_id;
  const { results } = await c.env.DB.prepare(`${PROJECT_SELECT} AND m.accepted_at IS NULL ORDER BY m.created_at DESC LIMIT 100`).bind(userId).all<ProjectRow>();
  return c.json({ invites: await projectDtos(c.env.DB, userId, results) });
});

collab.post('/invites/:id/accept', async (c) => {
  const userId = c.get('session').user_id;
  const res = await c.env.DB.prepare(
    'UPDATE project_members SET accepted_at = ? WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL)',
  )
    .bind(Date.now(), c.req.param('id'), userId, c.req.param('id'))
    .run();
  if (!res.meta.changes) return notFound(c);
  const row = await c.env.DB.prepare(`${PROJECT_SELECT}${ACCEPTED} AND p.id = ?`).bind(userId, c.req.param('id')).first<ProjectRow>();
  return c.json({ project: (await projectDtos(c.env.DB, userId, [row!]))[0] });
});

// ---- comments -------------------------------------------------------------------

async function versionProject(db: D1Database, versionId: string): Promise<string | null> {
  const r = await db
    .prepare('SELECT t.project_id FROM track_versions v JOIN tracks t ON t.id = v.track_id AND t.deleted_at IS NULL WHERE v.id = ?')
    .bind(versionId)
    .first<{ project_id: string }>();
  return r?.project_id ?? null;
}

interface CommentRow {
  id: string;
  version_id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  link_id: string | null;
  key_version: number | null;
  enc_body: ArrayBuffer | null;
  resolved_at: number | null;
  created_at: number;
  edited_at: number | null;
}
const COMMENTS = `SELECT c.id, c.version_id, c.parent_id, c.author_id, u.username AS author_name, c.link_id, c.key_version, c.enc_body, c.resolved_at, c.created_at, c.edited_at
  FROM comments c LEFT JOIN users u ON u.id = c.author_id`;
const commentDto = (r: CommentRow): CommentDto => ({
  id: r.id,
  versionId: r.version_id,
  parentId: r.parent_id,
  authorId: r.author_id,
  authorName: r.author_name,
  linkId: r.link_id,
  keyVersion: r.key_version,
  encBody: r.enc_body ? toB64(r.enc_body) : null,
  resolved: r.resolved_at !== null,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});

collab.get('/versions/:versionId/comments', async (c) => {
  const versionId = c.req.param('versionId');
  const projectId = await versionProject(c.env.DB, versionId);
  if (!projectId) return notFound(c);
  const g = await gate(c, projectId, 'listener');
  if (!g.ok) return g.res;
  const { results } = await c.env.DB.prepare(`${COMMENTS} WHERE c.version_id = ? ORDER BY c.created_at LIMIT 2000`).bind(versionId).all<CommentRow>();
  // Members read guest comments with the link key, which they hold sealed under the project key.
  const linkIds = [...new Set(results.flatMap((r) => (r.link_id ? [r.link_id] : [])))];
  const links: Record<string, { encSecret: string; keyVersion: number }> = {};
  for (const lid of linkIds) {
    const l = await c.env.DB.prepare('SELECT enc_secret, secret_key_version FROM share_links WHERE id = ? AND project_id = ?').bind(lid, projectId).first<{ enc_secret: ArrayBuffer; secret_key_version: number }>();
    if (l) links[lid] = { encSecret: toB64(l.enc_secret), keyVersion: l.secret_key_version };
  }
  return c.json({ comments: results.map(commentDto), links });
});

collab.post('/versions/:versionId/comments', async (c) => {
  const versionId = c.req.param('versionId');
  const projectId = await versionProject(c.env.DB, versionId);
  if (!projectId) return notFound(c);
  const g = await gate(c, projectId, 'listener');
  if (!g.ok) return g.res;
  const body = await parseBody(c, createCommentRequest);
  if (!body) return bad(c);
  const me = c.get('session').user_id;
  if (!(await rateLimit(c.env.DB, `comment:${me}`, 300, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const kv = await c.env.DB.prepare('SELECT key_version FROM projects WHERE id = ?').bind(projectId).first<{ key_version: number }>();
  if (body.keyVersion !== kv!.key_version) return c.json({ error: 'stale_key' }, 409);
  if (body.parentId) {
    const parent = await c.env.DB.prepare('SELECT parent_id FROM comments WHERE id = ? AND version_id = ?').bind(body.parentId, versionId).first<{ parent_id: string | null }>();
    // One level of replies keeps threads readable.
    if (!parent || parent.parent_id) return bad(c);
  }
  try {
    await c.env.DB.prepare('INSERT INTO comments (id, project_id, version_id, parent_id, author_id, key_version, enc_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(body.id, projectId, versionId, body.parentId ?? null, me, body.keyVersion, fromB64(body.encBody), Date.now())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  await notifyProject(c.env.DB, projectId, me, 'comment', c.var.wake);
  const row = await c.env.DB.prepare(`${COMMENTS} WHERE c.id = ?`).bind(body.id).first<CommentRow>();
  return c.json({ comment: commentDto(row!) }, 201);
});

async function notifyProject(db: D1Database, projectId: string, actor: string, kind: 'comment', wake?: string[]) {
  const { results } = await db.prepare('SELECT user_id FROM project_members WHERE project_id = ? AND revoked_at IS NULL AND accepted_at IS NOT NULL AND user_id != ? LIMIT 50').bind(projectId, actor).all<{ user_id: string }>();
  for (const r of results) await notify(db, r.user_id, kind, actor, projectId, wake);
}

collab.patch('/comments/:id', async (c) => {
  const body = await parseBody(c, updateCommentRequest);
  if (!body) return bad(c);
  const row = await c.env.DB.prepare('SELECT project_id, author_id, deleted_at FROM comments WHERE id = ?').bind(c.req.param('id')).first<{ project_id: string; author_id: string | null; deleted_at: number | null }>();
  if (!row || row.deleted_at) return notFound(c);
  const g = await gate(c, row.project_id, 'listener');
  if (!g.ok) return g.res;
  const me = c.get('session').user_id;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.encBody !== undefined) {
    if (row.author_id !== me) return forbidden(c);
    const kv = await c.env.DB.prepare('SELECT key_version FROM projects WHERE id = ?').bind(row.project_id).first<{ key_version: number }>();
    if (body.keyVersion !== kv!.key_version) return c.json({ error: 'stale_key' }, 409);
    sets.push('enc_body = ?', 'key_version = ?', 'edited_at = ?');
    args.push(fromB64(body.encBody), body.keyVersion, Date.now());
  }
  if (body.resolved !== undefined) {
    if (row.author_id !== me && roleRank(g.role) < roleRank('editor')) return forbidden(c);
    sets.push('resolved_at = ?', 'resolved_by = ?');
    args.push(body.resolved ? Date.now() : null, body.resolved ? me : null);
  }
  await c.env.DB.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?`).bind(...args, c.req.param('id')).run();
  const updated = await c.env.DB.prepare(`${COMMENTS} WHERE c.id = ?`).bind(c.req.param('id')).first<CommentRow>();
  return c.json({ comment: commentDto(updated!) });
});

collab.delete('/comments/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT project_id, author_id FROM comments WHERE id = ? AND deleted_at IS NULL').bind(c.req.param('id')).first<{ project_id: string; author_id: string | null }>();
  if (!row) return notFound(c);
  const g = await gate(c, row.project_id, 'listener');
  if (!g.ok) return g.res;
  if (row.author_id !== c.get('session').user_id && roleRank(g.role) < roleRank('admin')) return forbidden(c);
  // The text is erased; the row stays so replies keep their place.
  await c.env.DB.prepare('UPDATE comments SET enc_body = NULL, deleted_at = ? WHERE id = ?').bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- share links (members) -------------------------------------------------------

interface ShareRow {
  id: string;
  track_id: string | null;
  has_password: number;
  allow_download: number;
  allow_comments: number;
  is_public: number;
  expires_at: number | null;
  enc_secret: ArrayBuffer;
  secret_key_version: number;
  created_at: number;
}
const shareDto = (r: ShareRow): ShareDto => ({
  id: r.id,
  trackId: r.track_id,
  hasPassword: r.has_password === 1,
  allowDownload: r.allow_download === 1,
  allowComments: r.allow_comments === 1,
  isPublic: r.is_public === 1,
  expiresAt: r.expires_at,
  encSecret: toB64(r.enc_secret),
  keyVersion: r.secret_key_version,
  createdAt: r.created_at,
});

async function validFiles(db: D1Database, projectId: string, files: Array<{ fileId: string; versionId: string }>): Promise<boolean> {
  for (const f of files) {
    const ok = await db
      .prepare("SELECT 1 FROM track_versions v JOIN tracks t ON t.id = v.track_id AND t.deleted_at IS NULL JOIN files fi ON fi.id = v.file_id AND fi.status = 'ready' WHERE v.id = ? AND v.file_id = ? AND t.project_id = ?")
      .bind(f.versionId, f.fileId, projectId)
      .first();
    if (!ok) return false;
  }
  return true;
}

collab.get('/projects/:id/shares', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'editor');
  if (!g.ok) return g.res;
  const { results } = await c.env.DB.prepare(
    'SELECT id, track_id, has_password, allow_download, allow_comments, is_public, expires_at, enc_secret, secret_key_version, created_at FROM share_links WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
  )
    .bind(id)
    .all<ShareRow>();
  return c.json({ shares: results.map(shareDto) });
});

collab.post('/projects/:id/shares', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'editor');
  if (!g.ok) return g.res;
  const body = await parseBody(c, createShareRequest);
  if (!body) return bad(c);
  const me = c.get('session').user_id;
  if (c.get('session').status === 'restricted') return c.json({ error: 'account_restricted' }, 403);
  if (!(await rateLimit(c.env.DB, `share:${me}`, 60, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const p = await c.env.DB.prepare('SELECT key_version, visibility FROM projects WHERE id = ?').bind(id).first<{ key_version: number; visibility: string }>();
  if (body.keyVersion !== p!.key_version) return c.json({ error: 'stale_key' }, 409);
  const isPublic = body.publicSecret !== undefined;
  // The public listening link exists only for public projects and has no password or expiry.
  if (isPublic && (roleRank(g.role) < roleRank('admin') || p!.visibility !== 'public' || body.hasPassword || body.expiresAt || body.trackId)) return bad(c);
  if (body.trackId) {
    const t = await c.env.DB.prepare('SELECT 1 FROM tracks WHERE id = ? AND project_id = ? AND deleted_at IS NULL').bind(body.trackId, id).first();
    if (!t) return bad(c);
  }
  if (body.expiresAt !== null && body.expiresAt <= Date.now()) return bad(c);
  if (!(await validFiles(c.env.DB, id, body.files))) return bad(c);
  const now = Date.now();
  try {
    await c.env.DB.batch([
      ...(isPublic ? [c.env.DB.prepare('UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND is_public = 1 AND revoked_at IS NULL').bind(now, id)] : []),
      c.env.DB.prepare(
        `INSERT INTO share_links (id, project_id, track_id, created_by, token_hash, has_password, allow_download, allow_comments, enc_payload, enc_secret, secret_key_version, is_public, public_secret, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        body.id, id, body.trackId, me, fromB64(body.tokenHash), body.hasPassword ? 1 : 0, body.allowDownload ? 1 : 0, body.allowComments ? 1 : 0,
        fromB64(body.encPayload), fromB64(body.encSecret), body.keyVersion, isPublic ? 1 : 0, body.publicSecret ?? null, body.expiresAt, now, now,
      ),
      ...body.files.map((f) => c.env.DB.prepare('INSERT INTO share_link_files (link_id, file_id, version_id) VALUES (?, ?, ?)').bind(body.id, f.fileId, f.versionId)),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  await appendAudit(c.env.DB, { actorId: me, action: isPublic ? 'project.publish_audio' : 'share.create', target: id, details: { linkId: body.id } });
  const row = await c.env.DB.prepare('SELECT id, track_id, has_password, allow_download, allow_comments, is_public, expires_at, enc_secret, secret_key_version, created_at FROM share_links WHERE id = ?').bind(body.id).first<ShareRow>();
  return c.json({ share: shareDto(row!) }, 201);
});

/** Refresh a link's payload after tracks change (members re-encrypt it client-side). */
collab.put('/projects/:id/shares/:linkId', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'editor');
  if (!g.ok) return g.res;
  const body = await parseBody(c, updateShareRequest);
  if (!body) return bad(c);
  const link = await c.env.DB.prepare('SELECT id FROM share_links WHERE id = ? AND project_id = ? AND revoked_at IS NULL').bind(c.req.param('linkId'), id).first();
  if (!link) return notFound(c);
  if (!(await validFiles(c.env.DB, id, body.files))) return bad(c);
  const linkId = c.req.param('linkId');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE share_links SET enc_payload = ?, updated_at = ? WHERE id = ?').bind(fromB64(body.encPayload), Date.now(), linkId),
    c.env.DB.prepare('DELETE FROM share_link_files WHERE link_id = ?').bind(linkId),
    ...body.files.map((f) => c.env.DB.prepare('INSERT INTO share_link_files (link_id, file_id, version_id) VALUES (?, ?, ?)').bind(linkId, f.fileId, f.versionId)),
  ]);
  return c.json({ ok: true });
});

collab.delete('/projects/:id/shares/:linkId', async (c) => {
  const id = c.req.param('id');
  const g = await gate(c, id, 'editor');
  if (!g.ok) return g.res;
  const res = await c.env.DB.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('linkId'), id).run();
  if (!res.meta.changes) return notFound(c);
  await appendAudit(c.env.DB, { actorId: c.get('session').user_id, action: 'share.revoke', target: id, details: { linkId: c.req.param('linkId') } });
  return c.json({ ok: true });
});

// ---- share links (anyone with the link) --------------------------------------------

interface LiveLink {
  id: string;
  project_id: string;
  token_hash: ArrayBuffer;
  has_password: number;
  allow_download: number;
  allow_comments: number;
  enc_payload: ArrayBuffer;
}
async function liveLink(db: D1Database, linkId: string): Promise<LiveLink | null> {
  return db
    .prepare(
      `SELECT l.id, l.project_id, l.token_hash, l.has_password, l.allow_download, l.allow_comments, l.enc_payload FROM share_links l JOIN projects p ON p.id = l.project_id AND p.deleted_at IS NULL
        WHERE l.id = ? AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)`,
    )
    .bind(linkId, Date.now())
    .first<LiveLink>();
}
async function tokenOk(link: LiveLink, token: string | undefined): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return timingSafeEqual(await sha256(fromB64(token)), new Uint8Array(link.token_hash));
}
async function ipKey(c: Context<AuthedBindings>): Promise<string> {
  return ipHmac(requireSecret(c.env.IP_HMAC_SECRET, "IP_HMAC_SECRET"), clientIp(c as unknown as Context<AppBindings>));
}

collab.get('/share/:linkId', async (c) => {
  const link = await liveLink(c.env.DB, c.req.param('linkId'));
  if (!link) return c.json({ error: 'link_unavailable' }, 404);
  return c.json({ hasPassword: link.has_password === 1 });
});

collab.post('/share/:linkId/open', async (c) => {
  const body = await parseBody(c, openShareRequest);
  if (!body) return bad(c);
  const linkId = c.req.param('linkId');
  // Slow down password guessing per link and per network.
  if (!(await rateLimit(c.env.DB, `share-open:${linkId}`, 60, 900_000)) || !(await rateLimit(c.env.DB, `share-open-ip:${await ipKey(c)}`, 120, 900_000))) {
    return c.json({ error: 'too_many_attempts' }, 429);
  }
  const link = await liveLink(c.env.DB, linkId);
  if (!link) return c.json({ error: 'link_unavailable' }, 404);
  if (!(await tokenOk(link, body.token))) return c.json({ error: 'wrong_password' }, 403);
  return c.json({ encPayload: toB64(link.enc_payload), allowDownload: link.allow_download === 1, allowComments: link.allow_comments === 1 });
});

collab.get('/share/:linkId/files/:fileId/chunks/:idx', async (c) => {
  const link = await liveLink(c.env.DB, c.req.param('linkId'));
  if (!link || !(await tokenOk(link, c.req.header('X-Share-Token')))) return notFound(c);
  const file = await c.env.DB.prepare(
    "SELECT f.id, f.chunk_count FROM share_link_files s JOIN files f ON f.id = s.file_id AND f.status = 'ready' WHERE s.link_id = ? AND s.file_id = ?",
  )
    .bind(link.id, c.req.param('fileId'))
    .first<{ id: string; chunk_count: number }>();
  if (!file) return notFound(c);
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunk_count) return bad(c);
  const data = await c.env.FILES.get(c.env.FILES.idFromName(link.project_id)).getChunk(file.id, idx);
  if (!data) return notFound(c);
  return new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
});

collab.post('/share/:linkId/comments/list', async (c) => {
  const body = await parseBody(c, openShareRequest);
  if (!body) return bad(c);
  const link = await liveLink(c.env.DB, c.req.param('linkId'));
  if (!link || !(await tokenOk(link, body.token))) return notFound(c);
  // Guests read only what was written through this link.
  const { results } = await c.env.DB.prepare(`${COMMENTS} WHERE c.link_id = ? ORDER BY c.created_at LIMIT 2000`).bind(link.id).all<CommentRow>();
  return c.json({ comments: results.map(commentDto) });
});

collab.post('/share/:linkId/comments', async (c) => {
  const body = await parseBody(c, guestCommentRequest);
  if (!body) return bad(c);
  const link = await liveLink(c.env.DB, c.req.param('linkId'));
  if (!link || !(await tokenOk(link, body.token))) return notFound(c);
  if (link.allow_comments !== 1) return forbidden(c);
  if (!(await rateLimit(c.env.DB, `guest-comment:${await ipKey(c)}`, 60, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const inLink = await c.env.DB.prepare('SELECT 1 FROM share_link_files WHERE link_id = ? AND version_id = ?').bind(link.id, body.versionId).first();
  if (!inLink) return bad(c);
  if (body.parentId) {
    const parent = await c.env.DB.prepare('SELECT parent_id FROM comments WHERE id = ? AND link_id = ?').bind(body.parentId, link.id).first<{ parent_id: string | null }>();
    if (!parent || parent.parent_id) return bad(c);
  }
  try {
    await c.env.DB.prepare('INSERT INTO comments (id, project_id, version_id, parent_id, link_id, enc_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(body.id, link.project_id, body.versionId, body.parentId ?? null, link.id, fromB64(body.encBody), Date.now())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  const row = await c.env.DB.prepare(`${COMMENTS} WHERE c.id = ?`).bind(body.id).first<CommentRow>();
  return c.json({ comment: commentDto(row!) }, 201);
});

collab.post('/share/:linkId/play', async (c) => {
  const body = await parseBody(c, guestCommentRequest.pick({ token: true, versionId: true }));
  if (!body) return bad(c);
  const link = await liveLink(c.env.DB, c.req.param('linkId'));
  if (!link || !(await tokenOk(link, body.token))) return notFound(c);
  const v = await c.env.DB.prepare('SELECT v.track_id FROM share_link_files s JOIN track_versions v ON v.id = s.version_id WHERE s.link_id = ? AND s.version_id = ?').bind(link.id, body.versionId).first<{ track_id: string }>();
  if (!v) return bad(c);
  if (await rateLimit(c.env.DB, `share-play:${await ipKey(c)}:${body.versionId}`, 1, 30_000)) await countPlay(c.env.DB, v.track_id, 'link');
  return c.json({ ok: true });
});

collab.get('/public/projects/:id/art', async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT a.public_data, a.public_mime FROM project_art a JOIN projects p ON p.id = a.project_id WHERE a.project_id = ? AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.hidden_at IS NULL AND a.public_data IS NOT NULL",
  )
    .bind(c.req.param('id'))
    .first<{ public_data: ArrayBuffer | number[]; public_mime: string }>();
  if (!row) return notFound(c);
  // URLs carry ?v=<updated_at>; images are public by the owner's choice.
  return new Response(new Uint8Array(row.public_data as ArrayLike<number>), { headers: { 'Content-Type': row.public_mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline' } });
});

/** Public listening: the link of a public project, secret included (public by the owner's choice). */
collab.get('/public/projects/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT p.public_meta, l.id AS link_id, l.public_secret, (SELECT updated_at FROM project_art a WHERE a.project_id = p.id AND a.public_data IS NOT NULL) AS art FROM projects p
       LEFT JOIN share_links l ON l.project_id = p.id AND l.is_public = 1 AND l.revoked_at IS NULL
      WHERE p.id = ? AND p.visibility = 'public' AND p.deleted_at IS NULL`,
  )
    .bind(c.req.param('id'))
    .first<{ public_meta: string; link_id: string | null; public_secret: string | null; art: number | null }>();
  if (!row) return notFound(c);
  return c.json({ meta: JSON.parse(row.public_meta), art: row.art, link: row.link_id ? { id: row.link_id, secret: row.public_secret } : null });
});

export default collab;
