/**
 * Page side of streaming playback (see src/sw.ts). Falls back to
 * full-file decryption when no service worker controls the page
 * (first visit before activation, dev server, unsupported browser).
 */
import type { Project } from './projects';
import { fileKeyOf, type TrackVersion } from './tracks';

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
  const fileKey = await fileKeyOf(project, v).catch(() => null);
  if (!fileKey) return null;
  const url = await registerStream(sw, { fileId: v.file.id, key: fileKey, count: v.file.chunkCount, encSize: v.file.encSize, mime: v.meta?.mime ?? 'application/octet-stream' });
  tokens.set(v.id, url);
  return url;
}

export interface StreamSource {
  fileId: string;
  key: Uint8Array;
  count: number;
  encSize: number;
  mime: string;
  /** Share links: chunk URL prefix and access token instead of the session cookie. */
  base?: string;
  shareToken?: string;
}

/** Registers a decryptable stream with the service worker; returns its URL. */
export async function registerStream(sw: ServiceWorker, reg: StreamSource): Promise<string> {
  const token = crypto.randomUUID();
  await send(sw, { type: 'register', token, reg });
  return `/_stream/${token}`;
}

/** For pages outside the app shell (share links): a stream URL or null. */
export async function streamFor(reg: StreamSource): Promise<string | null> {
  const sw = navigator.serviceWorker?.controller ?? (await startStreamingWorker());
  return sw ? registerStream(sw, reg).catch(() => null) : null;
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
