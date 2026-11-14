/**
 * Bring-your-own storage: Dropbox or Google Drive.
 *
 * Audio is encrypted here exactly as for Arai's own storage (1 MiB chunks,
 * per-file key) and the ciphertext chunks are uploaded back to back as ONE
 * file into the user's cloud ("Arai (encrypted)"). A read-only link to that
 * file is registered with Arai, which relays byte ranges to members, so
 * playback works for everyone without them connecting anything.
 *
 * The OAuth refresh token is kept on the server encrypted with a key derived
 * from the account key: Arai cannot use it; the user's own devices can.
 */
import { deriveSubkey, fromBase64Url, openJson, sealJson, toBase64Url, type AccountKeys } from '@arai/crypto';
import { api } from './api';

export type Provider = 'dropbox' | 'gdrive';
export const PROVIDER_NAME: Record<Provider, string> = { dropbox: 'Dropbox', gdrive: 'Google Drive' };
const FOLDER = 'Arai (encrypted)';
const PENDING = 'arai.cloud-connect';
const redirectUri = () => `${location.origin}/storage/callback`;

interface Tokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  /** Google: the id of the "Arai (encrypted)" folder once created. */
  folderId?: string;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenKey(keys: AccountKeys) {
  return deriveSubkey(keys.ask, 'storage-tokens');
}

// ---- connecting -----------------------------------------------------------------

/** Sends the browser to the provider's consent page (PKCE: no secret in the browser). */
export async function connect(provider: Provider, clientId: string): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PENDING, JSON.stringify({ provider, verifier, state, clientId }));
  const q =
    provider === 'dropbox'
      ? new URLSearchParams({ client_id: clientId, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: redirectUri(), state })
      : new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          // Only files Arai itself creates: no access to the rest of the user's Drive.
          scope: 'https://www.googleapis.com/auth/drive.file',
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri(),
          state,
        });
  location.assign(`${provider === 'dropbox' ? 'https://www.dropbox.com/oauth2/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth'}?${q}`);
}

/** /storage/callback: exchanges the code, stores the encrypted token. Returns the provider. */
export async function finishConnect(keys: AccountKeys, search: URLSearchParams): Promise<Provider> {
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as { provider: Provider; verifier: string; state: string; clientId: string } | null;
  sessionStorage.removeItem(PENDING);
  if (!pending || search.get('state') !== pending.state) throw new Error('state_mismatch');
  const code = search.get('code');
  if (!code) throw new Error(search.get('error') ?? 'cancelled');
  let t: { accessToken: string; refreshToken: string | null; expiresIn: number };
  if (pending.provider === 'dropbox') {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: pending.clientId, code_verifier: pending.verifier, redirect_uri: redirectUri() }),
    });
    const d = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !d.access_token) throw new Error('oauth_failed');
    t = { accessToken: d.access_token, refreshToken: d.refresh_token ?? null, expiresIn: d.expires_in ?? 14400 };
  } else {
    t = await api('POST', '/account/storage/google/token', { code, codeVerifier: pending.verifier, redirectUri: redirectUri() });
  }
  if (!t.refreshToken) throw new Error('no_offline_access');
  await saveTokens(keys, pending.provider, { refreshToken: t.refreshToken, accessToken: t.accessToken, expiresAt: Date.now() + (t.expiresIn - 120) * 1000 });
  return pending.provider;
}

async function saveTokens(keys: AccountKeys, provider: Provider, t: Tokens) {
  const encToken = await toBase64Url(await sealJson(await tokenKey(keys), t, `storage/${provider}`));
  await api('PUT', `/account/storage-accounts/${provider}`, { encToken });
  cache.set(provider, t);
}

export async function connected(): Promise<Provider[]> {
  const { accounts } = await api<{ accounts: Array<{ provider: Provider }> }>('GET', '/account/storage-accounts');
  return accounts.map((a) => a.provider);
}

export async function disconnect(provider: Provider) {
  cache.delete(provider);
  await api('DELETE', `/account/storage-accounts/${provider}`);
}

// ---- tokens --------------------------------------------------------------------------

const cache = new Map<Provider, Tokens>();

async function tokens(keys: AccountKeys, provider: Provider, clientId: string): Promise<Tokens> {
  let t = cache.get(provider);
  if (!t) {
    const { accounts } = await api<{ accounts: Array<{ provider: Provider; encToken: string }> }>('GET', '/account/storage-accounts');
    const row = accounts.find((a) => a.provider === provider);
    if (!row) throw new Error('not_connected');
    t = await openJson<Tokens>(await tokenKey(keys), await fromBase64Url(row.encToken), `storage/${provider}`);
  }
  if (Date.now() > t.expiresAt) {
    let fresh: { accessToken: string; expiresIn: number };
    if (provider === 'dropbox') {
      const res = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: clientId }) });
      const d = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!res.ok || !d.access_token) throw new Error('reconnect_needed');
      fresh = { accessToken: d.access_token, expiresIn: d.expires_in ?? 14400 };
    } else {
      fresh = await api('POST', '/account/storage/google/refresh', { refreshToken: t.refreshToken });
    }
    t = { ...t, accessToken: fresh.accessToken, expiresAt: Date.now() + (fresh.expiresIn - 120) * 1000 };
    await saveTokens(keys, provider, t);
  }
  cache.set(provider, t);
  return t;
}

// ---- uploading -------------------------------------------------------------------------

/**
 * Uploads the encrypted chunks (produced one by one by `next`) as a single
 * file and returns the read reference Arai stores (Dropbox share link /
 * Drive file id).
 */
export async function uploadEncrypted(
  keys: AccountKeys,
  provider: Provider,
  clientId: string,
  fileId: string,
  encSize: number,
  count: number,
  next: (i: number) => Promise<Uint8Array>,
  onProgress?: (p: number) => void,
): Promise<string> {
  const t = await tokens(keys, provider, clientId);
  return provider === 'dropbox' ? dropboxUpload(t, fileId, count, next, onProgress) : driveUpload(keys, clientId, t, fileId, encSize, count, next, onProgress);
}

async function dropbox(t: Tokens, url: string, arg: unknown, body?: BodyInit, json = false): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.accessToken}`, ...(json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify(arg) }) },
    body: json ? JSON.stringify(arg) : body,
  });
  if (!res.ok && res.status !== 409) throw new Error(`dropbox_${res.status}`);
  return res;
}

async function dropboxUpload(t: Tokens, fileId: string, count: number, next: (i: number) => Promise<Uint8Array>, onProgress?: (p: number) => void): Promise<string> {
  const path = `/${FOLDER}/${fileId}.arai`;
  const first = await next(0);
  const start = await dropbox(t, 'https://content.dropboxapi.com/2/files/upload_session/start', { close: false }, first as BodyInit);
  const { session_id } = (await start.json()) as { session_id: string };
  let offset = first.length;
  onProgress?.(1 / count);
  for (let i = 1; i < count; i++) {
    const part = await next(i);
    await dropbox(t, 'https://content.dropboxapi.com/2/files/upload_session/append_v2', { cursor: { session_id, offset }, close: false }, part as BodyInit);
    offset += part.length;
    onProgress?.((i + 1) / count);
  }
  await dropbox(t, 'https://content.dropboxapi.com/2/files/upload_session/finish', { cursor: { session_id, offset }, commit: { path, mode: 'add', autorename: false, mute: true } }, new Uint8Array(0) as BodyInit);
  // A read-only link to the ciphertext; only Arai's server ever sees it.
  const link = await dropbox(t, 'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', { path, settings: { requested_visibility: 'public', audience: 'public', access: 'viewer' } }, undefined, true);
  let url = ((await link.json()) as { url?: string; error?: { shared_link_already_exists?: { metadata?: { url?: string } } } }).url;
  if (!url) {
    const list = await dropbox(t, 'https://api.dropboxapi.com/2/sharing/list_shared_links', { path, direct_only: true }, undefined, true);
    url = ((await list.json()) as { links?: Array<{ url: string }> }).links?.[0]?.url;
  }
  if (!url) throw new Error('dropbox_link_failed');
  return normaliseDropboxUrl(url);
}

/** Keeps only the parts Arai's server accepts: the share path and its rlkey. */
export function normaliseDropboxUrl(url: string): string {
  const u = new URL(url);
  const rlkey = u.searchParams.get('rlkey');
  return `https://www.dropbox.com${u.pathname}${rlkey ? `?rlkey=${rlkey}` : ''}`;
}

async function driveFolder(keys: AccountKeys, clientId: string, t: Tokens): Promise<string> {
  if (t.folderId) return t.folderId;
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder', description: 'Encrypted audio stored by Arai. Only Arai can open these files.' }),
  });
  if (!res.ok) throw new Error(`drive_${res.status}`);
  const { id } = (await res.json()) as { id: string };
  await saveTokens(keys, 'gdrive', { ...t, folderId: id });
  void clientId;
  return id;
}

async function driveUpload(keys: AccountKeys, clientId: string, t: Tokens, fileId: string, encSize: number, count: number, next: (i: number) => Promise<Uint8Array>, onProgress?: (p: number) => void): Promise<string> {
  const folder = await driveFolder(keys, clientId, t);
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(encSize) },
    body: JSON.stringify({ name: `${fileId}.arai`, parents: [folder] }),
  });
  const session = init.headers.get('Location');
  if (!init.ok || !session) throw new Error(`drive_${init.status}`);
  // Drive wants pieces in multiples of 256 KiB (except the last): buffer the chunks.
  const PIECE = 8 * 256 * 1024 * 4;
  let buf = new Uint8Array(0);
  let sent = 0;
  let id: string | null = null;
  const flush = async (final: boolean) => {
    const n = final ? buf.length : Math.floor(buf.length / PIECE) * PIECE;
    if (n === 0 && !final) return;
    const part = buf.subarray(0, n);
    const res = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes ${sent}-${sent + n - 1}/${encSize}` }, body: part as BodyInit });
    if (final) {
      if (!res.ok) throw new Error(`drive_${res.status}`);
      id = ((await res.json()) as { id: string }).id;
    } else if (res.status !== 308) throw new Error(`drive_${res.status}`);
    sent += n;
    buf = buf.slice(n);
  };
  for (let i = 0; i < count; i++) {
    const part = await next(i);
    const merged = new Uint8Array(buf.length + part.length);
    merged.set(buf);
    merged.set(part, buf.length);
    buf = merged;
    if (buf.length >= PIECE) await flush(false);
    onProgress?.((i + 1) / count);
  }
  await flush(true);
  // Anyone with the id may read the ciphertext (Arai's server relays it to members).
  const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!perm.ok) throw new Error(`drive_${perm.status}`);
  return id!;
}

/** Removes a file from the user's own cloud (only the uploader can). Best effort. */
export async function deleteRemote(keys: AccountKeys, provider: Provider, clientId: string, fileId: string, ref: string | null): Promise<void> {
  const t = await tokens(keys, provider, clientId).catch(() => null);
  if (!t) return;
  if (provider === 'dropbox') await dropbox(t, 'https://api.dropboxapi.com/2/files/delete_v2', { path: `/${FOLDER}/${fileId}.arai` }, undefined, true).catch(() => undefined);
  else if (ref) await fetch(`https://www.googleapis.com/drive/v3/files/${ref}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t.accessToken}` } }).catch(() => undefined);
}

/** Set by the session: what uploads need to reach the user's cloud. */
export const cloudCtx: { keys: AccountKeys | null; userId: string | null; ids: { dropbox: string | null; gdrive: string | null } } = { keys: null, userId: null, ids: { dropbox: null, gdrive: null } };

// ---- where new uploads go ----------------------------------------------------------------

const TARGET = 'arai.upload-target';
export function uploadTarget(): 'arai' | Provider {
  try {
    const v = localStorage.getItem(TARGET);
    return v === 'dropbox' || v === 'gdrive' ? v : 'arai';
  } catch {
    return 'arai';
  }
}
export function setUploadTarget(v: 'arai' | Provider) {
  try {
    localStorage.setItem(TARGET, v);
  } catch {
    /* storage blocked: uploads go to Arai */
  }
}
