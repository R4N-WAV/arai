import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppBindings } from './env.js';
import { randomId } from './lib/ids.js';
import { originGuard, securityHeaders } from './lib/security.js';

const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  c.set('requestId', randomId(8));
  await next();
});
app.use('*', securityHeaders);
app.use('/api/*', originGuard);
app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ status: db?.ok === 1 ? 'ok' : 'degraded' });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Never leak internals: log server-side, return an opaque id.
app.onError((err, c) => {
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: String(err) }));
  return c.json({ error: 'internal', requestId: c.get('requestId') }, 500);
});

export default app;
