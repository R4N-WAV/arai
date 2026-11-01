import { describe, expect, it } from 'vitest';
import {
  CHUNK_OVERHEAD,
  CryptoError,
  decryptChunk,
  decryptFile,
  decryptPrivateKeys,
  derivePasswordKeys,
  encryptedChunkRange,
  encryptedSize,
  encryptFile,
  encryptPrivateKeys,
  fingerprint,
  generateAccountKeys,
  generateKey,
  generateRecoveryKey,
  generateSalt,
  open,
  openSealed,
  parseRecoveryCode,
  randomBytes,
  seal,
  sealTo,
  sign,
  unwrapAccountKey,
  verify,
  wrapAccountKey,
  type KdfParams,
} from '../src/index.js';

const FAST: KdfParams = { alg: 'argon2id13', opslimit: 2, memlimit: 19 * 1024 * 1024 };
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('password KDF', () => {
  it('is deterministic for same password+salt and splits into distinct keys', async () => {
    const salt = await generateSalt();
    const a = await derivePasswordKeys('correct horse 1', salt, FAST);
    const b = await derivePasswordKeys('correct horse 1', salt, FAST);
    expect(eq(a.authKey, b.authKey)).toBe(true);
    expect(eq(a.vaultKey, b.vaultKey)).toBe(true);
    expect(eq(a.authKey, a.vaultKey)).toBe(false);
  });

  it('differs per salt and per password', async () => {
    const s1 = await generateSalt();
    const s2 = await generateSalt();
    const a = await derivePasswordKeys('password1', s1, FAST);
    expect(eq(a.authKey, (await derivePasswordKeys('password1', s2, FAST)).authKey)).toBe(false);
    expect(eq(a.authKey, (await derivePasswordKeys('password2', s1, FAST)).authKey)).toBe(false);
  });

  it('rejects downgraded parameters from a malicious server', async () => {
    const salt = await generateSalt();
    await expect(derivePasswordKeys('pw123456', salt, { alg: 'argon2id13', opslimit: 1, memlimit: 1 << 20 })).rejects.toThrow(CryptoError);
    await expect(derivePasswordKeys('pw123456', new Uint8Array(4), FAST)).rejects.toThrow(CryptoError);
  });
});

describe('AEAD blobs', () => {
  it('round-trips and binds context', async () => {
    const key = await generateKey();
    const pt = new TextEncoder().encode('unreleased demo title');
    const blob = await seal(key, pt, 'project/meta');
    expect(eq(await open(key, blob, 'project/meta'), pt)).toBe(true);
    await expect(open(key, blob, 'track/meta')).rejects.toThrow(CryptoError);
  });

  it('detects tampering and wrong keys', async () => {
    const key = await generateKey();
    const blob = await seal(key, new Uint8Array([1, 2, 3]), 'x');
    const tampered = blob.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(open(key, tampered, 'x')).rejects.toThrow(CryptoError);
    await expect(open(await generateKey(), blob, 'x')).rejects.toThrow(CryptoError);
  });
});

describe('account vault', () => {
  it('wraps ASK by password and recovery key; private keys survive round trip', async () => {
    const keys = await generateAccountKeys();
    const salt = await generateSalt();
    const { vaultKey } = await derivePasswordKeys('hunter22', salt, FAST);
    const recovery = await generateRecoveryKey();

    const byPw = await wrapAccountKey(vaultKey, keys.ask, 'password-username');
    const byRecovery = await wrapAccountKey(recovery.key, keys.ask, 'recovery');
    const priv = await encryptPrivateKeys(keys);

    const ask1 = await unwrapAccountKey(vaultKey, byPw, 'password-username');
    const ask2 = await unwrapAccountKey(parseRecoveryCode(recovery.code.toLowerCase()), byRecovery, 'recovery');
    expect(eq(ask1, keys.ask) && eq(ask2, keys.ask)).toBe(true);

    const restored = await decryptPrivateKeys(ask2, priv);
    expect(eq(restored.box.privateKey, keys.box.privateKey)).toBe(true);
    expect(eq(restored.sign.privateKey, keys.sign.privateKey)).toBe(true);
    // slot binding: a password wrap cannot be presented as a recovery wrap
    await expect(unwrapAccountKey(vaultKey, byPw, 'recovery')).rejects.toThrow(CryptoError);
  });

  it('rejects malformed recovery codes', () => {
    expect(() => parseRecoveryCode('AAAA-BBBB')).toThrow(CryptoError);
    expect(() => parseRecoveryCode('U'.repeat(52))).toThrow(CryptoError);
  });
});

describe('sealing and signatures', () => {
  it('only the recipient can open a sealed project key', async () => {
    const alice = await generateAccountKeys();
    const mallory = await generateAccountKeys();
    const projectKey = await generateKey();
    const sealed = await sealTo(alice.box.publicKey, projectKey);
    expect(eq(await openSealed(alice.box, sealed), projectKey)).toBe(true);
    await expect(openSealed(mallory.box, sealed)).rejects.toThrow(CryptoError);
  });

  it('verifies signatures and rejects forgeries', async () => {
    const a = await generateAccountKeys();
    const b = await generateAccountKeys();
    const msg = new TextEncoder().encode('grant project p1 v2 to user u2');
    const sig = await sign(a.sign.privateKey, msg);
    expect(await verify(a.sign.publicKey, msg, sig)).toBe(true);
    expect(await verify(b.sign.publicKey, msg, sig)).toBe(false);
    expect(await verify(a.sign.publicKey, new TextEncoder().encode('grant to mallory'), sig)).toBe(false);
  });

  it('produces stable fingerprints', async () => {
    const a = await generateAccountKeys();
    const f = await fingerprint(a.box.publicKey, a.sign.publicKey);
    expect(f).toMatch(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/);
    expect(await fingerprint(a.box.publicKey, a.sign.publicKey)).toBe(f);
  });
});

describe('chunked file encryption', () => {
  const CHUNK = 1000;

  it('round-trips multi-chunk and empty files', async () => {
    const key = await generateKey();
    for (const size of [0, 1, 999, 1000, 1001, 3500]) {
      const data = await randomBytes(size);
      const blob = await encryptFile(key, 'f1', data, CHUNK);
      expect(blob.length).toBe(encryptedSize(size, CHUNK));
      expect(eq(await decryptFile(key, 'f1', blob, size, CHUNK), data)).toBe(true);
    }
  });

  it('supports random access to a single chunk', async () => {
    const key = await generateKey();
    const data = await randomBytes(3500);
    const blob = await encryptFile(key, 'f2', data, CHUNK);
    const { start, end } = encryptedChunkRange(2, 3500, CHUNK);
    expect(end - start + 1).toBe(1000 + CHUNK_OVERHEAD);
    const p = await decryptChunk(key, 'f2', 2, false, blob.subarray(start, end + 1));
    expect(eq(p, data.subarray(2000, 3000))).toBe(true);
  });

  it('detects chunk reordering, cross-file swaps and truncation', async () => {
    const key = await generateKey();
    const data = await randomBytes(2500);
    const blob = await encryptFile(key, 'f3', data, CHUNK);
    const r0 = encryptedChunkRange(0, 2500, CHUNK);
    const c0 = blob.subarray(r0.start, r0.end + 1);
    await expect(decryptChunk(key, 'f3', 1, false, c0)).rejects.toThrow(CryptoError); // reorder
    await expect(decryptChunk(key, 'other', 0, false, c0)).rejects.toThrow(CryptoError); // swap
    // truncation: presenting the middle chunk as the last one fails
    const r1 = encryptedChunkRange(1, 2500, CHUNK);
    await expect(decryptChunk(key, 'f3', 1, true, blob.subarray(r1.start, r1.end + 1))).rejects.toThrow(CryptoError);
    await expect(decryptFile(key, 'f3', blob.subarray(0, r1.end + 1), 2000, CHUNK)).rejects.toThrow(CryptoError);
  });
});
