/**
 * Client-side account flows. The password never leaves this module;
 * the server receives only Argon2id-derived auth keys and encrypted blobs.
 */
import {
  decryptPrivateKeys,
  deriveRecoveryAuthKey,
  encryptPrivateKeys,
  fromBase64Url,
  generateAccountKeys,
  generateRecoveryKey,
  generateSalt,
  parseRecoveryCode,
  toBase64Url,
  unwrapAccountKey,
  wrapAccountKey,
  type AccountKeys,
} from '@arai/crypto';
import { CURRENT_KDF, type KdfParamsDto, type SessionUser } from '@arai/shared';
import { api } from './api';
import { deriveInWorker } from './kdf';

const b64 = toBase64Url;

export interface PreparedRegistration {
  recoveryCode: string;
  submit: (turnstileToken?: string) => Promise<AccountKeys>;
}

/** Generates keys + recovery code first, so the user can save the code before the account exists. */
export async function prepareRegistration(username: string, email: string, password: string): Promise<PreparedRegistration> {
  const [saltU, saltE] = [await generateSalt(), await generateSalt()];
  const pkU = await deriveInWorker(password, saltU, CURRENT_KDF);
  const pkE = await deriveInWorker(password, saltE, CURRENT_KDF);
  const keys = await generateAccountKeys();
  const recovery = await generateRecoveryKey();
  const body = {
    username,
    email,
    saltUsername: await b64(saltU),
    saltEmail: await b64(saltE),
    kdf: CURRENT_KDF,
    authKeyUsername: await b64(pkU.authKey),
    authKeyEmail: await b64(pkE.authKey),
    recoveryAuthKey: await b64(await deriveRecoveryAuthKey(recovery.key)),
    vault: {
      encAskUsername: await b64(await wrapAccountKey(pkU.vaultKey, keys.ask, 'password-username')),
      encAskEmail: await b64(await wrapAccountKey(pkE.vaultKey, keys.ask, 'password-email')),
      encAskRecovery: await b64(await wrapAccountKey(recovery.key, keys.ask, 'recovery')),
      encPrivateKeys: await b64(await encryptPrivateKeys(keys)),
    },
    publicKeys: { x25519: await b64(keys.box.publicKey), ed25519: await b64(keys.sign.publicKey) },
  };
  return {
    recoveryCode: recovery.code,
    submit: async (turnstileToken?: string) => {
      await api('POST', '/auth/register', { ...body, website: honeypotValue(), turnstileToken });
      return keys;
    },
  };
}

let honeypot = '';
export function setHoneypot(v: string) {
  honeypot = v;
}
function honeypotValue() {
  return honeypot || undefined;
}

interface VaultBlobs {
  encAsk: string;
  slot: 'password-username' | 'password-email';
  encPrivateKeys: string;
}

async function openVault(vaultKey: Uint8Array, v: VaultBlobs): Promise<AccountKeys> {
  try {
    const ask = await unwrapAccountKey(vaultKey, await fromBase64Url(v.encAsk), v.slot);
    return await decryptPrivateKeys(ask, await fromBase64Url(v.encPrivateKeys));
  } catch {
    throw new Error('vault_unlock_failed');
  }
}

export async function login(identifier: string, password: string, turnstileToken?: string): Promise<{ user: SessionUser; keys: AccountKeys; newDevice: boolean }> {
  const pre = await api<{ salt: string; kdf: KdfParamsDto }>('POST', '/auth/prelogin', { identifier });
  const pk = await deriveInWorker(password, await fromBase64Url(pre.salt), pre.kdf);
  const res = await api<{ user: SessionUser; vault: VaultBlobs; newDevice: boolean }>('POST', '/auth/login', {
    identifier,
    authKey: await b64(pk.authKey),
    turnstileToken,
  });
  return { user: res.user, keys: await openVault(pk.vaultKey, res.vault), newDevice: res.newDevice };
}

export interface UnlockInfo extends VaultBlobs {
  salt: string;
  kdf: KdfParamsDto;
}

/** Re-derive keys after a page reload (keys live only in memory). */
export async function unlock(info: UnlockInfo, password: string): Promise<AccountKeys> {
  const pk = await deriveInWorker(password, await fromBase64Url(info.salt), info.kdf);
  return openVault(pk.vaultKey, info);
}

/** Email-less reset: the recovery key unwraps the account key, which is re-wrapped under the new password. */
export async function recoverWithKey(username: string, recoveryCode: string, newPassword: string): Promise<AccountKeys> {
  const recoveryKey = parseRecoveryCode(recoveryCode);
  const recoveryAuthKey = await b64(await deriveRecoveryAuthKey(recoveryKey));
  const { encAskRecovery } = await api<{ encAskRecovery: string }>('POST', '/auth/recover/challenge', { username, recoveryAuthKey });
  const ask = await unwrapAccountKey(recoveryKey, await fromBase64Url(encAskRecovery), 'recovery');
  const [saltU, saltE] = [await generateSalt(), await generateSalt()];
  const pkU = await deriveInWorker(newPassword, saltU, CURRENT_KDF);
  const pkE = await deriveInWorker(newPassword, saltE, CURRENT_KDF);
  await api('POST', '/auth/recover', {
    username,
    recoveryAuthKey,
    saltUsername: await b64(saltU),
    saltEmail: await b64(saltE),
    kdf: CURRENT_KDF,
    authKeyUsername: await b64(pkU.authKey),
    authKeyEmail: await b64(pkE.authKey),
    encAskUsername: await b64(await wrapAccountKey(pkU.vaultKey, ask, 'password-username')),
    encAskEmail: await b64(await wrapAccountKey(pkE.vaultKey, ask, 'password-email')),
  });
  const s = await api<{ unlock: UnlockInfo }>('GET', '/auth/session');
  return decryptPrivateKeys(ask, await fromBase64Url(s.unlock.encPrivateKeys));
}

// ---- account control (phase 9) ------------------------------------------------

/** The current password's auth key (proves the password without sending it). */
export async function currentAuthKey(info: UnlockInfo, password: string): Promise<string> {
  const pk = await deriveInWorker(password, await fromBase64Url(info.salt), info.kdf);
  // Check locally first: a wrong password cannot open the vault.
  await openVault(pk.vaultKey, info);
  return b64(pk.authKey);
}

/** New password: the account key is re-wrapped here, so everything stays readable. */
export async function changePassword(info: UnlockInfo, keys: AccountKeys, current: string, next: string): Promise<void> {
  const currentKey = await currentAuthKey(info, current);
  const [saltU, saltE] = [await generateSalt(), await generateSalt()];
  const pkU = await deriveInWorker(next, saltU, CURRENT_KDF);
  const pkE = await deriveInWorker(next, saltE, CURRENT_KDF);
  await api('POST', '/account/password', {
    currentAuthKey: currentKey,
    saltUsername: await b64(saltU),
    saltEmail: await b64(saltE),
    kdf: CURRENT_KDF,
    authKeyUsername: await b64(pkU.authKey),
    authKeyEmail: await b64(pkE.authKey),
    encAskUsername: await b64(await wrapAccountKey(pkU.vaultKey, keys.ask, 'password-username')),
    encAskEmail: await b64(await wrapAccountKey(pkE.vaultKey, keys.ask, 'password-email')),
  });
}

export async function changeUsername(info: UnlockInfo, password: string, username: string): Promise<void> {
  await api('POST', '/account/username', { username, currentAuthKey: await currentAuthKey(info, password) });
}

export async function deleteAccount(info: UnlockInfo, password: string): Promise<void> {
  await api('POST', '/account/delete', { currentAuthKey: await currentAuthKey(info, password), confirm: 'delete my account' });
}
