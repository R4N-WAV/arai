/**
 * Remembered device: keeps the account keys available after the app or
 * browser is closed, until you sign out (owner's choice: no password on
 * every open).
 *
 * The account secret key is encrypted twice:
 *  1. with a non-extractable AES-GCM key kept in IndexedDB (script on this
 *     origin can use it but never read its bytes, so it cannot be copied off
 *     the device), then
 *  2. with a 32-byte secret the server keeps for this session only
 *     (POST /auth/device-secret, needs the HttpOnly session cookie).
 * The result sits in localStorage. Copying the browser profile alone is not
 * enough, and signing out or revoking the session in Settings destroys the
 * server half, so the stored keys become unreadable. Nothing here sends key
 * material to the server.
 *
 * Trade-off (SECURITY.md §3.5): anyone who can use this unlocked browser can
 * open Arai, as with any "stay signed in" app.
 */
import { decryptPrivateKeys, fromBase64Url, toBase64Url, type AccountKeys } from '@arai/crypto';

const DB_NAME = 'arai-device';
const STORE = 'tab-keys';
const SLOT = 'arai.device-unlock';
const OLD_SLOT = 'arai.tab-unlock';
const MAX_AGE_MS = 400 * 24 * 3600 * 1000;

interface Stored {
  id: string;
  userId: string;
  iv: string;
  iv2: string;
  ct: string;
}

async function serverKey(): Promise<CryptoKey> {
  const res = await fetch('/api/auth/device-secret', { method: 'POST', headers: { 'X-Arai-CSRF': '1' }, credentials: 'same-origin' });
  if (!res.ok) throw new Error('no device secret');
  const { secret } = (await res.json()) as { secret: string };
  return crypto.subtle.importKey('raw', (await fromBase64Url(secret)) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function pruneOld(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve();
      const v = c.value as { createdAt?: number };
      if (!v.createdAt || Date.now() - v.createdAt > MAX_AGE_MS) c.delete();
      c.continue();
    };
    cursor.onerror = () => resolve();
  });
  db.close();
}

export async function rememberForTab(userId: string, keys: AccountKeys): Promise<void> {
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const id = crypto.randomUUID();
    await tx('readwrite', (s) => s.put({ key, createdAt: Date.now() }, id));
    const payload = new TextEncoder().encode(JSON.stringify({ ask: await toBase64Url(keys.ask) }));
    const aad = new TextEncoder().encode(userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const inner = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, payload));
    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2, additionalData: aad }, await serverKey(), inner));
    const previous = readSlot();
    localStorage.setItem(SLOT, JSON.stringify({ id, userId, iv: await toBase64Url(iv), iv2: await toBase64Url(iv2), ct: await toBase64Url(ct) } satisfies Stored));
    sessionStorage.removeItem(OLD_SLOT);
    if (previous) await tx('readwrite', (s) => s.delete(previous.id));
    void pruneOld();
  } catch {
    // Private mode / storage disabled: fall back to unlock-on-reload.
  }
}

function readSlot(): Stored | null {
  try {
    const raw = localStorage.getItem(SLOT);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/** Restores keys on a remembered device; needs the server's encrypted private-key blob and this session's device secret. */
export async function restoreForTab(userId: string, encPrivateKeys: string): Promise<AccountKeys | null> {
  const slot = readSlot();
  if (!slot || slot.userId !== userId) return null;
  try {
    const rec = await tx<{ key: CryptoKey } | undefined>('readonly', (s) => s.get(slot.id));
    if (!rec || !slot.iv2) return null;
    const aad = new TextEncoder().encode(userId);
    const inner = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(await fromBase64Url(slot.iv2)), additionalData: aad }, await serverKey(), new Uint8Array(await fromBase64Url(slot.ct)));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(await fromBase64Url(slot.iv)), additionalData: aad }, rec.key, inner);
    const { ask } = JSON.parse(new TextDecoder().decode(pt)) as { ask: string };
    return await decryptPrivateKeys(await fromBase64Url(ask), await fromBase64Url(encPrivateKeys));
  } catch {
    return null;
  }
}

export async function forgetAllTabs(): Promise<void> {
  try {
    localStorage.removeItem(SLOT);
    sessionStorage.removeItem(OLD_SLOT);
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* nothing stored */
  }
}
