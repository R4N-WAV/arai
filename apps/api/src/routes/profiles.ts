import { IMAGE_LIMITS, updateProfileRequest, type ImageKind, type ProfileDto } from '@arai/shared';
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env.js';
import { ipHmac, requireSecret } from '../lib/crypto.js';
import { inspectImage } from '../lib/images.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, requireUser, type AuthedBindings } from '../lib/session.js';
import { parseBody } from '../lib/validate.js';
import { reindexProfile } from './social.js';

const profiles = new Hono<AppBindings>();
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);
const isKind = (k: string): k is ImageKind => k === 'avatar' || k === 'banner';

/** The public view of a profile. Only explicitly public projects are included. */
export async function loadProfile(db: D1Database, where: { username: string } | { userId: string }): Promise<ProfileDto | null> {
  const u = await db
    .prepare(
      `SELECT u.id, u.username, u.created_at, p.display_name, p.bio, p.location, p.links_json,
              (SELECT updated_at FROM profile_images WHERE user_id = u.id AND kind = 'avatar') AS avatar,
              (SELECT updated_at FROM profile_images WHERE user_id = u.id AND kind = 'banner') AS banner
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE ${'username' in where ? 'u.username = ?' : 'u.id = ?'} AND u.status IN ('active', 'restricted')`,
    )
    .bind('username' in where ? where.username : where.userId)
    .first<{ id: string; username: string; created_at: number; display_name: string | null; bio: string | null; location: string | null; links_json: string | null; avatar: number | null; banner: number | null }>();
  if (!u) return null;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.public_meta, p.published_at,
         EXISTS (SELECT 1 FROM share_links l WHERE l.project_id = p.id AND l.is_public = 1 AND l.revoked_at IS NULL) AS listenable,
         (SELECT updated_at FROM project_art a WHERE a.project_id = p.id AND a.public_data IS NOT NULL) AS art
       FROM projects p WHERE p.owner_id = ? AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.hidden_at IS NULL ORDER BY p.published_at DESC LIMIT 100`,
    )
    .bind(u.id)
    .all<{ id: string; public_meta: string; published_at: number; listenable: number; art: number | null }>();
  return {
    username: u.username,
    displayName: u.display_name ?? '',
    bio: u.bio ?? '',
    location: u.location ?? '',
    links: JSON.parse(u.links_json ?? '[]'),
    avatar: u.avatar,
    banner: u.banner,
    joinedAt: u.created_at,
    projects: results.map((r) => ({ id: r.id, publicMeta: JSON.parse(r.public_meta), publishedAt: r.published_at, listenable: r.listenable === 1, art: r.art })),
  };
}

profiles.get('/profiles/:username', async (c) => {
  const ip = await ipHmac(requireSecret(c.env.IP_HMAC_SECRET, 'IP_HMAC_SECRET'), clientIp(c));
  if (!(await rateLimit(c.env.DB, `profile:${ip}`, 240, 60_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const name = c.req.param('username');
  if (!/^[A-Za-z0-9_.]{3,30}$/.test(name)) return notFound(c);
  const p = await loadProfile(c.env.DB, { username: name });
  return p ? c.json({ profile: p }) : notFound(c);
});

profiles.get('/profiles/:username/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (!isKind(kind)) return notFound(c);
  const row = await c.env.DB.prepare(
    `SELECT i.mime, i.data FROM profile_images i JOIN users u ON u.id = i.user_id
      WHERE u.username = ? AND i.kind = ? AND u.status IN ('active', 'restricted')`,
  )
    .bind(c.req.param('username'), kind)
    .first<{ mime: string; data: ArrayBuffer | number[] }>();
  if (!row) return notFound(c);
  // URLs carry ?v=<updated_at>, so a long cache is safe; images are public.
  // D1 may return BLOBs as number arrays; normalise to bytes.
  return new Response(new Uint8Array(row.data as ArrayLike<number>), { headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline' } });
});

const own = new Hono<AuthedBindings>();
own.use('/account/profile', requireUser);
own.use('/account/profile/*', requireUser);

own.get('/account/profile', async (c) => c.json({ profile: await loadProfile(c.env.DB, { userId: c.get('session').user_id }) }));

own.put('/account/profile', async (c) => {
  const body = await parseBody(c, updateProfileRequest);
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  const userId = c.get('session').user_id;
  await c.env.DB.prepare(
    `INSERT INTO profiles (user_id, display_name, bio, location, links_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio, location = excluded.location, links_json = excluded.links_json, updated_at = excluded.updated_at`,
  ).bind(userId, body.displayName, body.bio, body.location, JSON.stringify(body.links), Date.now()).run();
  await reindexProfile(c.env.DB, userId);
  return c.json({ profile: await loadProfile(c.env.DB, { userId }) });
});

own.put('/account/profile/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (!isKind(kind)) return notFound(c);
  const userId = c.get('session').user_id;
  if (!(await rateLimit(c.env.DB, `img:${userId}`, 30, 3600_000))) return c.json({ error: 'too_many_attempts' }, 429);
  const limit = IMAGE_LIMITS[kind];
  const data = new Uint8Array(await c.req.arrayBuffer());
  if (data.byteLength === 0 || data.byteLength > limit.bytes) return c.json({ error: 'image_too_large' }, 413);
  const info = inspectImage(data);
  if (!info) return c.json({ error: 'unsupported_image' }, 400);
  if (info.width < 1 || info.height < 1 || info.width > limit.px || info.height > limit.px) return c.json({ error: 'image_dimensions' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO profile_images (user_id, kind, mime, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(userId, kind, info.mime, data, Date.now()).run();
  return c.json({ profile: await loadProfile(c.env.DB, { userId }) });
});

own.delete('/account/profile/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (!isKind(kind)) return notFound(c);
  const userId = c.get('session').user_id;
  await c.env.DB.prepare('DELETE FROM profile_images WHERE user_id = ? AND kind = ?').bind(userId, kind).run();
  return c.json({ profile: await loadProfile(c.env.DB, { userId }) });
});

profiles.route('/', own);
export default profiles;
