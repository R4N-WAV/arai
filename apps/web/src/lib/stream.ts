/**
 * Page side of streaming playback (see src/sw.ts). Falls back to
 * full-file decryption when no service worker controls the page
 * (first visit before activation, dev server, unsupported browser).
 */
import { fromBase64Url, open } from '@arai/crypto';
import type { Project } from './projects';
import { projectKey } from './projects';
import type { TrackVersion } from './tracks';

let ready: Promise<ServiceWorker | null> | null = null;

export function startStreamingWorker(): Promise<ServiceWorker | null> {
  ready ??= (async () => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return null;
    try {
      await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' });
      if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
      // First visit: wait briefly for the new worker to claim this page.
      return await new Promise<ServiceWorker | null>((resolve) => {
        const t = setTimeout(() => resolve(navigator.serviceWorker.controller), 4000);
        navigator.serviceWorker.addEventListener('controllerchange', () => (clearTimeout(t), resolve(navigator.serviceWorker.controller)), { once: true });
      });
    } catch {
      return null;
    }
  })();
  return ready;
}

function send(sw: ServiceWorker, msg: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error('sw timeout')), 3000);
    ch.port1.onmessage = () => (clearTimeout(t), resolve());
    sw.postMessage(msg, [ch.port2]);
  });
}

const tokens = new Map<string, string>(); // version id → stream url

/** A URL that starts playing as soon as the first chunk is decrypted, or null if streaming is unavailable. */
export async function streamUrl(project: Project, v: TrackVersion): Promise<string | null> {
  const cached = tokens.get(v.id);
  const sw = navigator.serviceWorker?.controller ?? (await startStreamingWorker());
  if (!sw) return null;
  if (cached) return cached;
  const key = projectKey(project);
  if (!key) return null;
  const fileKey = await open(key, await fromBase64Url(v.file.encFileKey), `file/${v.file.id}/key`);
  const token = crypto.randomUUID();
  await send(sw, { type: 'register', token, reg: { fileId: v.file.id, key: fileKey, count: v.file.chunkCount, encSize: v.file.encSize, mime: v.meta?.mime ?? 'application/octet-stream' } });
  const url = `/_stream/${token}`;
  tokens.set(v.id, url);
  return url;
}

/** Warm up the first chunk of a track so starting it is instant. */
export async function prefetch(project: Project, v: TrackVersion): Promise<void> {
  const url = await streamUrl(project, v).catch(() => null);
  if (url) await fetch(url, { headers: { Range: 'bytes=0-65535' } }).then((r) => r.body?.cancel()).catch(() => undefined);
}

export async function forgetStreams(): Promise<void> {
  tokens.clear();
  const sw = navigator.serviceWorker?.controller;
  if (sw) await send(sw, { type: 'forget-all' }).catch(() => undefined);
}
