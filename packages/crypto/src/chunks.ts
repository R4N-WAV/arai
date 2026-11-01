/**
 * Chunked file encryption with random access (for seeking / range requests).
 *
 * Each plaintext chunk of CHUNK_SIZE bytes (last may be shorter, never empty
 * unless the file is empty) becomes: [nonce:24][ciphertext][tag:16].
 * AAD binds file id, chunk index and the final-chunk flag, which prevents
 * reordering, swapping chunks between files and truncation.
 */
import { CryptoError, KEY_BYTES, sodium } from './index.js';

export const CHUNK_SIZE = 1024 * 1024;
export const CHUNK_OVERHEAD = 24 + 16;

export function chunkCount(plainSize: number, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(plainSize / chunkSize));
}

export function encryptedSize(plainSize: number, chunkSize = CHUNK_SIZE): number {
  return plainSize + chunkCount(plainSize, chunkSize) * CHUNK_OVERHEAD;
}

/** Byte range of chunk `index` inside the encrypted object. */
export function encryptedChunkRange(index: number, plainSize: number, chunkSize = CHUNK_SIZE): { start: number; end: number } {
  const n = chunkCount(plainSize, chunkSize);
  if (index < 0 || index >= n) throw new CryptoError('chunk index out of range');
  const start = index * (chunkSize + CHUNK_OVERHEAD);
  const plainLen = index === n - 1 ? plainSize - index * chunkSize : chunkSize;
  return { start, end: start + plainLen + CHUNK_OVERHEAD - 1 }; // inclusive, HTTP Range style
}

function chunkAad(fileId: string, index: number, last: boolean): Uint8Array {
  const id = new TextEncoder().encode(`arai/v1/file/${fileId}`);
  const out = new Uint8Array(id.length + 9);
  out.set(id);
  new DataView(out.buffer).setBigUint64(id.length, BigInt(index));
  out[id.length + 8] = last ? 1 : 0;
  return out;
}

export async function encryptChunk(fileKey: Uint8Array, fileId: string, index: number, last: boolean, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  if (fileKey.length !== KEY_BYTES) throw new CryptoError('invalid key length');
  const nonce = s.randombytes_buf(24);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, chunkAad(fileId, index, last), null, nonce, fileKey);
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce);
  out.set(ct, 24);
  return out;
}

export async function decryptChunk(fileKey: Uint8Array, fileId: string, index: number, last: boolean, chunk: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  if (chunk.length < CHUNK_OVERHEAD) throw new CryptoError('malformed chunk');
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, chunk.subarray(24), chunkAad(fileId, index, last), chunk.subarray(0, 24), fileKey);
  } catch {
    throw new CryptoError('chunk decryption failed');
  }
}

/** Encrypt a whole in-memory buffer (small files, tests). Large files stream chunk by chunk. */
export async function encryptFile(fileKey: Uint8Array, fileId: string, data: Uint8Array, chunkSize = CHUNK_SIZE): Promise<Uint8Array> {
  const n = chunkCount(data.length, chunkSize);
  const out = new Uint8Array(encryptedSize(data.length, chunkSize));
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const part = data.subarray(i * chunkSize, Math.min(data.length, (i + 1) * chunkSize));
    const c = await encryptChunk(fileKey, fileId, i, i === n - 1, part);
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function decryptFile(fileKey: Uint8Array, fileId: string, blob: Uint8Array, plainSize: number, chunkSize = CHUNK_SIZE): Promise<Uint8Array> {
  if (blob.length !== encryptedSize(plainSize, chunkSize)) throw new CryptoError('size mismatch');
  const n = chunkCount(plainSize, chunkSize);
  const out = new Uint8Array(plainSize);
  for (let i = 0; i < n; i++) {
    const { start, end } = encryptedChunkRange(i, plainSize, chunkSize);
    const p = await decryptChunk(fileKey, fileId, i, i === n - 1, blob.subarray(start, end + 1));
    out.set(p, i * chunkSize);
  }
  return out;
}
