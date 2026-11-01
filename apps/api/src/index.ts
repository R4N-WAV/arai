import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppBindings } from './env.js';
import { randomId } from './lib/ids.js';
import { originGuard, securityHeaders } from './lib/security.js';
import auth from './routes/auth.js';
import projects from './routes/projects.js';
import tracks from './routes/tracks.js';
export { FileStore } from './filestore.js';

const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  c.set('requestId', randomId(8));
  await next();
});
app.use('*', securityHeaders);
app.use('/api/*', originGuard);
const jsonLimit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });
const chunkLimit = bodyLimit({ maxSize: 1024 * 1024 + 64, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });
// Encrypted audio chunks are the only bodies allowed above 64 KB (1 MiB + AEAD overhead).
app.use('/api/*', (c, next) => (c.req.method === 'PUT' && /^\/api\/files\/[a-z2-7]{26}\/chunks\/\d+$/.test(c.req.path) ? chunkLimit(c, next) : jsonLimit(c, next)));

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ status: db?.ok === 1 ? 'ok' : 'degraded' });
});

app.route('/api', auth);
app.route('/api', projects);
app.route('/api', tracks);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Never leak internals: log server-side, return an opaque id.
app.onError((err, c) => {
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: String(err) }));
  return c.json({ error: 'internal', requestId: c.get('requestId') }, 500);
});

export default app;
