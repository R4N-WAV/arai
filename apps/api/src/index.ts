import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppBindings } from './env.js';
import { randomId } from './lib/ids.js';
import { originGuard, securityHeaders } from './lib/security.js';
import auth from './routes/auth.js';
import projects from './routes/projects.js';
import tracks from './routes/tracks.js';
import profiles from './routes/profiles.js';
import collab from './routes/collab.js';
import social from './routes/social.js';
import messages from './routes/messages.js';
import admin from './routes/admin.js';
export { FileStore } from './filestore.js';
export { UserHub } from './hub.js';

const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  c.set('requestId', randomId(8));
  await next();
});
app.use('*', securityHeaders);
app.use('/api/*', originGuard);
const jsonLimit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });
const chunkLimit = bodyLimit({ maxSize: 1024 * 1024 + 64, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });
// Only encrypted audio chunks, profile images and encrypted share payloads may exceed 64 KB (up to 1 MiB).
const isBinaryUpload = (method: string, path: string) =>
  ((method === 'POST' || method === 'PUT') && /^\/api\/projects\/[a-z2-7]{26}\/shares(\/[a-z2-7]{26})?$/.test(path)) ||
  (method === 'PUT' && (/^\/api\/(files|conv-files)\/[a-z2-7]{26}\/chunks\/\d+$/.test(path) || /^\/api\/account\/profile\/(avatar|banner)$/.test(path)));
app.use('/api/*', (c, next) => (isBinaryUpload(c.req.method, c.req.path) ? chunkLimit(c, next) : jsonLimit(c, next)));

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ status: db?.ok === 1 ? 'ok' : 'degraded' });
});

app.route('/api', auth);
app.route('/api', projects);
app.route('/api', tracks);
app.route('/api', profiles);
app.route('/api', collab);
app.route('/api', social);
app.route('/api', messages);
app.route('/api', admin);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Never leak internals: log server-side, return an opaque id.
app.onError((err, c) => {
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: String(err) }));
  return c.json({ error: 'internal', requestId: c.get('requestId') }, 500);
});

export default app;
