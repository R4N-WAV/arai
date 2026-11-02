/// <reference lib="webworker" />
/**
 * Arai streaming service worker.
 *
 * The page registers a short-lived stream token with the file's decryption
 * key (kept in this worker's memory only, never stored). <audio> then plays
 * /_stream/<token>; this worker answers HTTP Range requests by fetching the
 * encrypted 1 MiB chunks, verifying + decrypting them, and streaming the
 * plaintext bytes, so playback starts after the first chunk instead of after
 * the whole file. If the worker restarts and forgets a token, it answers 410
 * and the page falls back to its in-memory decrypt.
 */
import { decryptChunk } from '@arai/crypto';

declare const self: ServiceWorkerGlobalScope;

const CHUNK = 1024 * 1024;
const OVERHEAD = 40;

interface Reg {
  fileId: string;
  key: Uint8Array;
  count: number;
  encSize: number;
  mime: string;
  base?: string;
  shareToken?: string;
}

const regs = new Map<string, Reg>();
const plainCache = new Map<string, Promise<Uint8Array>>(); // `${fileId}:${i}` → decrypted chunk (bounded)

const plainSize = (r: Reg) => r.encSize - r.count * OVERHEAD;

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e: ExtendableMessageEvent) => {
  const d = e.data as { type: string; token?: string; reg?: Reg };
  if (d?.type === 'register' && d.token && d.reg) {
    regs.set(d.token, d.reg);
    // Keep memory bounded: only recent streams stay registered.
    if (regs.size > 32) regs.delete(regs.keys().next().value!);
    e.ports[0]?.postMessage('ok');
  } else if (d?.type === 'forget-all') {
    regs.clear();
    plainCache.clear();
    e.ports[0]?.postMessage('ok');
  }
});

self.addEventListener('fetch', (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/_stream/')) {
    e.respondWith(stream(e.request, url.pathname.slice('/_stream/'.length)));
  }
});

/** Network first; the offline copy (ciphertext in Cache Storage) when the network fails. */
async function memberChunk(fileId: string, i: number): Promise<Response> {
  const url = `/api/files/${fileId}/chunks/${i}`;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.ok) return res;
    const cached = await caches.match(url, { cacheName: 'arai-offline-v1' });
    return cached ?? res;
  } catch (e) {
    const cached = await caches.match(url, { cacheName: 'arai-offline-v1' });
    if (cached) return cached;
    throw e;
  }
}

function chunk(r: Reg, i: number): Promise<Uint8Array> {
  const id = `${r.fileId}:${i}`;
  let p = plainCache.get(id);
  if (!p) {
    p = (async () => {
      const res = r.base
        ? await fetch(`${r.base}${r.fileId}/chunks/${i}`, { headers: { 'X-Share-Token': r.shareToken ?? '' }, credentials: 'omit' })
        : await memberChunk(r.fileId, i);
      if (!res.ok) throw new Error(`chunk ${i}: ${res.status}`);
      return decryptChunk(r.key, r.fileId, i, i === r.count - 1, new Uint8Array(await res.arrayBuffer()));
    })();
    p.catch(() => plainCache.delete(id));
    plainCache.set(id, p);
    if (plainCache.size > 48) plainCache.delete(plainCache.keys().next().value!);
  }
  return p;
}

async function stream(req: Request, token: string): Promise<Response> {
  const r = regs.get(token);
  if (!r) return new Response('stream expired', { status: 410 });
  const size = plainSize(r);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('Range') ?? '');
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] === '' && m[2]) start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1] || 0);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
  }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const first = Math.floor(start / CHUNK);
  const last = Math.floor(end / CHUNK);
  let i = first;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i > last) return ctrl.close();
      // Read ahead so the next chunk is decrypted before it is needed.
      for (let k = 1; k <= 2 && i + k <= last; k++) void chunk(r, i + k).catch(() => undefined);
      try {
        const plain = await chunk(r, i);
        const s = i === first ? start - i * CHUNK : 0;
        const e = i === last ? end - i * CHUNK + 1 : plain.length;
        ctrl.enqueue(plain.subarray(s, e));
        i++;
      } catch (err) {
        ctrl.error(err);
      }
    },
  });
  return new Response(body, {
    status: m ? 206 : 200,
    headers: {
      'Content-Type': r.mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Cache-Control': 'no-store',
    },
  });
}

// ---- Web Push (phase 13) ------------------------------------------------------
// Pushes arrive empty. The worker asks Arai (with this device's session) what
// happened and shows names and counts only; private content never leaves the
// encrypted channel, not even to the push service.
interface Summary {
  latest: { kind: string; target_id: string | null; actor: string | null } | null;
  unread: number;
  message: { conversation_id: string; sender: string; n: number } | null;
  unreadMessages: number;
}

function describe(s: Summary): { title: string; body: string; url: string; tag: string } | null {
  if (s.message) {
    const more = s.message.n > 1 ? ` (${s.message.n} new)` : '';
    return { title: `@${s.message.sender}`, body: `New message${more}`, url: `/messages/${s.message.conversation_id}`, tag: `msg-${s.message.conversation_id}` };
  }
  const l = s.latest;
  if (!l) return null;
  const who = l.actor ? `@${l.actor}` : 'Someone';
  const text: Record<string, [string, string]> = {
    invite: [`${who} invited you to a project`, '/'],
    comment: [`${who} commented in a project`, l.target_id ? `/projects/${l.target_id}` : '/activity'],
    follow: [`${who} followed you`, '/activity'],
    friend_request: [`${who} wants to be friends`, '/activity'],
    friend_accept: [`${who} accepted your friend request`, '/activity'],
    moderation: ['A moderator reviewed something of yours', '/activity'],
  };
  const [body, url] = text[l.kind] ?? ['Something new in Arai', '/activity'];
  return { title: 'Arai', body, url, tag: `n-${l.kind}` };
}

self.addEventListener('push', (e: PushEvent) => {
  e.waitUntil(
    (async () => {
      let s: Summary | null = null;
      try {
        const res = await fetch('/api/push/summary', { credentials: 'same-origin' });
        if (res.ok) s = (await res.json()) as Summary;
      } catch {
        /* offline: fall through to a generic notice */
      }
      const n = s ? describe(s) : null;
      const badge = s ? s.unread + s.unreadMessages : 0;
      const nav = self.navigator as Navigator & { setAppBadge?: (n: number) => Promise<void> };
      if (nav.setAppBadge) await nav.setAppBadge(badge).catch(() => undefined);
      // Browsers require a visible notification for every push.
      await self.registration.showNotification(n?.title ?? 'Arai', {
        body: n?.body ?? 'Something new in Arai',
        tag: n?.tag ?? 'arai',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: n?.url ?? '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e: NotificationEvent) => {
  e.notification.close();
  const url = new URL((e.notification.data as { url?: string })?.url ?? '/', self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin) as WindowClient | undefined;
      if (open) {
        await open.focus();
        await open.navigate(url).catch(() => undefined);
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
