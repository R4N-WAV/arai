/**
 * Reading encrypted files that users keep in their own Dropbox / Google
 * Drive. Only fixed, allow-listed hosts are ever fetched (no SSRF): the
 * stored reference is validated and the URL is rebuilt from it.
 */
import { CHUNK_OVERHEAD, CHUNK_SIZE } from '@arai/shared';
import type { Env } from '../env.js';

export type Remote = 'dropbox' | 'gdrive';

/** Dropbox shared links (/s/… legacy or /scl/fi/… with rlkey) and Drive file ids. */
const DROPBOX_REF = /^https:\/\/www\.dropbox\.com\/(s\/[A-Za-z0-9]{8,40}\/[^?#\s]{1,200}|scl\/fi\/[A-Za-z0-9]{8,40}\/[^?#\s]{1,200}\?rlkey=[A-Za-z0-9]{8,64})$/;
const GDRIVE_REF = /^[A-Za-z0-9_-]{10,100}$/;

export function validRemoteRef(storage: Remote, ref: string): boolean {
  return storage === 'dropbox' ? DROPBOX_REF.test(ref) : GDRIVE_REF.test(ref);
}

/** The direct-download URL for a stored reference (null if the provider is not configured). */
export function remoteUrl(env: Env, storage: Remote, ref: string): string | null {
  if (!validRemoteRef(storage, ref)) return null;
  if (storage === 'dropbox') {
    const u = new URL(ref);
    // DROPBOX_DL_ORIGIN exists only for local end-to-end tests (a mock server); production uses Dropbox.
    return `${env.DROPBOX_DL_ORIGIN ?? 'https://dl.dropboxusercontent.com'}${u.pathname}${u.search}`;
  }
  if (!env.GOOGLE_API_KEY) return null;
  return `https://www.googleapis.com/drive/v3/files/${ref}?alt=media&key=${encodeURIComponent(env.GOOGLE_API_KEY)}`;
}

/** Byte range of chunk `idx` inside the single concatenated remote file. */
export function chunkRange(encSize: number, idx: number): { start: number; end: number } {
  const full = CHUNK_SIZE + CHUNK_OVERHEAD;
  const start = idx * full;
  return { start, end: Math.min(encSize, start + full) - 1 };
}

export async function fetchRemoteChunk(env: Env, storage: Remote, ref: string, encSize: number, idx: number): Promise<ArrayBuffer | null> {
  const url = remoteUrl(env, storage, ref);
  if (!url) return null;
  const { start, end } = chunkRange(encSize, idx);
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
  if (res.status !== 206 && res.status !== 200) return null;
  const buf = await res.arrayBuffer();
  if (res.status === 200) return buf.byteLength === encSize ? buf.slice(start, end + 1) : null;
  return buf.byteLength === end - start + 1 ? buf : null;
}

/** Confirms the remote file exists and has exactly the declared size. */
export async function remoteSizeOk(env: Env, storage: Remote, ref: string, encSize: number): Promise<boolean> {
  const url = remoteUrl(env, storage, ref);
  if (!url) return false;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    const total = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '')?.[1];
    await res.body?.cancel();
    return res.status === 206 && Number(total) === encSize;
  } catch {
    return false;
  }
}
