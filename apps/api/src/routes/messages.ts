/**
 * End-to-end encrypted messaging: DMs, groups and project chats, with
 * realtime delivery through each member's UserHub. The server stores and
 * relays ciphertext; conversation keys travel as signed sealed grants.
 */
import {
  addConversationMemberRequest,
  convFileRequest,
  createConversationRequest,
  editMessageRequest,
  expectedChunkSize,
  REACTIONS,
  rotateConversationRequest,
  sendMessageRequest,
  type ConversationDto,
  type MessageDto,
  type Reaction,
  type RealtimeEvent,
} from '@arai/shared';
import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { fromB64, toB64 } from '../lib/crypto.js';
import { requireProjectRole } from '../lib/projects.js';
import { rateLimit } from '../lib/ratelimit.js';
import { requireUser, type AuthedBindings } from '../lib/session.js';
import { parseBody } from '../lib/validate.js';
import { areFriends, isBlocked } from './social.js';
import { usage } from './tracks.js';

const messages = new Hono<AuthedBindings>();
for (const p of ['/conversations', '/conversations/*', '/messages/*', '/conv-files/*', '/realtime', '/projects/:id/conversation']) messages.use(p, requireUser);

const bad = (c: Context) => c.json({ error: 'invalid_request' }, 400);
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);
const forbidden = (c: Context) => c.json({ error: 'forbidden' }, 403);
const REQUEST_LIMIT = 3; // messages someone may send before a stranger accepts

// ---- access -------------------------------------------------------------------

interface Access {
  id: string;
  kind: 'dm' | 'group' | 'project';
  projectId: string | null;
  keyVersion: number;
  status: 'active' | 'request';
  role: 'member' | 'admin';
}

async function access(db: D1Database, convId: string, userId: string): Promise<Access | null> {
  const conv = await db.prepare('SELECT id, kind, project_id, key_version FROM conversations WHERE id = ?').bind(convId).first<{ id: string; kind: Access['kind']; project_id: string | null; key_version: number }>();
  if (!conv) return null;
  if (conv.kind === 'project') {
    if (!(await requireProjectRole(db, conv.project_id!, userId, 'listener'))) return null;
    const p = await db.prepare('SELECT key_version FROM projects WHERE id = ?').bind(conv.project_id).first<{ key_version: number }>();
    return { id: conv.id, kind: 'project', projectId: conv.project_id, keyVersion: p!.key_version, status: 'active', role: 'member' };
  }
  const m = await db.prepare("SELECT status, role FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND status != 'left'").bind(convId, userId).first<{ status: 'active' | 'request'; role: Access['role'] }>();
  if (!m) return null;
  return { id: conv.id, kind: conv.kind, projectId: null, keyVersion: conv.key_version, status: m.status, role: m.role };
}

/** Everyone who should receive realtime events for a conversation. */
async function audience(db: D1Database, a: Pick<Access, 'id' | 'kind' | 'projectId'>): Promise<string[]> {
  const sql =
    a.kind === 'project'
      ? 'SELECT user_id FROM project_members WHERE project_id = ? AND revoked_at IS NULL AND accepted_at IS NOT NULL'
      : "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND status != 'left'";
  const { results } = await db.prepare(sql).bind(a.kind === 'project' ? a.projectId : a.id).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

async function push(env: Env, userIds: string[], event: RealtimeEvent): Promise<void> {
  const body = JSON.stringify(event);
  await Promise.all(userIds.map((u) => env.HUB.get(env.HUB.idFromName(u)).push(body).catch(() => undefined)));
}

// ---- reading ----------------------------------------------------------------------

interface MsgRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  key_version: number;
  enc_body: ArrayBuffer | null;
  reply_to: string | null;
  created_at: number;
  edited_at: number | null;
}
async function messageDtos(db: D1Database, rows: MsgRow[]): Promise<MessageDto[]> {
  const reactions = new Map<string, Map<Reaction, string[]>>();
  if (rows.length) {
    const { results } = await db
      .prepare(`SELECT message_id, user_id, reaction FROM message_reactions WHERE message_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at`)
      .bind(...rows.map((r) => r.id))
      .all<{ message_id: string; user_id: string; reaction: Reaction }>();
    for (const r of results) {
      const m = reactions.get(r.message_id) ?? new Map<Reaction, string[]>();
      m.set(r.reaction, [...(m.get(r.reaction) ?? []), r.user_id]);
      reactions.set(r.message_id, m);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    keyVersion: r.key_version,
    encBody: r.enc_body ? toB64(r.enc_body) : null,
    replyTo: r.reply_to,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    reactions: [...(reactions.get(r.id) ?? new Map()).entries()].map(([reaction, userIds]) => ({ reaction, userIds })),
  }));
}
const MSG = 'SELECT id, conversation_id, sender_id, key_version, enc_body, reply_to, created_at, edited_at FROM messages';

async function conversationDto(db: D1Database, convId: string, me: string): Promise<ConversationDto | null> {
  const a = await access(db, convId, me);
  if (!a) return null;
  const conv = await db.prepare('SELECT enc_meta, rotation_due, last_message_at FROM conversations WHERE id = ?').bind(convId).first<{ enc_meta: ArrayBuffer | null; rotation_due: number; last_message_at: number | null }>();
  const memberSql =
    a.kind === 'project'
      ? `SELECT u.id, u.username, COALESCE(p.display_name, '') AS display_name, (SELECT updated_at FROM profile_images WHERE user_id = u.id AND kind = 'avatar') AS avatar,
           'active' AS status, 'member' AS role, COALESCE(cm.last_read_at, 0) AS last_read_at, k.x25519_pub
         FROM project_members pm JOIN users u ON u.id = pm.user_id LEFT JOIN profiles p ON p.user_id = u.id
         LEFT JOIN conversation_members cm ON cm.conversation_id = ? AND cm.user_id = u.id
         LEFT JOIN user_keys k ON k.id = (SELECT id FROM user_keys WHERE user_id = u.id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)
         WHERE pm.project_id = ? AND pm.revoked_at IS NULL AND pm.accepted_at IS NOT NULL`
      : `SELECT u.id, u.username, COALESCE(p.display_name, '') AS display_name, (SELECT updated_at FROM profile_images WHERE user_id = u.id AND kind = 'avatar') AS avatar,
           cm.status, cm.role, cm.last_read_at, k.x25519_pub
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id LEFT JOIN profiles p ON p.user_id = u.id
         LEFT JOIN user_keys k ON k.id = (SELECT id FROM user_keys WHERE user_id = u.id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)
         WHERE cm.conversation_id = ? AND cm.status != 'left'`;
  const members = (
    await (a.kind === 'project' ? db.prepare(memberSql).bind(convId, a.projectId) : db.prepare(memberSql).bind(convId)).all<{
      id: string; username: string; display_name: string; avatar: number | null; status: 'active' | 'request'; role: 'member' | 'admin'; last_read_at: number; x25519_pub: ArrayBuffer | null;
    }>()
  ).results;
  const keySql =
    a.kind === 'project'
      ? `SELECT key_version, wrapped_key, grant_sig, granted_by, (SELECT ed25519_pub FROM user_keys WHERE user_id = granted_by AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) AS sk FROM project_keys WHERE project_id = ? AND user_id = ? ORDER BY key_version`
      : `SELECT key_version, wrapped_key, grant_sig, granted_by, (SELECT ed25519_pub FROM user_keys WHERE user_id = granted_by AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) AS sk FROM conversation_keys WHERE conversation_id = ? AND user_id = ? ORDER BY key_version`;
  const keys = (await db.prepare(keySql).bind(a.kind === 'project' ? a.projectId : convId, me).all<{ key_version: number; wrapped_key: ArrayBuffer; grant_sig: ArrayBuffer; granted_by: string; sk: ArrayBuffer | null }>()).results;
  const mine = members.find((m) => m.id === me);
  const lastRead = mine?.last_read_at ?? 0;
  const unread = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at > ? AND sender_id != ? AND deleted_at IS NULL').bind(convId, lastRead, me).first<{ n: number }>();
  const last = await db.prepare(`${MSG} WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`).bind(convId).first<MsgRow>();
  return {
    id: convId,
    kind: a.kind,
    projectId: a.projectId,
    keyVersion: a.keyVersion,
    encMeta: conv?.enc_meta ? toB64(conv.enc_meta) : null,
    grants: keys.filter((k) => k.sk).map((k) => ({ keyVersion: k.key_version, wrappedKey: toB64(k.wrapped_key), signature: toB64(k.grant_sig), grantedBy: k.granted_by, granterSignKey: toB64(k.sk!) })),
    members: members.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, avatar: m.avatar, status: m.status, role: m.role, lastReadAt: m.last_read_at, boxKey: m.x25519_pub ? toB64(m.x25519_pub) : '' })),
    myStatus: a.status,
    myRole: a.role,
    rotationDue: conv?.rotation_due === 1,
    unread: unread?.n ?? 0,
    lastMessageAt: conv?.last_message_at ?? null,
    last: last ? (await messageDtos(db, [last]))[0]! : null,
  };
}

messages.get('/conversations', async (c) => {
  const me = c.get('session').user_id;
  const { results } = await c.env.DB.prepare(
    `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ? AND m.status != 'left' WHERE c.kind != 'project'
     UNION
     SELECT c.id FROM conversations c JOIN project_members pm ON pm.project_id = c.project_id AND pm.user_id = ? AND pm.revoked_at IS NULL AND pm.accepted_at IS NOT NULL
       JOIN projects p ON p.id = c.project_id AND p.deleted_at IS NULL
     WHERE c.kind = 'project' AND c.last_message_at IS NOT NULL`,
  )
    .bind(me, me)
    .all<{ id: string }>();
  const list = (await Promise.all(results.slice(0, 200).map((r) => conversationDto(c.env.DB, r.id, me)))).filter((x): x is ConversationDto => !!x);
  list.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  return c.json({ conversations: list });
});

messages.get('/conversations/:id', async (c) => {
  const dto = await conversationDto(c.env.DB, c.req.param('id'), c.get('session').user_id);
  return dto ? c.json({ conversation: dto }) : notFound(c);
});

messages.get('/projects/:id/conversation', async (c) => {
  const projectId = c.req.param('id');
  const me = c.get('session').user_id;
  if (!(await requireProjectRole(c.env.DB, projectId, me, 'listener'))) return notFound(c);
  // The project's chat shares the project's id and keys.
  await c.env.DB.prepare("INSERT OR IGNORE INTO conversations (id, kind, project_id, created_by, created_at) VALUES (?, 'project', ?, ?, ?)").bind(projectId, projectId, me, Date.now()).run();
  return c.json({ conversation: await conversationDto(c.env.DB, projectId, me) });
});

// ---- creating DMs and groups ---------------------------------------------------------

messages.post('/conversations', async (c) => {
  const body = await parseBody(c, createConversationRequest);
  if (!body) return bad(c);
  const me = c.get('session').user_id;
  if (c.get('session').status === 'restricted') return c.json({ error: 'account_restricted' }, 403);
  if (!(await rateLimit(c.env.DB, `conv-create:${me}`, 60, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const others = [...new Set(body.userIds)].filter((u) => u !== me);
  if (others.length === 0 || (body.kind === 'dm' && others.length !== 1)) return bad(c);
  // Grants: exactly one per participant, including me.
  const everyone = new Set([me, ...others]);
  const granted = new Set(body.grants.map((g) => g.userId));
  if (granted.size !== body.grants.length || granted.size !== everyone.size || [...granted].some((u) => !everyone.has(u))) return c.json({ error: 'grants_incomplete' }, 409);
  for (const u of others) {
    const ok = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").bind(u).first();
    if (!ok || (await isBlocked(c.env.DB, me, u))) return notFound(c);
  }
  const dmKey = body.kind === 'dm' ? [me, others[0]!].sort().join(':') : null;
  if (dmKey) {
    const existing = await c.env.DB.prepare('SELECT id FROM conversations WHERE dm_key = ?').bind(dmKey).first<{ id: string }>();
    if (existing) {
      // Re-open a DM someone left, keeping its history and keys.
      await c.env.DB.prepare("UPDATE conversation_members SET status = 'active' WHERE conversation_id = ? AND user_id = ? AND status = 'left'").bind(existing.id, me).run();
      return c.json({ conversation: await conversationDto(c.env.DB, existing.id, me) });
    }
  }
  const now = Date.now();
  // Strangers get a message request instead of a conversation in their inbox.
  const statusFor = async (u: string) => ((await areFriends(c.env.DB, me, u)) || (await c.env.DB.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').bind(u, me).first()) ? 'active' : 'request');
  const stmts = [
    c.env.DB.prepare('INSERT INTO conversations (id, kind, dm_key, created_by, key_version, enc_meta, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)').bind(body.id, body.kind, dmKey, me, body.encMeta ? fromB64(body.encMeta) : null, now),
    c.env.DB.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, status, joined_at, last_read_at) VALUES (?, ?, ?, 'active', ?, ?)").bind(body.id, me, body.kind === 'group' ? 'admin' : 'member', now, now),
  ];
  for (const u of others) stmts.push(c.env.DB.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', ?, ?)").bind(body.id, u, await statusFor(u), now));
  for (const g of body.grants) {
    stmts.push(c.env.DB.prepare('INSERT INTO conversation_keys (conversation_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)').bind(body.id, g.userId, fromB64(g.wrappedKey), me, fromB64(g.signature), now));
  }
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  await push(c.env, [me, ...others], { type: 'conversation', conversationId: body.id });
  return c.json({ conversation: await conversationDto(c.env.DB, body.id, me) }, 201);
});

messages.post('/conversations/:id/accept', async (c) => {
  const me = c.get('session').user_id;
  const res = await c.env.DB.prepare("UPDATE conversation_members SET status = 'active' WHERE conversation_id = ? AND user_id = ? AND status = 'request'").bind(c.req.param('id'), me).run();
  if (!res.meta.changes) return notFound(c);
  return c.json({ conversation: await conversationDto(c.env.DB, c.req.param('id'), me) });
});

/** Leave a group, decline a request, or hide a DM. */
messages.delete('/conversations/:id/members/:userId', async (c) => {
  const me = c.get('session').user_id;
  const id = c.req.param('id');
  const target = c.req.param('userId') === 'me' ? me : c.req.param('userId');
  const a = await access(c.env.DB, id, me);
  if (!a || a.kind === 'project') return notFound(c);
  if (target !== me && (a.kind !== 'group' || a.role !== 'admin')) return forbidden(c);
  const res = await c.env.DB.prepare("UPDATE conversation_members SET status = 'left' WHERE conversation_id = ? AND user_id = ? AND status != 'left'").bind(id, target).run();
  if (!res.meta.changes) return notFound(c);
  if (a.kind === 'group') {
    // They held the key: the admin's client rotates it for those who remain.
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM conversation_keys WHERE conversation_id = ? AND user_id = ?').bind(id, target),
      c.env.DB.prepare('UPDATE conversations SET rotation_due = 1 WHERE id = ?').bind(id),
    ]);
  }
  await push(c.env, [...(await audience(c.env.DB, a)), target], { type: 'conversation', conversationId: id });
  return c.json({ ok: true });
});

messages.post('/conversations/:id/members', async (c) => {
  const me = c.get('session').user_id;
  const id = c.req.param('id');
  const a = await access(c.env.DB, id, me);
  if (!a) return notFound(c);
  if (a.kind !== 'group' || a.role !== 'admin') return forbidden(c);
  const body = await parseBody(c, addConversationMemberRequest);
  if (!body) return bad(c);
  const versions = new Set(body.grants.map((g) => g.keyVersion));
  if (versions.size !== body.grants.length || versions.size !== a.keyVersion || [...versions].some((v) => v < 1 || v > a.keyVersion)) return c.json({ error: 'grants_incomplete' }, 409);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND status != 'left'").bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 32) return c.json({ error: 'group_full' }, 409);
  const ok = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").bind(body.userId).first();
  if (!ok || (await isBlocked(c.env.DB, me, body.userId))) return notFound(c);
  const now = Date.now();
  const status = (await areFriends(c.env.DB, me, body.userId)) ? 'active' : 'request';
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO conversation_members (conversation_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET status = excluded.status, joined_at = excluded.joined_at",
    ).bind(id, body.userId, status, now),
    c.env.DB.prepare('DELETE FROM conversation_keys WHERE conversation_id = ? AND user_id = ?').bind(id, body.userId),
    ...body.grants.map((g) =>
      c.env.DB.prepare('INSERT INTO conversation_keys (conversation_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, g.keyVersion, body.userId, fromB64(g.wrappedKey), me, fromB64(g.signature), now),
    ),
  ]);
  await push(c.env, await audience(c.env.DB, a), { type: 'conversation', conversationId: id });
  return c.json({ ok: true }, 201);
});

messages.post('/conversations/:id/rotate', async (c) => {
  const me = c.get('session').user_id;
  const id = c.req.param('id');
  const a = await access(c.env.DB, id, me);
  if (!a) return notFound(c);
  if (a.kind !== 'group' || a.role !== 'admin') return forbidden(c);
  const body = await parseBody(c, rotateConversationRequest);
  if (!body) return bad(c);
  if (body.keyVersion !== a.keyVersion + 1) return c.json({ error: 'stale_key' }, 409);
  const want = new Set(await audience(c.env.DB, a));
  const got = new Set(body.grants.map((g) => g.userId));
  if (got.size !== body.grants.length || got.size !== want.size || [...got].some((u) => !want.has(u))) return c.json({ error: 'members_changed' }, 409);
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE conversations SET key_version = ?, enc_meta = ?, rotation_due = 0 WHERE id = ? AND key_version = ?').bind(body.keyVersion, body.encMeta ? fromB64(body.encMeta) : null, id, a.keyVersion),
      ...body.grants.map((g) =>
        c.env.DB.prepare('INSERT INTO conversation_keys (conversation_id, key_version, user_id, wrapped_key, granted_by, grant_sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, body.keyVersion, g.userId, fromB64(g.wrappedKey), me, fromB64(g.signature), now),
      ),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'stale_key' }, 409);
    throw e;
  }
  await push(c.env, [...want], { type: 'conversation', conversationId: id });
  return c.json({ ok: true });
});

// ---- messages ---------------------------------------------------------------------------

messages.get('/conversations/:id/messages', async (c) => {
  const me = c.get('session').user_id;
  const a = await access(c.env.DB, c.req.param('id'), me);
  if (!a) return notFound(c);
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  const { results } = await c.env.DB.prepare(`${MSG} WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 60`).bind(a.id, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER).all<MsgRow>();
  return c.json({ messages: (await messageDtos(c.env.DB, results)).reverse(), more: results.length === 60 });
});

messages.post('/conversations/:id/messages', async (c) => {
  const me = c.get('session').user_id;
  const a = await access(c.env.DB, c.req.param('id'), me);
  if (!a) return notFound(c);
  const body = await parseBody(c, sendMessageRequest);
  if (!body) return bad(c);
  if (!(await rateLimit(c.env.DB, `msg:${me}`, 600, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  if (body.keyVersion !== a.keyVersion) return c.json({ error: 'stale_key' }, 409);
  if (a.status === 'request') return c.json({ error: 'accept_first' }, 403);
  if (a.kind === 'dm') {
    const other = await c.env.DB.prepare('SELECT user_id, status FROM conversation_members WHERE conversation_id = ? AND user_id != ?').bind(a.id, me).first<{ user_id: string; status: string }>();
    if (other && (await isBlocked(c.env.DB, me, other.user_id))) return forbidden(c);
    if (other?.status === 'request') {
      const sent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?').bind(a.id, me).first<{ n: number }>();
      if ((sent?.n ?? 0) >= REQUEST_LIMIT) return c.json({ error: 'request_pending' }, 403);
    }
    // Writing again un-hides a DM for the other person.
    if (other?.status === 'left') await c.env.DB.prepare("UPDATE conversation_members SET status = 'active' WHERE conversation_id = ? AND user_id = ?").bind(a.id, other.user_id).run();
  }
  if (body.replyTo) {
    const r = await c.env.DB.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?').bind(body.replyTo, a.id).first();
    if (!r) return bad(c);
  }
  const now = Date.now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, key_version, enc_body, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(body.id, a.id, me, body.keyVersion, fromB64(body.encBody), body.replyTo ?? null, now),
      c.env.DB.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').bind(now, a.id),
      c.env.DB.prepare(
        "INSERT INTO conversation_members (conversation_id, user_id, status, joined_at, last_read_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at",
      ).bind(a.id, me, now, now),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  const row = await c.env.DB.prepare(`${MSG} WHERE id = ?`).bind(body.id).first<MsgRow>();
  const message = (await messageDtos(c.env.DB, [row!]))[0]!;
  c.executionCtx.waitUntil(audience(c.env.DB, a).then((ids) => push(c.env, ids, { type: 'message', conversationId: a.id, message })));
  // Phone notifications: at most one per conversation per minute for each person.
  for (const uid of (await audience(c.env.DB, a)).filter((u) => u !== me)) {
    if (await rateLimit(c.env.DB, `push-msg:${uid}:${a.id}`, 1, 60_000)) c.var.wake?.push(uid);
  }
  return c.json({ message }, 201);
});

async function ownMessage(c: Context<AuthedBindings>) {
  const me = c.get('session').user_id;
  const m = await c.env.DB.prepare('SELECT conversation_id, sender_id, deleted_at FROM messages WHERE id = ?').bind(c.req.param('id')).first<{ conversation_id: string; sender_id: string; deleted_at: number | null }>();
  if (!m || m.deleted_at) return null;
  const a = await access(c.env.DB, m.conversation_id, me);
  if (!a) return null;
  return { a, m, me };
}
async function after(c: Context<AuthedBindings>, a: Access, type: 'edit' | 'delete' | 'react') {
  const row = await c.env.DB.prepare(`${MSG} WHERE id = ?`).bind(c.req.param('id')).first<MsgRow>();
  const message = (await messageDtos(c.env.DB, [row!]))[0]!;
  c.executionCtx.waitUntil(audience(c.env.DB, a).then((ids) => push(c.env, ids, { type, conversationId: a.id, message })));
  return c.json({ message });
}

messages.patch('/messages/:id', async (c) => {
  const o = await ownMessage(c);
  if (!o) return notFound(c);
  if (o.m.sender_id !== o.me) return forbidden(c);
  const body = await parseBody(c, editMessageRequest);
  if (!body) return bad(c);
  if (body.keyVersion !== o.a.keyVersion) return c.json({ error: 'stale_key' }, 409);
  await c.env.DB.prepare('UPDATE messages SET enc_body = ?, key_version = ?, edited_at = ? WHERE id = ?').bind(fromB64(body.encBody), body.keyVersion, Date.now(), c.req.param('id')).run();
  return after(c, o.a, 'edit');
});

messages.delete('/messages/:id', async (c) => {
  const o = await ownMessage(c);
  if (!o) return notFound(c);
  if (o.m.sender_id !== o.me) return forbidden(c);
  // Deleted for everyone: the ciphertext itself is erased.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE messages SET enc_body = NULL, deleted_at = ? WHERE id = ?').bind(Date.now(), c.req.param('id')),
    c.env.DB.prepare('DELETE FROM message_reactions WHERE message_id = ?').bind(c.req.param('id')),
  ]);
  return after(c, o.a, 'delete');
});

messages.post('/messages/:id/reactions/:reaction', async (c) => {
  const reaction = c.req.param('reaction') as Reaction;
  if (!REACTIONS.includes(reaction)) return bad(c);
  const o = await ownMessage(c);
  if (!o || o.a.status === 'request') return notFound(c);
  await c.env.DB.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, reaction, created_at) VALUES (?, ?, ?, ?)').bind(c.req.param('id'), o.me, reaction, Date.now()).run();
  return after(c, o.a, 'react');
});

messages.delete('/messages/:id/reactions/:reaction', async (c) => {
  const o = await ownMessage(c);
  if (!o) return notFound(c);
  await c.env.DB.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?').bind(c.req.param('id'), o.me, c.req.param('reaction')).run();
  return after(c, o.a, 'react');
});

messages.post('/conversations/:id/read', async (c) => {
  const me = c.get('session').user_id;
  const a = await access(c.env.DB, c.req.param('id'), me);
  if (!a) return notFound(c);
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO conversation_members (conversation_id, user_id, status, joined_at, last_read_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at",
  )
    .bind(a.id, me, now, now)
    .run();
  c.executionCtx.waitUntil(audience(c.env.DB, a).then((ids) => push(c.env, ids.filter((u) => u !== me), { type: 'read', conversationId: a.id, userId: me, at: now })));
  return c.json({ ok: true });
});

messages.post('/conversations/:id/typing', async (c) => {
  const me = c.get('session').user_id;
  const a = await access(c.env.DB, c.req.param('id'), me);
  if (!a || a.status === 'request') return notFound(c);
  if (!(await rateLimit(c.env.DB, `typing:${me}`, 40, 60_000))) return c.json({ ok: true });
  c.executionCtx.waitUntil(audience(c.env.DB, a).then((ids) => push(c.env, ids.filter((u) => u !== me), { type: 'typing', conversationId: a.id, userId: me })));
  return c.json({ ok: true });
});

// ---- attachments ---------------------------------------------------------------------------

const convStore = (env: Env, convId: string) => env.FILES.get(env.FILES.idFromName(`conv:${convId}`));

messages.post('/conversations/:id/files', async (c) => {
  const me = c.get('session').user_id;
  const a = await access(c.env.DB, c.req.param('id'), me);
  if (!a || a.status === 'request') return notFound(c);
  const body = await parseBody(c, convFileRequest);
  if (!body) return bad(c);
  const u = await usage(c.env.DB, me);
  if (u.mine + body.encSize > Number(c.env.USER_QUOTA_BYTES)) return c.json({ error: 'quota_exceeded' }, 413);
  if (u.all + body.encSize > Number(c.env.PLATFORM_QUOTA_BYTES)) return c.json({ error: 'storage_full' }, 507);
  try {
    await c.env.DB.prepare('INSERT INTO conv_files (id, conversation_id, uploader_id, enc_size, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(body.id, a.id, me, body.encSize, body.chunkCount, Date.now()).run();
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  return c.json({ ok: true }, 201);
});

async function convFile(c: Context<AuthedBindings>) {
  const f = await c.env.DB.prepare("SELECT id, conversation_id, uploader_id, enc_size, chunk_count, status FROM conv_files WHERE id = ? AND status != 'deleted'")
    .bind(c.req.param('fid'))
    .first<{ id: string; conversation_id: string; uploader_id: string; enc_size: number; chunk_count: number; status: string }>();
  if (!f) return null;
  const a = await access(c.env.DB, f.conversation_id, c.get('session').user_id);
  return a ? { f, a } : null;
}

messages.put('/conv-files/:fid/chunks/:idx', async (c) => {
  const x = await convFile(c);
  if (!x) return notFound(c);
  if (x.f.uploader_id !== c.get('session').user_id) return forbidden(c);
  if (x.f.status !== 'pending') return c.json({ error: 'already_complete' }, 409);
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= x.f.chunk_count) return bad(c);
  const expected = expectedChunkSize(x.f.enc_size, x.f.chunk_count, idx);
  const data = await c.req.arrayBuffer();
  if (data.byteLength !== expected) return c.json({ error: 'bad_chunk_size' }, 400);
  await convStore(c.env, x.f.conversation_id).putChunk(x.f.id, idx, data);
  return c.json({ ok: true });
});

messages.post('/conv-files/:fid/complete', async (c) => {
  const x = await convFile(c);
  if (!x) return notFound(c);
  if (x.f.uploader_id !== c.get('session').user_id) return forbidden(c);
  const sizes = await convStore(c.env, x.f.conversation_id).chunkSizes(x.f.id);
  const complete = sizes.length === x.f.chunk_count && sizes.every((s, i) => s.idx === i && s.size === expectedChunkSize(x.f.enc_size, x.f.chunk_count, i));
  if (!complete) return c.json({ error: 'incomplete' }, 409);
  await c.env.DB.prepare("UPDATE conv_files SET status = 'ready' WHERE id = ?").bind(x.f.id).run();
  return c.json({ ok: true });
});

messages.get('/conv-files/:fid/chunks/:idx', async (c) => {
  const x = await convFile(c);
  if (!x || x.f.status !== 'ready') return notFound(c);
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= x.f.chunk_count) return bad(c);
  const data = await convStore(c.env, x.f.conversation_id).getChunk(x.f.id, idx);
  if (!data) return notFound(c);
  return new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' } });
});

// ---- realtime ------------------------------------------------------------------------------

messages.get('/realtime', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.json({ error: 'expected_websocket' }, 426);
  // Cross-site WebSocket hijacking guard: only our own pages may connect.
  if (c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({ error: 'forbidden_origin' }, 403);
  const me = c.get('session').user_id;
  const res = await c.env.HUB.get(c.env.HUB.idFromName(me)).fetch(c.req.raw);
  // Re-wrap so the security-header middleware can still set headers.
  return new Response(null, { status: res.status, webSocket: res.webSocket });
});

export default messages;
