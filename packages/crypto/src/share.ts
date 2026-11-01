/**
 * Share links. The link carries a random 32-byte secret in the URL fragment
 * (never sent to the server). From secret (+ optional password) we derive:
 *  - an access token: the server stores only SHA-256(token) and asks for the
 *    token before handing out the encrypted payload or any chunk;
 *  - the payload key: decrypts the link's payload (titles, file keys).
 * Without the password neither can be derived, so a leaked link alone is
 * useless, and the server never sees the secret, the password or the keys.
 */
import { CryptoError, fromBase64Url, randomBytes, sodium, toBase64Url } from './index.js';

const enc = new TextEncoder();

export async function newShareSecret(): Promise<string> {
  return toBase64Url(await randomBytes(32));
}

export interface ShareKeys {
  token: Uint8Array;
  key: Uint8Array;
}

export async function deriveShareKeys(secretB64: string, password = ''): Promise<ShareKeys> {
  const s = await sodium();
  const secret = await fromBase64Url(secretB64);
  if (secret.length !== 32) throw new CryptoError('invalid share secret');
  const pw = enc.encode(password.normalize('NFKC'));
  const msg = (label: string) => {
    const l = enc.encode(label);
    const out = new Uint8Array(l.length + 1 + pw.length);
    out.set(l);
    out[l.length] = 0;
    out.set(pw, l.length + 1);
    return out;
  };
  return {
    token: s.crypto_generichash(32, msg('arai/share/token/v1'), secret) as Uint8Array,
    key: s.crypto_generichash(32, msg('arai/share/key/v1'), secret) as Uint8Array,
  };
}

/** What the server stores: SHA-256 of the access token. */
export async function shareTokenHash(token: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', token as BufferSource));
}
