import { addVersionRequest, createFileRequest, createTrackRequest, expectedChunkSize, updateTrackRequest, type TrackDto } from '@arai/shared';
import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { fromB64, toB64 } from '../lib/crypto.js';
import { requireProjectRole } from '../lib/projects.js';
import { requireUser, type AuthedBindings } from '../lib/session.js';
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
  return db.prepare("SELECT id, project_id, uploader_id, status, enc_size, chunk_count FROM files WHERE id = ? AND status != 'deleted'").bind(id).first<FileRow>();
}

export async function usage(db: D1Database, userId: string) {
  const mine = await db.prepare("SELECT COALESCE(SUM(enc_size), 0) AS n FROM files WHERE uploader_id = ? AND status != 'deleted'").bind(userId).first<{ n: number }>();
  const all = await db.prepare("SELECT COALESCE(SUM(enc_size), 0) AS n FROM files WHERE status != 'deleted'").first<{ n: number }>();
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
  if (file.status !== 'pending') return c.json({ error: 'already_complete' }, 409);
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
  const data = await store(c.env, file.project_id).getChunk(file.id, idx);
  if (!data) return notFound(c);
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

async function listTracks(db: D1Database, projectId: string, trackId?: string): Promise<TrackDto[]> {
  const t = await db
    .prepare(`SELECT id, enc_meta, position, current_version_id, created_at, updated_at FROM tracks WHERE project_id = ? AND deleted_at IS NULL ${trackId ? 'AND id = ?' : ''} ORDER BY position, created_at`)
    .bind(...(trackId ? [projectId, trackId] : [projectId]))
    .all<{ id: string; enc_meta: ArrayBuffer; position: number; current_version_id: string | null; created_at: number; updated_at: number }>();
  if (t.results.length === 0) return [];
  const v = await db
    .prepare(
      `SELECT v.id, v.track_id, v.number, v.enc_meta, v.created_by, v.created_at, f.id AS file_id, f.enc_size, f.chunk_count, f.enc_file_key, f.key_version
         FROM track_versions v JOIN tracks t ON t.id = v.track_id JOIN files f ON f.id = v.file_id
        WHERE t.project_id = ? AND t.deleted_at IS NULL ORDER BY v.number`,
    )
    .bind(projectId)
    .all<{ id: string; track_id: string; number: number; enc_meta: ArrayBuffer; created_by: string; created_at: number; file_id: string; enc_size: number; chunk_count: number; enc_file_key: ArrayBuffer; key_version: number }>();
  return t.results.map((r) => ({
    id: r.id,
    encMeta: toB64(r.enc_meta),
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
        createdBy: x.created_by,
        createdAt: x.created_at,
        file: { id: x.file_id, encSize: x.enc_size, chunkCount: x.chunk_count, encFileKey: toB64(x.enc_file_key), keyVersion: x.key_version },
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
  if (!(await usableFile(c.env.DB, body.version.fileId, projectId))) return c.json({ error: 'file_not_ready' }, 409);
  const userId = c.get('session').user_id;
  const now = Date.now();
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM tracks WHERE project_id = ?').bind(projectId).first<{ p: number }>();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO tracks (id, project_id, enc_meta, position, current_version_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        body.id, projectId, fromB64(body.encMeta), (max?.p ?? 0) + 1, body.version.id, userId, now, now,
      ),
      c.env.DB.prepare('INSERT INTO track_versions (id, track_id, number, file_id, enc_meta, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').bind(
        body.version.id, body.id, body.version.fileId, fromB64(body.version.encMeta), userId, now,
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
  if (!(await usableFile(c.env.DB, body.fileId, projectId))) return c.json({ error: 'file_not_ready' }, 409);
  const now = Date.now();
  const n = await c.env.DB.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM track_versions WHERE track_id = ?').bind(trackId).first<{ n: number }>();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO track_versions (id, track_id, number, file_id, enc_meta, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        body.id, trackId, (n?.n ?? 0) + 1, body.fileId, fromB64(body.encMeta), c.get('session').user_id, now,
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
  if (body.encMeta !== undefined) (sets.push('enc_meta = ?'), args.push(fromB64(body.encMeta)));
  if (body.currentVersionId !== undefined) (sets.push('current_version_id = ?'), args.push(body.currentVersionId));
  if (body.position !== undefined) (sets.push('position = ?'), args.push(body.position));
  await c.env.DB.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).bind(...args, trackId).run();
  return c.json({ track: (await listTracks(c.env.DB, projectId, trackId))[0] });
});

/** Releases storage for files no longer referenced by a live track. */
export async function purgeFiles(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, projectId: string, fileIds: string[]) {
  if (fileIds.length === 0) return;
  const now = Date.now();
  await env.DB.batch(fileIds.map((id) => env.DB.prepare("UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(now, id)));
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

export default tracks;
