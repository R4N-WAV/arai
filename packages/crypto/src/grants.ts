/**
 * Project/conversation key grants.
 *
 * A grant = the key sealed to the recipient's X25519 public key, plus the
 * granter's Ed25519 signature over (scope, id, key version, recipient,
 * hash of the sealed box). The recipient verifies the signature before using
 * the key, so a server that substitutes its own sealed key is detected.
 */
import { CryptoError, KEY_BYTES, openSealed, sealTo, sign, sodium, verify, type AccountKeys } from './index.js';

export type GrantScope = 'project' | 'conversation';

async function grantMessage(scope: GrantScope, id: string, keyVersion: number, recipientId: string, sealed: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const digest = s.crypto_generichash(32, sealed, null) as Uint8Array;
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return new TextEncoder().encode(`arai/grant/v1|${scope}|${id}|${keyVersion}|${recipientId}|${hex}`);
}

export async function createGrant(
  granter: AccountKeys,
  recipientBoxPublicKey: Uint8Array,
  scope: GrantScope,
  id: string,
  keyVersion: number,
  recipientId: string,
  key: Uint8Array,
): Promise<{ wrapped: Uint8Array; signature: Uint8Array }> {
  if (key.length !== KEY_BYTES) throw new CryptoError('invalid key length');
  const wrapped = await sealTo(recipientBoxPublicKey, key);
  const signature = await sign(granter.sign.privateKey, await grantMessage(scope, id, keyVersion, recipientId, wrapped));
  return { wrapped, signature };
}

export async function openGrant(
  recipient: AccountKeys,
  granterSignPublicKey: Uint8Array,
  scope: GrantScope,
  id: string,
  keyVersion: number,
  recipientId: string,
  wrapped: Uint8Array,
  signature: Uint8Array,
): Promise<Uint8Array> {
  const ok = await verify(granterSignPublicKey, await grantMessage(scope, id, keyVersion, recipientId, wrapped), signature);
  if (!ok) throw new CryptoError('grant signature invalid');
  const key = await openSealed(recipient.box, wrapped);
  if (key.length !== KEY_BYTES) throw new CryptoError('invalid key length');
  return key;
}
