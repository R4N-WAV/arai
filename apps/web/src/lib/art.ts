/**
 * Project artwork. The image is cropped and re-encoded in the browser (which
 * strips metadata), encrypted with the project key and uploaded. Public
 * projects also get a plain copy so anyone can see the cover.
 */
import { open, seal, toBase64Url } from '@arai/crypto';
import { useEffect, useState } from 'react';
import { api } from './api';
import { coverColour } from './importer';
import { keyFor, projectKey, type Project } from './projects';

const ctx = (id: string) => `project/${id}/art`;
const urls = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
export const ART_PX = 1000;
export const ART_BYTES = 450 * 1024;

async function put(path: string, body: Uint8Array | Blob, headers: Record<string, string> = {}) {
  const res = await fetch(`/api${path}`, { method: 'PUT', headers: { 'X-Arai-CSRF': '1', 'Content-Type': 'application/octet-stream', ...headers }, credentials: 'same-origin', body: body as BodyInit });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'upload_failed');
  return res.json();
}

/** Uploads new artwork; returns the colour picked from it (for the ambient glow). */
export async function uploadArt(p: Project, image: Blob): Promise<string | null> {
  const key = projectKey(p);
  if (!key) throw new Error('locked');
  const bytes = new Uint8Array(await image.arrayBuffer());
  const enc = await seal(key, bytes, ctx(p.id));
  const r = (await put(`/projects/${p.id}/art`, enc, { 'X-Key-Version': String(p.keyVersion) })) as { art: { at: number } };
  if (p.visibility === 'public') await put(`/projects/${p.id}/art/public`, image, { 'Content-Type': image.type });
  urls.set(`${p.id}:${r.art.at}`, URL.createObjectURL(image));
  return coverColour(image);
}

export const removeArt = (p: Project) => api('DELETE', `/projects/${p.id}/art`);

/** After making a project public: publish a plain copy of its artwork. */
export async function publishArt(p: Project): Promise<void> {
  if (!p.art || p.visibility !== 'public') return;
  const url = await artUrl(p);
  if (!url) return;
  const blob = await (await fetch(url)).blob();
  await put(`/projects/${p.id}/art/public`, blob, { 'Content-Type': blob.type });
}

export async function artUrl(p: Pick<Project, 'id' | 'art'>): Promise<string | null> {
  if (!p.art) return null;
  const k = `${p.id}:${p.art.at}`;
  const hit = urls.get(k);
  if (hit) return hit;
  let job = pending.get(k);
  if (!job) {
    job = (async () => {
      const key = keyFor(p.id, p.art!.keyVersion);
      if (!key) return null;
      const res = await fetch(`/api/projects/${p.id}/art`, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const plain = await open(key, new Uint8Array(await res.arrayBuffer()), ctx(p.id));
      const type = plain[0] === 0x89 ? 'image/png' : plain[0] === 0xff ? 'image/jpeg' : 'image/webp';
      const url = URL.createObjectURL(new Blob([plain as BlobPart], { type }));
      urls.set(k, url);
      return url;
    })().catch(() => null);
    pending.set(k, job);
  }
  return job;
}

/** Decrypted artwork URL for a project (null while loading or when there is none). */
export function useArt(p: Pick<Project, 'id' | 'art'> | null | undefined): string | null {
  const k = p?.art ? `${p.id}:${p.art.at}` : null;
  const [url, setUrl] = useState<string | null>(k ? urls.get(k) ?? null : null);
  useEffect(() => {
    if (!p?.art) return setUrl(null);
    let alive = true;
    void artUrl(p).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  return url;
}

export const publicArtUrl = (projectId: string, at: number | null | undefined) => (at ? `/api/public/projects/${projectId}/art?v=${at}` : null);

/** Artwork as a data URL for share-link payloads (link holders have no project key). */
export async function artDataUrl(p: Pick<Project, 'id' | 'art'>): Promise<string | null> {
  const url = await artUrl(p);
  if (!url) return null;
  const blob = await (await fetch(url)).blob();
  return `data:${blob.type};base64,${await toBase64Url(new Uint8Array(await blob.arrayBuffer())).then((b) => b.replace(/-/g, '+').replace(/_/g, '/'))}`;
}
