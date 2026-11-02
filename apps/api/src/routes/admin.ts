/**
 * Platform administration. Moderators act on reports; they cannot read
 * private content (it is end-to-end encrypted). They see only public data
 * and whatever evidence a reporter chose to reveal. Every action is written
 * to the hash-chained audit log. Platform roles are granted only from the
 * command line with database access (scripts/admin.mjs), never by the API
 * to itself; there is no hidden or default account.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { appendAudit, verifyAuditChain } from '../lib/audit.js';
import { requireUser, type AuthedBindings } from '../lib/session.js';
import { parseBody } from '../lib/validate.js';
import { notify, reindexProfile, reindexProject } from './social.js';

type AdminBindings = AuthedBindings & { Variables: AuthedBindings['Variables'] & { platformRole: 'owner' | 'moderator' } };
const admin = new Hono<AdminBindings>();

const requireAdmin: MiddlewareHandler<AdminBindings> = async (c, next) => {
  const r = await c.env.DB.prepare('SELECT role FROM platform_roles WHERE user_id = ?').bind(c.get('session').user_id).first<{ role: 'owner' | 'moderator' }>();
  // Indistinguishable from a missing route for everyone else.
  if (!r) return c.json({ error: 'not_found' }, 404);
  c.set('platformRole', r.role);
  await next();
};
admin.use('/admin/*', requireUser as unknown as MiddlewareHandler<AdminBindings>, requireAdmin);

const bad = (c: Context) => c.json({ error: 'invalid_request' }, 400);
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);

admin.get('/admin/me', (c) => c.json({ role: c.get('platformRole') }));

/** Your own platform role (or null): lets the app show the dashboard link without probing admin routes. */
admin.get('/account/platform-role', requireUser as unknown as MiddlewareHandler<AdminBindings>, async (c) => {
  const r = await c.env.DB.prepare('SELECT role FROM platform_roles WHERE user_id = ?').bind(c.get('session').user_id).first<{ role: string }>();
  return c.json({ role: r?.role ?? null });
});

admin.get('/admin/stats', async (c) => {
  const day = 86400_000;
  const now = Date.now();
  const q = (sql: string, ...args: unknown[]) => c.env.DB.prepare(sql).bind(...args).first<{ n: number }>().then((r) => r?.n ?? 0);
  const [users, newUsers, active7, projects, publicProjects, audio, attachments, messages, openReports, suspended] = await Promise.all([
    q("SELECT COUNT(*) AS n FROM users WHERE status != 'deleted'"),
    q('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', now - 7 * day),
    q('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen_at > ?', now - 7 * day),
    q('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL'),
    q("SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL AND visibility = 'public'"),
    q("SELECT COALESCE(SUM(enc_size), 0) AS n FROM files WHERE status != 'deleted'"),
    q("SELECT COALESCE(SUM(enc_size), 0) AS n FROM conv_files WHERE status != 'deleted'"),
    q('SELECT COUNT(*) AS n FROM messages'),
    q("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    q("SELECT COUNT(*) AS n FROM users WHERE status IN ('suspended','banned')"),
  ]);
  return c.json({ users, newUsers, active7, projects, publicProjects, storageBytes: audio + attachments, platformQuota: Number(c.env.PLATFORM_QUOTA_BYTES), messages, openReports, suspended });
});

interface ReportRow {
  id: string;
  reporter: string | null;
  target_type: 'user' | 'project' | 'comment' | 'message';
  target_id: string;
  reason: string;
  details: string;
  evidence: string | null;
  status: string;
  created_at: number;
  resolution: string | null;
}

/** What a moderator may see about a reported item: public data only. */
async function describeTarget(db: D1Database, type: ReportRow['target_type'], id: string) {
  if (type === 'user') {
    const u = await db.prepare('SELECT u.username, u.status, p.display_name, p.bio FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?').bind(id).first<{ username: string; status: string; display_name: string | null; bio: string | null }>();
    return u ? { label: `@${u.username}`, status: u.status, publicText: [u.display_name, u.bio].filter(Boolean).join(' · ') } : null;
  }
  if (type === 'project') {
    const p = await db.prepare('SELECT p.visibility, p.public_meta, p.hidden_at, u.username FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ? AND p.deleted_at IS NULL').bind(id).first<{ visibility: string; public_meta: string | null; hidden_at: number | null; username: string }>();
    if (!p) return null;
    const m = p.public_meta ? (JSON.parse(p.public_meta) as { name: string; description: string }) : null;
    return { label: m ? `“${m.name}” by @${p.username}` : `A private project by @${p.username}`, status: p.hidden_at ? 'hidden' : p.visibility, publicText: m?.description ?? '' };
  }
  const table = type === 'comment' ? 'comments' : 'messages';
  const who = type === 'comment' ? 'author_id' : 'sender_id';
  const r = await db.prepare(`SELECT t.deleted_at, u.username FROM ${table} t LEFT JOIN users u ON u.id = t.${who} WHERE t.id = ?`).bind(id).first<{ deleted_at: number | null; username: string | null }>();
  return r ? { label: `${type === 'comment' ? 'Comment' : 'Message'} by ${r.username ? `@${r.username}` : 'a guest'}`, status: r.deleted_at ? 'removed' : 'live', publicText: '' } : null;
}

admin.get('/admin/reports', async (c) => {
  const status = c.req.query('status') === 'closed' ? "status != 'open'" : "status = 'open'";
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, u.username AS reporter, r.target_type, r.target_id, r.reason, r.details, r.evidence, r.status, r.created_at, r.resolution
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.${status} ORDER BY r.created_at DESC LIMIT 100`,
  ).all<ReportRow>();
  const reports = await Promise.all(results.map(async (r) => ({ ...r, target: await describeTarget(c.env.DB, r.target_type, r.target_id) })));
  return c.json({ reports });
});

const actionRequest = z.object({
  action: z.enum(['dismiss', 'hide_project', 'unhide_project', 'restrict_user', 'suspend_user', 'ban_user', 'reactivate_user', 'remove_item']),
  note: z.string().max(1000).default(''),
});

/** The user responsible for a reported item (for status actions and notices). */
async function ownerOf(db: D1Database, type: ReportRow['target_type'], id: string): Promise<string | null> {
  const sql = {
    user: 'SELECT id AS u FROM users WHERE id = ?',
    project: 'SELECT owner_id AS u FROM projects WHERE id = ?',
    comment: 'SELECT author_id AS u FROM comments WHERE id = ?',
    message: 'SELECT sender_id AS u FROM messages WHERE id = ?',
  }[type];
  return (await db.prepare(sql).bind(id).first<{ u: string | null }>())?.u ?? null;
}

admin.post('/admin/reports/:id', async (c) => {
  const body = await parseBody(c, actionRequest);
  if (!body) return bad(c);
  const me = c.get('session').user_id;
  const role = c.get('platformRole');
  const r = await c.env.DB.prepare('SELECT target_type, target_id, status FROM reports WHERE id = ?').bind(c.req.param('id')).first<{ target_type: ReportRow['target_type']; target_id: string; status: string }>();
  if (!r) return notFound(c);
  const target = await ownerOf(c.env.DB, r.target_type, r.target_id);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  switch (body.action) {
    case 'dismiss':
      break;
    case 'hide_project':
    case 'unhide_project':
      if (r.target_type !== 'project') return bad(c);
      stmts.push(c.env.DB.prepare('UPDATE projects SET hidden_at = ? WHERE id = ?').bind(body.action === 'hide_project' ? now : null, r.target_id));
      break;
    case 'remove_item':
      if (r.target_type === 'comment') stmts.push(c.env.DB.prepare('UPDATE comments SET enc_body = NULL, deleted_at = ?, removed_by = ? WHERE id = ? AND deleted_at IS NULL').bind(now, me, r.target_id));
      else if (r.target_type === 'message') stmts.push(c.env.DB.prepare('UPDATE messages SET enc_body = NULL, deleted_at = ?, removed_by = ? WHERE id = ? AND deleted_at IS NULL').bind(now, me, r.target_id));
      else return bad(c);
      break;
    default: {
      if (!target) return bad(c);
      // Banning is final and reserved for the platform owner; nobody acts on the owner.
      if (body.action === 'ban_user' && role !== 'owner') return c.json({ error: 'forbidden' }, 403);
      const targetRole = await c.env.DB.prepare('SELECT role FROM platform_roles WHERE user_id = ?').bind(target).first<{ role: string }>();
      if (targetRole?.role === 'owner' || (targetRole && role !== 'owner')) return c.json({ error: 'forbidden' }, 403);
      const status = { restrict_user: 'restricted', suspend_user: 'suspended', ban_user: 'banned', reactivate_user: 'active' }[body.action];
      stmts.push(c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, target));
      // Suspension takes effect at once: every session ends.
      if (status === 'suspended' || status === 'banned') stmts.push(c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, target));
    }
  }
  stmts.push(
    c.env.DB.prepare('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?').bind(body.action === 'dismiss' ? 'dismissed' : 'actioned', me, now, `${body.action}${body.note ? `: ${body.note}` : ''}`, c.req.param('id')),
  );
  await c.env.DB.batch(stmts);
  if (r.target_type === 'project') await reindexProject(c.env.DB, r.target_id);
  if (target) await reindexProfile(c.env.DB, target);
  await appendAudit(c.env.DB, { actorId: me, action: `moderation.${body.action}`, target: `${r.target_type}:${r.target_id}`, details: { report: c.req.param('id'), note: body.note || null } });
  if (target && body.action !== 'dismiss') await notify(c.env.DB, target, 'moderation', null, null, c.var.wake);
  return c.json({ ok: true });
});

admin.get('/admin/audit', async (c) => {
  const broken = await verifyAuditChain(c.env.DB);
  const { results } = await c.env.DB.prepare(
    'SELECT a.seq, a.at, u.username AS actor, a.action, a.target, a.details_json FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.seq DESC LIMIT 100',
  ).all<{ seq: number; at: number; actor: string | null; action: string; target: string | null; details_json: string | null }>();
  return c.json({ intact: broken === null, brokenAt: broken, entries: results });
});

admin.post('/admin/moderators', async (c) => {
  if (c.get('platformRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const body = await parseBody(c, z.object({ username: z.string().regex(/^[A-Za-z0-9_.]{3,30}$/), grant: z.boolean() }));
  if (!body) return bad(c);
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? AND status = 'active'").bind(body.username).first<{ id: string }>();
  if (!u) return notFound(c);
  if (u.id === c.get('session').user_id) return bad(c);
  await c.env.DB.prepare(body.grant ? "INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, 'moderator', ?, ?)" : "DELETE FROM platform_roles WHERE user_id = ? AND role = 'moderator'")
    .bind(...(body.grant ? [u.id, c.get('session').user_id, Date.now()] : [u.id]))
    .run();
  await appendAudit(c.env.DB, { actorId: c.get('session').user_id, action: body.grant ? 'admin.grant_moderator' : 'admin.revoke_moderator', target: u.id });
  return c.json({ ok: true });
});

export default admin;
