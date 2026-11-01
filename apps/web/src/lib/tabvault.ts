/**
 * Keeps the account keys unlocked across reloads *within one browser tab*.
 *
 * - A fresh AES-GCM key is generated as a non-extractable CryptoKey and kept in
 *   IndexedDB: script can use it but can never read its bytes, so it cannot be
 *   copied off the device.
 * - The account keys are encrypted with it and the ciphertext is kept in
 *   sessionStorage, which the browser discards when the tab closes.
 * - Signing out deletes both. Nothing here is sent to the server.
 *
 * Trade-off (documented in SECURITY.md): code running in this tab could already
 * use the in-memory keys, so this adds no new exposure to XSS; it only avoids
 * re-entering the password on reload. Closing the tab locks again.
 */
import { decryptPrivateKeys, fromBase64Url, toBase64Url, type AccountKeys } from '@arai/crypto';

const DB_NAME = 'arai-device';
const STORE = 'tab-keys';
const SLOT = 'arai.tab-unlock';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface Stored {
  id: string;
  userId: string;
  iv: string;
  ct: string;
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
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId) }, key, payload));
    const previous = readSlot();
    sessionStorage.setItem(SLOT, JSON.stringify({ id, userId, iv: await toBase64Url(iv), ct: await toBase64Url(ct) } satisfies Stored));
    if (previous) await tx('readwrite', (s) => s.delete(previous.id));
    void pruneOld();
  } catch {
    // Private mode / storage disabled: fall back to unlock-on-reload.
  }
}

function readSlot(): Stored | null {
  try {
    const raw = sessionStorage.getItem(SLOT);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/** Restores keys for this tab; needs the server's encrypted private-key blob. */
export async function restoreForTab(userId: string, encPrivateKeys: string): Promise<AccountKeys | null> {
  const slot = readSlot();
  if (!slot || slot.userId !== userId) return null;
  try {
    const rec = await tx<{ key: CryptoKey } | undefined>('readonly', (s) => s.get(slot.id));
    if (!rec) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(await fromBase64Url(slot.iv)), additionalData: new TextEncoder().encode(userId) },
      rec.key,
      new Uint8Array(await fromBase64Url(slot.ct)),
    );
    const { ask } = JSON.parse(new TextDecoder().decode(pt)) as { ask: string };
    return await decryptPrivateKeys(await fromBase64Url(ask), await fromBase64Url(encPrivateKeys));
  } catch {
    return null;
  }
}

export async function forgetAllTabs(): Promise<void> {
  try {
    sessionStorage.removeItem(SLOT);
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* nothing stored */
  }
}
