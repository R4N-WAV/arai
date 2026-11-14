import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../env.js';

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  // 'self' covers same-origin WebSockets in current browsers; the production wss origin is listed for older Safari.
  "connect-src 'self' blob: wss://arai.ranuj-s.workers.dev https://api.dropboxapi.com https://content.dropboxapi.com https://www.googleapis.com",
  "font-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Security headers on every response. */
export const securityHeaders: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('Content-Security-Policy', CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  if (new URL(c.req.url).protocol === 'https:') {
    h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  if (c.req.path.startsWith('/api/') && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (cookies are also SameSite=Strict): state-changing
 * API requests must come from our own origin and carry a custom header,
 * which cross-site forms cannot set without a CORS preflight we never grant.
 */
export const originGuard: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    // The SPA and API share one origin, so the browser-sent Origin must equal
    // the origin this request was addressed to (works on workers.dev and any
    // future custom domain without configuration).
    const origin = c.req.header('Origin');
    if (origin !== new URL(c.req.url).origin || c.req.header('X-Arai-CSRF') !== '1') {
      return c.json({ error: 'forbidden_origin' }, 403);
    }
  }
  await next();
};
