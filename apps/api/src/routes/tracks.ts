import { addVersionRequest, createFileRequest, createTrackRequest, expectedChunkSize, updateTrackRequest, type TrackDto } from '@arai/shared';
import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { fromB64, toB64 } from '../lib/crypto.js';
import { requireProjectRole } from '../lib/projects.js';
import { requireUser, type AuthedBindings } from '../lib/session.js';
import { fetchRemoteChunk, remoteSizeOk, validRemoteRef, type Remote } from '../lib/remote.js';
import { parseBody } from '../lib/validate.js';

const tracks = new Hono<AuthedBindings>();
for (const p of ['/projects/:id/files', '/projects/:id/tracks', '/files/*', '/tracks/*', '/account/storage']) tracks.use(p, requireUser);

const bad = (c: Context) => c.json({ error: 'invalid_request' }, 400);
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);
const store = (env: Env, projectId: string) => env.FILES.get(env.FILES.idFromName(projectId));

interface FileRow {
  id: string;
  project_id: string;
  uploader_id: string;
  status: string;
  enc_size: number;
  chunk_count: number;
  storage: 'arai' | Remote;
  remote_ref: string | null;
}

/** One encrypted chunk, from Arai's storage or relayed from the uploader's own cloud. */
export async function readChunk(env: Env, file: Pick<FileRow, 'id' | 'project_id' | 'enc_size' | 'storage' | 'remote_ref'>, idx: number): Promise<ArrayBuffer | null> {
  if (file.storage === 'arai') return store(env, file.project_id).getChunk(file.id, idx);
  return fetchRemoteChunk(env, file.storage, file.remote_ref ?? '', file.enc_size, idx);
}

/** 404 for outsiders, 403 for members without the role. */
async function gate(c: Context<AuthedBindings>, projectId: string, min: 'listener' | 'editor' | 'admin') {
  const userId = c.get('session').user_id;
  const m = await requireProjectRole(c.env.DB, projectId, userId, min);
  if (m) return { ok: true as const };
  const any = min === 'listener' ? null : await requireProjectRole(c.env.DB, projectId, userId, 'listener');
  return { ok: false as const, res: any ? c.json({ error: 'forbidden' }, 403) : notFound(c) };
}

async function loadFile(db: D1Database, id: string): Promise<FileRow | null> {
  return db.prepare("SELECT id, project_id, uploader_id, status, enc_size, chunk_count, storage, remote_ref FROM files WHERE id = ? AND status != 'deleted'").bind(id).first<FileRow>();
}

export async function usage(db: D1Database, userId: string) {
  const mine = await db
    .prepare("SELECT (SELECT COALESCE(SUM(enc_size), 0) FROM files WHERE uploader_id = ?1 AND status != 'deleted' AND storage = 'arai') + (SELECT COALESCE(SUM(enc_size), 0) FROM conv_files WHERE uploader_id = ?1 AND status != 'deleted') AS n")
    .bind(userId)
    .first<{ n: number }>();
  const all = await db
    .prepare("SELECT (SELECT COALESCE(SUM(enc_size), 0) FROM files WHERE status != 'deleted' AND storage = 'arai') + (SELECT COALESCE(SUM(enc_size), 0) FROM conv_files WHERE status != 'deleted') AS n")
    .first<{ n: number }>();
  return { mine: mine?.n ?? 0, all: all?.n ?? 0 };
}

tracks.get('/account/storage', async (c) => {
  const u = await usage(c.env.DB, c.get('session').user_id);
  return c.json({ used: u.mine, quota: Number(c.env.USER_QUOTA_BYTES), platformFull: u.all >= Number(c.env.PLATFORM_QUOTA_BYTES) });
});

// ---- files: register → upload chunks → complete --------------------------

tracks.post('/projects/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const g = await gate(c, projectId, 'editor');
  if (!g.ok) return g.res;
  const body = await parseBody(c, createFileRequest);
  if (!body) return bad(c);
  const userId = c.get('session').user_id;
  const project = await c.env.DB.prepare('SELECT key_version FROM projects WHERE id = ?').bind(projectId).first<{ key_version: number }>();
  if (body.keyVersion !== project!.key_version) return c.json({ error: 'stale_key' }, 409);
  if (body.storage !== 'arai') {
    // The uploader's own cloud: the file is already there (ciphertext). Check it, then it is ready.
    const linked = await c.env.DB.prepare('SELECT 1 FROM storage_accounts WHERE user_id = ? AND provider = ?').bind(userId, body.storage).first();
    if (!linked || !validRemoteRef(body.storage, body.remoteRef!)) return bad(c);
    if (!(await remoteSizeOk(c.env, body.storage, body.remoteRef!, body.encSize))) return c.json({ error: 'remote_unreadable' }, 409);
    try {
      await c.env.DB.prepare(
        `INSERT INTO files (id, project_id, uploader_id, kind, enc_size, chunk_count, enc_file_key, key_version, status, storage, remote_ref, created_at, completed_at)
         VALUES (?, ?, ?, 'audio', ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      ).bind(body.id, projectId, userId, body.encSize, body.chunkCount, fromB64(body.encFileKey), body.keyVersion, body.storage, body.remoteRef, Date.now(), Date.now()).run();
    } catch (e) {
      if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
      throw e;
    }
    return c.json({ ok: true, status: 'ready' }, 201);
  }
  const u = await usage(c.env.DB, userId);
  if (u.mine + body.encSize > Number(c.env.USER_QUOTA_BYTES)) return c.json({ error: 'quota_exceeded' }, 413);
  if (u.all + body.encSize > Number(c.env.PLATFORM_QUOTA_BYTES)) return c.json({ error: 'storage_full' }, 507);
  try {
    await c.env.DB.prepare(
      `INSERT INTO files (id, project_id, uploader_id, kind, enc_size, chunk_count, enc_file_key, key_version, created_at)
       VALUES (?, ?, ?, 'audio', ?, ?, ?, ?, ?)`,
    ).bind(body.id, projectId, userId, body.encSize, body.chunkCount, fromB64(body.encFileKey), body.keyVersion, Date.now()).run();
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  return c.json({ ok: true }, 201);
});

tracks.put('/files/:fileId/chunks/:idx', async (c) => {
  const file = await loadFile(c.env.DB, c.req.param('fileId'));
  if (!file) return notFound(c);
  const g = await gate(c, file.project_id, 'editor');
  if (!g.ok) return g.res;
  if (file.uploader_id !== c.get('session').user_id) return c.json({ error: 'forbidden' }, 403);
  if (file.status !== 'pending' || file.storage !== 'arai') return c.json({ error: 'already_complete' }, 409);
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunk_count) return bad(c);
  const expected = expectedChunkSize(file.enc_size, file.chunk_count, idx);
  const declared = Number(c.req.header('Content-Length') ?? NaN);
  if (declared !== expected) return c.json({ error: 'bad_chunk_size' }, 400);
  const data = await c.req.arrayBuffer();
  if (data.byteLength !== expected) return c.json({ error: 'bad_chunk_size' }, 400);
  await store(c.env, file.project_id).putChunk(file.id, idx, data);
  return c.json({ ok: true });
});

tracks.get('/files/:fileId/status', async (c) => {
  const file = await loadFile(c.env.DB, c.req.param('fileId'));
  if (!file) return notFound(c);
  const g = await gate(c, file.project_id, 'listener');
  if (!g.ok) return g.res;
  const sizes = await store(c.env, file.project_id).chunkSizes(file.id);
  return c.json({ status: file.status, received: sizes.map((s) => s.idx) });
});

tracks.post('/files/:fileId/complete', async (c) => {
  const file = await loadFile(c.env.DB, c.req.param('fileId'));
  if (!file) return notFound(c);
  const g = await gate(c, file.project_id, 'editor');
  if (!g.ok) return g.res;
  if (file.uploader_id !== c.get('session').user_id) return c.json({ error: 'forbidden' }, 403);
  if (file.status === 'ready') return c.json({ ok: true });
  const sizes = await store(c.env, file.project_id).chunkSizes(file.id);
  const complete = sizes.length === file.chunk_count && sizes.every((s, i) => s.idx === i && s.size === expectedChunkSize(file.enc_size, file.chunk_count, i));
  if (!complete) return c.json({ error: 'incomplete', received: sizes.map((s) => s.idx) }, 409);
  await c.env.DB.prepare("UPDATE files SET status = 'ready', completed_at = ? WHERE id = ?").bind(Date.now(), file.id).run();
  return c.json({ ok: true });
});

tracks.get('/files/:fileId/chunks/:idx', async (c) => {
  const file = await loadFile(c.env.DB, c.req.param('fileId'));
  if (!file || file.status !== 'ready') return notFound(c);
  const g = await gate(c, file.project_id, 'listener');
  if (!g.ok) return g.res;
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunk_count) return bad(c);
  const data = await readChunk(c.env, file, idx);
  if (!data) return file.storage === 'arai' ? notFound(c) : c.json({ error: 'remote_unavailable' }, 502);
  // Ciphertext of an immutable chunk: safe for the browser's private cache.
  return new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' } });
});

// ---- tracks & versions ------------------------------------------------------

async function usableFile(db: D1Database, fileId: string, projectId: string): Promise<boolean> {
  const f = await db
    .prepare("SELECT 1 FROM files f WHERE f.id = ? AND f.project_id = ? AND f.status = 'ready' AND NOT EXISTS (SELECT 1 FROM track_versions v WHERE v.file_id = f.id)")
    .bind(fileId, projectId)
    .first();
  return !!f;
}

async function currentKey(db: D1Database, projectId: string): Promise<number> {
  const p = await db.prepare('SELECT key_version FROM projects WHERE id = ?').bind(projectId).first<{ key_version: number }>();
  return p!.key_version;
}

export async function listTracks(db: D1Database, projectId: string, trackId?: string): Promise<TrackDto[]> {
  const t = await db
    .prepare(`SELECT id, enc_meta, key_version, position, current_version_id, created_at, updated_at FROM tracks WHERE project_id = ? AND deleted_at IS NULL ${trackId ? 'AND id = ?' : ''} ORDER BY position, created_at`)
    .bind(...(trackId ? [projectId, trackId] : [projectId]))
    .all<{ id: string; enc_meta: ArrayBuffer; key_version: number; position: number; current_version_id: string | null; created_at: number; updated_at: number }>();
  if (t.results.length === 0) return [];
  const v = await db
    .prepare(
      `SELECT v.id, v.track_id, v.number, v.enc_meta, v.key_version AS meta_key_version, v.created_by, v.created_at, f.id AS file_id, f.enc_size, f.chunk_count, f.enc_file_key, f.key_version, f.storage, f.remote_ref
         FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN files f ON f.id = v.file_id
        WHERE t.project_id = ? AND t.deleted_at IS NULL ORDER BY v.number`,
    )
    .bind(projectId)
    .all<{ id: string; track_id: string; number: number; enc_meta: ArrayBuffer; meta_key_version: number; created_by: string; created_at: number; file_id: string; enc_size: number; chunk_count: number; enc_file_key: ArrayBuffer; key_version: number; storage: 'arai' | Remote; remote_ref: string | null }>();
  return t.results.map((r) => ({
    id: r.id,
    encMeta: toB64(r.enc_meta),
    keyVersion: r.key_version,
    position: r.position,
    currentVersionId: r.current_version_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    versions: v.results
      .filter((x) => x.track_id === r.id)
      .map((x) => ({
        id: x.id,
        number: x.number,
        encMeta: toB64(x.enc_meta),
        keyVersion: x.meta_key_version,
        createdBy: x.created_by,
        createdAt: x.created_at,
        file: { id: x.file_id, encSize: x.enc_size, chunkCount: x.chunk_count, encFileKey: toB64(x.enc_file_key), keyVersion: x.key_version, storage: x.storage, remoteRef: x.remote_ref },
      })),
  }));
}

tracks.get('/projects/:id/tracks', async (c) => {
  const projectId = c.req.param('id');
  const g = await gate(c, projectId, 'listener');
  if (!g.ok) return g.res;
  return c.json({ tracks: await listTracks(c.env.DB, projectId) });
});

tracks.post('/projects/:id/tracks', async (c) => {
  const projectId = c.req.param('id');
  const g = await gate(c, projectId, 'editor');
  if (!g.ok) return g.res;
  const body = await parseBody(c, createTrackRequest);
  if (!body) return bad(c);
  const kv = await currentKey(c.env.DB, projectId);
  if (body.keyVersion !== kv || body.version.keyVersion !== kv) return c.json({ error: 'stale_key' }, 409);
  if (!(await usableFile(c.env.DB, body.version.fileId, projectId))) return c.json({ error: 'file_not_ready' }, 409);
  const userId = c.get('session').user_id;
  const now = Date.now();
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM tracks WHERE project_id = ?').bind(projectId).first<{ p: number }>();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO tracks (id, project_id, enc_meta, key_version, position, current_version_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        body.id, projectId, fromB64(body.encMeta), kv, (max?.p ?? 0) + 1, body.version.id, userId, now, now,
      ),
      c.env.DB.prepare('INSERT INTO track_versions (id, track_id, number, file_id, enc_meta, key_version, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').bind(
        body.version.id, body.id, body.version.fileId, fromB64(body.version.encMeta), kv, userId, now,
      ),
      c.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  return c.json({ track: (await listTracks(c.env.DB, projectId, body.id))[0] }, 201);
});

async function trackProject(db: D1Database, trackId: string): Promise<string | null> {
  const t = await db.prepare('SELECT project_id FROM tracks WHERE id = ? AND deleted_at IS NULL').bind(trackId).first<{ project_id: string }>();
  return t?.project_id ?? null;
}

tracks.post('/tracks/:trackId/versions', async (c) => {
  const trackId = c.req.param('trackId');
  const projectId = await trackProject(c.env.DB, trackId);
  if (!projectId) return notFound(c);
  const g = await gate(c, projectId, 'editor');
  if (!g.ok) return g.res;
  const body = await parseBody(c, addVersionRequest);
  if (!body) return bad(c);
  if (body.keyVersion !== (await currentKey(c.env.DB, projectId))) return c.json({ error: 'stale_key' }, 409);
  if (!(await usableFile(c.env.DB, body.fileId, projectId))) return c.json({ error: 'file_not_ready' }, 409);
  const now = Date.now();
  const n = await c.env.DB.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM track_versions WHERE track_id = ?').bind(trackId).first<{ n: number }>();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO track_versions (id, track_id, number, file_id, enc_meta, key_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        body.id, trackId, (n?.n ?? 0) + 1, body.fileId, fromB64(body.encMeta), body.keyVersion, c.get('session').user_id, now,
      ),
      c.env.DB.prepare('UPDATE tracks SET current_version_id = ?, updated_at = ? WHERE id = ?').bind(body.id, now, trackId),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) return c.json({ error: 'id_taken' }, 409);
    throw e;
  }
  return c.json({ track: (await listTracks(c.env.DB, projectId, trackId))[0] }, 201);
});

tracks.patch('/tracks/:trackId', async (c) => {
  const trackId = c.req.param('trackId');
  const projectId = await trackProject(c.env.DB, trackId);
  if (!projectId) return notFound(c);
  const g = await gate(c, projectId, 'editor');
  if (!g.ok) return g.res;
  const body = await parseBody(c, updateTrackRequest);
  if (!body) return bad(c);
  if (body.currentVersionId) {
    const ok = await c.env.DB.prepare('SELECT 1 FROM track_versions WHERE id = ? AND track_id = ?').bind(body.currentVersionId, trackId).first();
    if (!ok) return bad(c);
  }
  const sets = ['updated_at = ?'];
  const args: unknown[] = [Date.now()];
  if (body.encMeta !== undefined) {
    if (body.keyVersion !== (await currentKey(c.env.DB, projectId))) return c.json({ error: 'stale_key' }, 409);
    sets.push('enc_meta = ?', 'key_version = ?');
    args.push(fromB64(body.encMeta), body.keyVersion);
  }
  if (body.currentVersionId !== undefined) {
    sets.push('current_version_id = ?');
    args.push(body.currentVersionId);
  }
  if (body.position !== undefined) {
    sets.push('position = ?');
    args.push(body.position);
  }
  await c.env.DB.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).bind(...args, trackId).run();
  return c.json({ track: (await listTracks(c.env.DB, projectId, trackId))[0] });
});

/** Releases storage for files no longer referenced by a live track. */
export async function purgeFiles(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, projectId: string, fileIds: string[]) {
  if (fileIds.length === 0) return;
  const now = Date.now();
  await env.DB.batch(fileIds.map((id) => env.DB.prepare("UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(now, id)));
  // Files in someone's own cloud are removed by their browser (Arai holds no write access).
  ctx.waitUntil(Promise.all(fileIds.map((id) => store(env, projectId).deleteFile(id))));
}

tracks.delete('/tracks/:trackId', async (c) => {
  const trackId = c.req.param('trackId');
  const projectId = await trackProject(c.env.DB, trackId);
  if (!projectId) return notFound(c);
  const g = await gate(c, projectId, 'admin');
  if (!g.ok) return g.res;
  await c.env.DB.prepare('UPDATE tracks SET deleted_at = ? WHERE id = ?').bind(Date.now(), trackId).run();
  const files = await c.env.DB.prepare('SELECT file_id FROM track_versions WHERE track_id = ?').bind(trackId).all<{ file_id: string }>();
  await purgeFiles(c.env, c.executionCtx, projectId, files.results.map((f) => f.file_id));
  return c.json({ ok: true });
});

// ---- listening stats (daily counts only) -------------------------------------

export async function countPlay(db: D1Database, trackId: string, source: 'member' | 'link') {
  const day = Math.floor(Date.now() / 86400_000);
  await db.prepare('INSERT INTO track_plays (track_id, day, source, count) VALUES (?, ?, ?, 1) ON CONFLICT(track_id, day, source) DO UPDATE SET count = count + 1').bind(trackId, day, source).run();
}

tracks.post('/tracks/:trackId/play', async (c) => {
  const trackId = c.req.param('trackId');
  const projectId = await trackProject(c.env.DB, trackId);
  if (!projectId) return notFound(c);
  const g = await gate(c, projectId, 'listener');
  if (!g.ok) return g.res;
  // One count per person per track every 30 s keeps replays from inflating numbers.
  const { rateLimit } = await import('../lib/ratelimit.js');
  if (await rateLimit(c.env.DB, `play:${c.get('session').user_id}:${trackId}`, 1, 30_000)) await countPlay(c.env.DB, trackId, 'member');
  return c.json({ ok: true });
});

tracks.get('/projects/:id/plays', async (c) => {
  const projectId = c.req.param('id');
  const g = await gate(c, projectId, 'listener');
  if (!g.ok) return g.res;
  const since = Math.floor(Date.now() / 86400_000) - 30;
  const { results } = await c.env.DB.prepare(
    `SELECT p.track_id, SUM(p.count) AS total, SUM(CASE WHEN p.day > ? THEN p.count ELSE 0 END) AS recent, SUM(CASE WHEN p.source = 'link' THEN p.count ELSE 0 END) AS via_links
       FROM track_plays p JOIN tracks t ON t.id = p.track_id AND t.project_id = ? AND t.deleted_at IS NULL GROUP BY p.track_id`,
  )
    .bind(since, projectId)
    .all<{ track_id: string; total: number; recent: number; via_links: number }>();
  return c.json({ plays: Object.fromEntries(results.map((r) => [r.track_id, { total: r.total, last30: r.recent, viaLinks: r.via_links }])) });
});

export default tracks;
