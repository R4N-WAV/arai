/**
 * Social: follows, friends, blocks, reports, notifications and discovery.
 * Only public profiles and public projects are ever searchable.
 */
import { reportRequest, type NotificationDto, type PersonDto } from '@arai/shared';
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env.js';
import { ipHmac, requireSecret } from '../lib/crypto.js';
import { randomId as newId } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, requireUser, type AuthedBindings } from '../lib/session.js';
import { parseBody } from '../lib/validate.js';

const social = new Hono<AuthedBindings>();
for (const p of ['/social/*', '/notifications', '/notifications/*', '/reports']) social.use(p, requireUser);

const bad = (c: Context) => c.json({ error: 'invalid_request' }, 400);
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);

// ---- helpers used across routes ----------------------------------------------------

export async function notify(db: D1Database, userId: string, kind: NotificationDto['kind'], actorId: string | null, targetId: string | null): Promise<void> {
  if (actorId && (await isBlocked(db, userId, actorId))) return;
  // Collapse repeats (e.g. many comments) into one unread notification.
  const dup = await db
    .prepare('SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND actor_id IS ? AND target_id IS ? AND read_at IS NULL')
    .bind(userId, kind, actorId, targetId)
    .first<{ id: string }>();
  if (dup) {
    await db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').bind(Date.now(), dup.id).run();
    return;
  }
  await db.prepare('INSERT INTO notifications (id, user_id, kind, actor_id, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), userId, kind, actorId, targetId, Date.now()).run();
}

export async function isBlocked(db: D1Database, a: string, b: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').bind(a, b, b, a).first());
}

export async function areFriends(db: D1Database, a: string, b: string): Promise<boolean> {
  const [x, y] = a < b ? [a, b] : [b, a];
  return !!(await db.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'accepted'").bind(x, y).first());
}

/** Keeps the discovery index in step with what is public right now. */
export async function reindexProject(db: D1Database, projectId: string): Promise<void> {
  const p = await db
    .prepare("SELECT p.public_meta FROM projects p JOIN users u ON u.id = p.owner_id AND u.status = 'active' WHERE p.id = ? AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.hidden_at IS NULL")
    .bind(projectId)
    .first<{ public_meta: string }>();
  const stmts = [db.prepare("DELETE FROM search_index WHERE kind = 'project' AND ref = ?").bind(projectId)];
  if (p) {
    const m = JSON.parse(p.public_meta) as { name: string; description?: string; genre?: string; tags?: string[] };
    stmts.push(db.prepare("INSERT INTO search_index (kind, ref, title, body) VALUES ('project', ?, ?, ?)").bind(projectId, m.name, [m.description, m.genre, ...(m.tags ?? [])].filter(Boolean).join(' ')));
  }
  await db.batch(stmts);
}

export async function reindexProfile(db: D1Database, userId: string): Promise<void> {
  const u = await db
    .prepare("SELECT u.username, p.display_name, p.bio, p.location FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ? AND u.status = 'active' AND u.deleted_at IS NULL")
    .bind(userId)
    .first<{ username: string; display_name: string | null; bio: string | null; location: string | null }>();
  const stmts = [db.prepare("DELETE FROM search_index WHERE kind = 'user' AND ref = ?").bind(userId)];
  if (u) stmts.push(db.prepare("INSERT INTO search_index (kind, ref, title, body) VALUES ('user', ?, ?, ?)").bind(userId, `${u.username} ${u.display_name ?? ''}`, `${u.bio ?? ''} ${u.location ?? ''}`));
  await db.batch(stmts);
}

async function userByName(db: D1Database, username: string): Promise<{ id: string } | null> {
  if (!/^[A-Za-z0-9_.]{3,30}$/.test(username)) return null;
  return db.prepare("SELECT id FROM users WHERE username = ? AND status IN ('active','restricted') AND deleted_at IS NULL").bind(username).first<{ id: string }>();
}

// ---- relationship with one person -------------------------------------------------

social.get('/social/:username', async (c) => {
  const me = c.get('session').user_id;
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other) return notFound(c);
  const [x, y] = me < other.id ? [me, other.id] : [other.id, me];
  const [following, followsMe, friend, iBlocked, followers, followingCount] = await Promise.all([
    c.env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').bind(me, other.id).first(),
    c.env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').bind(other.id, me).first(),
    c.env.DB.prepare('SELECT status, requested_by FROM friendships WHERE user_a = ? AND user_b = ?').bind(x, y).first<{ status: string; requested_by: string }>(),
    c.env.DB.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(me, other.id).first(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').bind(other.id).first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').bind(other.id).first<{ n: number }>(),
  ]);
  return c.json({
    self: me === other.id,
    following: !!following,
    followsYou: !!followsMe,
    friend: friend?.status === 'accepted' ? 'friends' : friend ? (friend.requested_by === me ? 'requested' : 'incoming') : 'none',
    blocked: !!iBlocked,
    followers: followers?.n ?? 0,
    followingCount: followingCount?.n ?? 0,
  });
});

social.post('/social/:username/follow', async (c) => {
  const me = c.get('session').user_id;
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other || other.id === me || (await isBlocked(c.env.DB, me, other.id))) return notFound(c);
  if (!(await rateLimit(c.env.DB, `follow:${me}`, 200, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').bind(me, other.id, Date.now()).run();
  if (res.meta.changes) await notify(c.env.DB, other.id, 'follow', me, null);
  return c.json({ ok: true });
});

social.delete('/social/:username/follow', async (c) => {
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other) return notFound(c);
  await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(c.get('session').user_id, other.id).run();
  return c.json({ ok: true });
});

/** Send a friend request, or accept an incoming one. */
social.post('/social/:username/friend', async (c) => {
  const me = c.get('session').user_id;
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other || other.id === me || (await isBlocked(c.env.DB, me, other.id))) return notFound(c);
  if (!(await rateLimit(c.env.DB, `friend:${me}`, 100, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const [x, y] = me < other.id ? [me, other.id] : [other.id, me];
  const row = await c.env.DB.prepare('SELECT status, requested_by FROM friendships WHERE user_a = ? AND user_b = ?').bind(x, y).first<{ status: string; requested_by: string }>();
  if (row?.status === 'accepted') return c.json({ friend: 'friends' });
  if (row && row.requested_by !== me) {
    await c.env.DB.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_a = ? AND user_b = ?").bind(Date.now(), x, y).run();
    await notify(c.env.DB, other.id, 'friend_accept', me, null);
    return c.json({ friend: 'friends' });
  }
  if (!row) {
    await c.env.DB.prepare("INSERT INTO friendships (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(x, y, me, Date.now()).run();
    await notify(c.env.DB, other.id, 'friend_request', me, null);
  }
  return c.json({ friend: 'requested' });
});

/** Cancel a request, decline one, or unfriend. */
social.delete('/social/:username/friend', async (c) => {
  const me = c.get('session').user_id;
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other) return notFound(c);
  const [x, y] = me < other.id ? [me, other.id] : [other.id, me];
  await c.env.DB.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(x, y).run();
  return c.json({ friend: 'none' });
});

social.post('/social/:username/block', async (c) => {
  const me = c.get('session').user_id;
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other || other.id === me) return notFound(c);
  const [x, y] = me < other.id ? [me, other.id] : [other.id, me];
  // Blocking ends every connection in both directions.
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(me, other.id, Date.now()),
    c.env.DB.prepare('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)').bind(me, other.id, other.id, me),
    c.env.DB.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(x, y),
    c.env.DB.prepare('DELETE FROM notifications WHERE user_id = ? AND actor_id = ?').bind(me, other.id),
  ]);
  return c.json({ ok: true });
});

social.delete('/social/:username/block', async (c) => {
  const other = await userByName(c.env.DB, c.req.param('username'));
  if (!other) return notFound(c);
  await c.env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(c.get('session').user_id, other.id).run();
  return c.json({ ok: true });
});

// ---- lists --------------------------------------------------------------------------

const PERSON = `SELECT u.id, u.username, COALESCE(p.display_name, '') AS display_name,
    (SELECT updated_at FROM profile_images WHERE user_id = u.id AND kind = 'avatar') AS avatar
  FROM users u LEFT JOIN profiles p ON p.user_id = u.id`;
interface PersonRow {
  id: string;
  username: string;
  display_name: string;
  avatar: number | null;
}
const person = (r: PersonRow): PersonDto => ({ id: r.id, username: r.username, displayName: r.display_name, avatar: r.avatar });

social.get('/social/me/friends', async (c) => {
  const me = c.get('session').user_id;
  const { results } = await c.env.DB.prepare(
    `${PERSON} JOIN friendships f ON (f.user_a = ? AND f.user_b = u.id) OR (f.user_b = ? AND f.user_a = u.id)
      WHERE u.status = 'active' ORDER BY f.status DESC, u.username LIMIT 500`.replace('SELECT u.id', 'SELECT f.status, f.requested_by, u.id'),
  )
    .bind(me, me)
    .all<PersonRow & { status: string; requested_by: string }>();
  return c.json({
    friends: results.filter((r) => r.status === 'accepted').map(person),
    incoming: results.filter((r) => r.status === 'pending' && r.requested_by !== me).map(person),
    outgoing: results.filter((r) => r.status === 'pending' && r.requested_by === me).map(person),
  });
});

social.get('/social/me/following', async (c) => {
  const { results } = await c.env.DB.prepare(`${PERSON} JOIN follows f ON f.followee_id = u.id WHERE f.follower_id = ? AND u.status = 'active' ORDER BY f.created_at DESC LIMIT 500`)
    .bind(c.get('session').user_id)
    .all<PersonRow>();
  return c.json({ people: results.map(person) });
});

social.get('/social/me/blocked', async (c) => {
  const { results } = await c.env.DB.prepare(`${PERSON} JOIN blocks b ON b.blocked_id = u.id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`).bind(c.get('session').user_id).all<PersonRow>();
  return c.json({ people: results.map(person) });
});

// ---- discovery (public, signed out too) -----------------------------------------------

function ftsQuery(q: string): string | null {
  const words = q.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (words.length === 0) return null;
  // Prefix match on each word; quoted so user text can never be FTS syntax.
  return words.map((w) => `"${w.slice(0, 40)}"*`).join(' ');
}

social.get('/discover', async (c) => {
  const ip = await ipHmac(requireSecret(c.env.IP_HMAC_SECRET, "IP_HMAC_SECRET"), clientIp(c as unknown as Context<AppBindings>));
  if (!(await rateLimit(c.env.DB, `discover:${ip}`, 120, 60_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const q = (c.req.query('q') ?? '').slice(0, 200);
  const match = ftsQuery(q);
  const projectSql = `SELECT p.id, p.public_meta, p.published_at, u.username AS owner,
      EXISTS (SELECT 1 FROM share_links l WHERE l.project_id = p.id AND l.is_public = 1 AND l.revoked_at IS NULL) AS listenable,
      (SELECT updated_at FROM project_art a WHERE a.project_id = p.id AND a.public_data IS NOT NULL) AS art
    FROM projects p JOIN users u ON u.id = p.owner_id AND u.status = 'active'
    WHERE p.visibility = 'public' AND p.deleted_at IS NULL AND p.hidden_at IS NULL`;
  type PRow = { id: string; public_meta: string; published_at: number; owner: string; listenable: number; art: number | null };
  let projects: PRow[];
  let people: PersonRow[];
  if (match) {
    projects = (await c.env.DB.prepare(`${projectSql} AND p.id IN (SELECT ref FROM search_index WHERE kind = 'project' AND search_index MATCH ? ORDER BY rank LIMIT 40)`).bind(match).all<PRow>()).results;
    people = (await c.env.DB.prepare(`${PERSON} WHERE u.status = 'active' AND u.id IN (SELECT ref FROM search_index WHERE kind = 'user' AND search_index MATCH ? ORDER BY rank LIMIT 20)`).bind(match).all<PersonRow>()).results;
  } else {
    projects = (await c.env.DB.prepare(`${projectSql} ORDER BY p.published_at DESC LIMIT 30`).all<PRow>()).results;
    people = [];
  }
  return c.json({
    projects: projects.map((r) => ({ id: r.id, publicMeta: JSON.parse(r.public_meta), publishedAt: r.published_at, owner: r.owner, listenable: r.listenable === 1, art: r.art })),
    people: people.map(person),
  });
});

// ---- notifications ---------------------------------------------------------------------

social.get('/notifications', async (c) => {
  const me = c.get('session').user_id;
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.kind, n.target_id, n.created_at, n.read_at, u.username AS actor
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`,
  )
    .bind(me)
    .all<{ id: string; kind: NotificationDto['kind']; target_id: string | null; created_at: number; read_at: number | null; actor: string | null }>();
  const unread = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(me).first<{ n: number }>();
  const notifications: NotificationDto[] = results.map((r) => ({ id: r.id, kind: r.kind, actor: r.actor, targetId: r.target_id, createdAt: r.created_at, read: r.read_at !== null }));
  return c.json({ notifications, unread: unread?.n ?? 0 });
});

social.post('/notifications/read', async (c) => {
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(Date.now(), c.get('session').user_id).run();
  return c.json({ ok: true });
});

// ---- reports ------------------------------------------------------------------------------

social.post('/reports', async (c) => {
  const body = await parseBody(c, reportRequest);
  if (!body) return bad(c);
  const me = c.get('session').user_id;
  if (!(await rateLimit(c.env.DB, `report:${me}`, 30, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  let targetId = body.targetId;
  if (body.targetType === 'user') {
    const u = await userByName(c.env.DB, body.targetId);
    if (!u) return notFound(c);
    targetId = u.id;
  }
  await c.env.DB.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), me, body.targetType, targetId, body.reason, body.details, body.evidence ?? null, Date.now())
    .run();
  return c.json({ ok: true }, 201);
});

export default social;
