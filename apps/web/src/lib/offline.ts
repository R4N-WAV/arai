/**
 * Offline copies: the encrypted chunks of a version are stored in the
 * browser's Cache Storage exactly as the server sent them (ciphertext). The
 * streaming service worker falls back to this cache when the network fails.
 * Playing still needs the project key, which only exists in an unlocked tab.
 */
import type { TrackVersion } from './tracks';

const CACHE = 'arai-offline-v1';
const url = (fileId: string, i: number) => `/api/files/${fileId}/chunks/${i}`;
const listKey = 'arai-offline-files';

function list(): Record<string, { name: string; bytes: number; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(listKey) ?? '{}');
  } catch {
    return {};
  }
}
function save(l: ReturnType<typeof list>) {
  try {
    localStorage.setItem(listKey, JSON.stringify(l));
  } catch {
    /* private mode: the cache still works for this session */
  }
}

export const offlineSupported = () => typeof caches !== 'undefined';
export const isOffline = (fileId: string) => !!list()[fileId];
export const offlineFiles = () => list();

export async function keepOffline(v: TrackVersion, name: string, onProgress?: (p: number) => void): Promise<void> {
  const cache = await caches.open(CACHE);
  for (let i = 0; i < v.file.chunkCount; i++) {
    const res = await fetch(url(v.file.id, i), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('download_failed');
    await cache.put(url(v.file.id, i), res);
    onProgress?.((i + 1) / v.file.chunkCount);
  }
  save({ ...list(), [v.file.id]: { name, bytes: v.file.encSize, at: Date.now() } });
}

export async function removeOffline(fileId: string, chunkCount?: number): Promise<void> {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.filter((k) => new URL(k.url).pathname.startsWith(`/api/files/${fileId}/`)).map((k) => cache.delete(k)));
  void chunkCount;
  const l = list();
  delete l[fileId];
  save(l);
}

export async function clearOffline(): Promise<void> {
  await caches.delete(CACHE);
  save({});
}
