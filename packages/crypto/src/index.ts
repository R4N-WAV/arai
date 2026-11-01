/**
 * @arai/crypto — the only module in Arai that touches key material.
 *
 * Built exclusively on libsodium (audited) and Web Crypto HKDF.
 * No custom primitives. See docs/SECURITY.md §3 for the design.
 */
import sodiumModule from 'libsodium-wrappers-sumo';

type Sodium = typeof sodiumModule;
let sodiumPromise: Promise<Sodium> | null = null;

/** Resolve the initialised libsodium instance (loads WASM once). */
export function sodium(): Promise<Sodium> {
  sodiumPromise ??= sodiumModule.ready.then(() => sodiumModule);
  return sodiumPromise;
}

const enc = new TextEncoder();
const FORMAT_V1 = 1;
export const KEY_BYTES = 32;
const NONCE_BYTES = 24; // XChaCha20-Poly1305
const TAG_BYTES = 16;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

// ---------------------------------------------------------------- encoding

export async function toBase64Url(bytes: Uint8Array): Promise<string> {
  const s = await sodium();
  return s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
}

export async function fromBase64Url(text: string): Promise<Uint8Array> {
  const s = await sodium();
  try {
    return s.from_base64(text, s.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new CryptoError('invalid base64url');
  }
}

export async function randomBytes(n: number): Promise<Uint8Array> {
  return (await sodium()).randombytes_buf(n);
}

/** Best-effort zeroisation of secret buffers once no longer needed. */
export async function wipe(...buffers: Uint8Array[]): Promise<void> {
  const s = await sodium();
  for (const b of buffers) s.memzero(b);
}

// ------------------------------------------------------- password KDF (Argon2id)

export interface KdfParams {
  alg: 'argon2id13';
  opslimit: number;
  /** bytes */
  memlimit: number;
}

/** 64 MiB, t=3 — interactive on phones (~1 s), raised per user when needed. */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  alg: 'argon2id13',
  opslimit: 3,
  memlimit: 64 * 1024 * 1024,
};

const MIN_OPSLIMIT = 2;
const MIN_MEMLIMIT = 19 * 1024 * 1024; // OWASP Argon2id floor

export interface PasswordKeys {
  /** sent to the server, which stores HMAC(pepper, authKey) */
  authKey: Uint8Array;
  /** never leaves the device; unwraps the account secret key */
  vaultKey: Uint8Array;
}

async function hkdf(ikm: Uint8Array, info: string, length = KEY_BYTES): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Argon2id(password, salt) → masterKey → HKDF split into authKey / vaultKey.
 * Rejects parameters below the security floor so a malicious server cannot
 * downgrade the KDF via the prelogin response.
 */
export async function derivePasswordKeys(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<PasswordKeys> {
  const s = await sodium();
  if (params.alg !== 'argon2id13') throw new CryptoError('unsupported kdf');
  if (params.opslimit < MIN_OPSLIMIT || params.memlimit < MIN_MEMLIMIT) {
    throw new CryptoError('kdf parameters below minimum');
  }
  if (salt.length !== s.crypto_pwhash_SALTBYTES) throw new CryptoError('invalid salt length');
  const master = s.crypto_pwhash(
    KEY_BYTES,
    password.normalize('NFKC'),
    salt,
    params.opslimit,
    params.memlimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return {
      authKey: await hkdf(master, 'arai/auth/v1'),
      vaultKey: await hkdf(master, 'arai/vault/v1'),
    };
  } finally {
    s.memzero(master);
  }
}

export async function generateSalt(): Promise<Uint8Array> {
  const s = await sodium();
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

// ------------------------------------------------------ symmetric AEAD blobs

/**
 * Authenticated encryption with XChaCha20-Poly1305.
 * Format: [version:1][nonce:24][ciphertext+tag]. `context` is bound as AAD
 * so a blob cannot be replayed into a different slot (e.g. a project key
 * blob used as a file key).
 */
export async function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Promise<Uint8Array> {
  const s = await sodium();
  if (key.length !== KEY_BYTES) throw new CryptoError('invalid key length');
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad(context), null, nonce, key);
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = FORMAT_V1;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return out;
}

export async function open(key: Uint8Array, blob: Uint8Array, context: string): Promise<Uint8Array> {
  const s = await sodium();
  if (key.length !== KEY_BYTES) throw new CryptoError('invalid key length');
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== FORMAT_V1) {
    throw new CryptoError('malformed ciphertext');
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ct = blob.subarray(1 + NONCE_BYTES);
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad(context), nonce, key);
  } catch {
    throw new CryptoError('decryption failed');
  }
}

function aad(context: string): Uint8Array {
  return enc.encode(`arai/v1/${context}`);
}

export async function sealJson(key: Uint8Array, value: unknown, context: string): Promise<Uint8Array> {
  return seal(key, enc.encode(JSON.stringify(value)), context);
}

export async function openJson<T>(key: Uint8Array, blob: Uint8Array, context: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await open(key, blob, context))) as T;
}

export async function generateKey(): Promise<Uint8Array> {
  return randomBytes(KEY_BYTES);
}

// ----------------------------------------------------------- account keys

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface AccountKeys {
  /** account secret key: wraps everything else the user owns */
  ask: Uint8Array;
  box: KeyPair; // X25519 — receives sealed project/conversation keys
  sign: KeyPair; // Ed25519 — signs key grants and messages
}

export async function generateAccountKeys(): Promise<AccountKeys> {
  const s = await sodium();
  const box = s.crypto_box_keypair();
  const sign = s.crypto_sign_keypair();
  return {
    ask: s.randombytes_buf(KEY_BYTES),
    box: { publicKey: box.publicKey, privateKey: box.privateKey },
    sign: { publicKey: sign.publicKey, privateKey: sign.privateKey },
  };
}

interface VaultPayload {
  v: 1;
  boxPriv: string;
  boxPub: string;
  signPriv: string;
  signPub: string;
}

/** Encrypt the private key material under the ASK (stored server-side). */
export async function encryptPrivateKeys(keys: AccountKeys): Promise<Uint8Array> {
  const payload: VaultPayload = {
    v: 1,
    boxPriv: await toBase64Url(keys.box.privateKey),
    boxPub: await toBase64Url(keys.box.publicKey),
    signPriv: await toBase64Url(keys.sign.privateKey),
    signPub: await toBase64Url(keys.sign.publicKey),
  };
  return sealJson(keys.ask, payload, 'vault/private-keys');
}

export async function decryptPrivateKeys(ask: Uint8Array, blob: Uint8Array): Promise<AccountKeys> {
  const p = await openJson<VaultPayload>(ask, blob, 'vault/private-keys');
  if (p.v !== 1) throw new CryptoError('unsupported vault version');
  return {
    ask,
    box: { publicKey: await fromBase64Url(p.boxPub), privateKey: await fromBase64Url(p.boxPriv) },
    sign: { publicKey: await fromBase64Url(p.signPub), privateKey: await fromBase64Url(p.signPriv) },
  };
}

/** Wrap the ASK with a password-derived vaultKey or the recovery key. */
export async function wrapAccountKey(wrappingKey: Uint8Array, ask: Uint8Array, slot: 'password-username' | 'password-email' | 'recovery'): Promise<Uint8Array> {
  return seal(wrappingKey, ask, `vault/ask/${slot}`);
}

export async function unwrapAccountKey(wrappingKey: Uint8Array, blob: Uint8Array, slot: 'password-username' | 'password-email' | 'recovery'): Promise<Uint8Array> {
  const ask = await open(wrappingKey, blob, `vault/ask/${slot}`);
  if (ask.length !== KEY_BYTES) throw new CryptoError('invalid account key');
  return ask;
}

// ------------------------------------------------------------ recovery key

const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // Crockford-like, no I/L/O/U

/** 256-bit recovery key rendered as 52 base32 chars in groups of 4. */
export async function generateRecoveryKey(): Promise<{ key: Uint8Array; code: string }> {
  const key = await randomBytes(KEY_BYTES);
  return { key, code: encodeRecoveryCode(key) };
}

/**
 * Proof of recovery-key possession for the email-less password reset.
 * The server stores HMAC(pepper, recoveryAuthKey); the recovery key itself
 * (which unwraps the ASK) never leaves the device.
 */
export async function deriveRecoveryAuthKey(recoveryKey: Uint8Array): Promise<Uint8Array> {
  if (recoveryKey.length !== KEY_BYTES) throw new CryptoError('invalid recovery key');
  return hkdf(recoveryKey, 'arai/recovery-auth/v1');
}

export function encodeRecoveryCode(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

export function parseRecoveryCode(code: string): Uint8Array {
  const clean = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== 52) throw new CryptoError('invalid recovery code');
  const out = new Uint8Array(KEY_BYTES);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new CryptoError('invalid recovery code');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      if (i < KEY_BYTES) out[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

// --------------------------------------------- public-key sealing & signing

/** Anonymous sealed box to a recipient's X25519 key (crypto_box_seal). */
export async function sealTo(recipientPublicKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return (await sodium()).crypto_box_seal(data, recipientPublicKey);
}

export async function openSealed(keys: KeyPair, sealed: Uint8Array): Promise<Uint8Array> {
  try {
    return (await sodium()).crypto_box_seal_open(sealed, keys.publicKey, keys.privateKey);
  } catch {
    throw new CryptoError('sealed box open failed');
  }
}

export async function sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  return (await sodium()).crypto_sign_detached(message, privateKey);
}

export async function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    return (await sodium()).crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Human-comparable fingerprint of a user's public keys (safety number). */
export async function fingerprint(boxPublicKey: Uint8Array, signPublicKey: Uint8Array): Promise<string> {
  const s = await sodium();
  const h = s.crypto_generichash(20, new Uint8Array([...boxPublicKey, ...signPublicKey]), null) as Uint8Array;
  return Array.from(h, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{4}/g)!
    .join(' ');
}

export * from './chunks.js';
export * from './grants.js';
export * from './share.js';
