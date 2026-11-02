/** API contract shared by apps/web and apps/api. Server always re-validates. */
import { z } from 'zod';

export const USERNAME_RE = /^[A-Za-z0-9_.]{3,30}$/;
export const username = z.string().regex(USERNAME_RE, 'invalid_username');
export const email = z.string().trim().toLowerCase().max(254).email('invalid_email');
/** Username or email used to sign in. */
export const identifier = z.string().trim().min(3).max(254);

export { b64 } from './encoding';
import { b64 } from './encoding';

export const kdfParams = z.object({
  alg: z.literal('argon2id13'),
  opslimit: z.number().int().min(2).max(10),
  memlimit: z.number().int().min(19 * 1024 * 1024).max(1024 * 1024 * 1024),
});
export type KdfParamsDto = z.infer<typeof kdfParams>;

/**
 * The only KDF parameters accepted at registration. A single value keeps
 * prelogin responses for unknown accounts indistinguishable from real ones.
 * Raising it requires re-keying on next login (planned, not yet built).
 */
export const CURRENT_KDF: KdfParamsDto = { alg: 'argon2id13', opslimit: 3, memlimit: 64 * 1024 * 1024 };

/**
 * Password policy. Enforced client-side only: the server never receives the
 * password (it receives an Argon2id-derived authKey), see SECURITY §3.1.
 */
export function passwordProblems(pw: string): string[] {
  const problems: string[] = [];
  if (pw.length < 8) problems.push('at_least_8_characters');
  if (!/\p{L}/u.test(pw)) problems.push('needs_a_letter');
  if (!/\p{N}/u.test(pw)) problems.push('needs_a_number');
  return problems;
}

const KEY = b64(32);
const BLOB = b64(41, 4096); // version(1)+nonce(24)+tag(16)+payload

export const vaultDto = z.object({
  encAskUsername: BLOB,
  encAskEmail: BLOB,
  encAskRecovery: BLOB,
  encPrivateKeys: BLOB,
});

export const registerRequest = z.object({
  username,
  email,
  saltUsername: b64(16),
  saltEmail: b64(16),
  kdf: kdfParams,
  authKeyUsername: KEY,
  authKeyEmail: KEY,
  recoveryAuthKey: KEY,
  vault: vaultDto,
  publicKeys: z.object({ x25519: KEY, ed25519: KEY }),
  turnstileToken: z.string().max(4096).optional(),
  /** honeypot: must be empty; hidden from humans and assistive tech */
  website: z.string().max(200).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const preloginRequest = z.object({ identifier });
export const preloginResponse = z.object({ salt: z.string(), kdf: kdfParams });

export const loginRequest = z.object({
  identifier,
  authKey: KEY,
  turnstileToken: z.string().max(4096).optional(),
});

export const recoverChallengeRequest = z.object({ username, recoveryAuthKey: KEY });

export const recoverRequest = z.object({
  username,
  recoveryAuthKey: KEY,
  saltUsername: b64(16),
  saltEmail: b64(16),
  kdf: kdfParams,
  authKeyUsername: KEY,
  authKeyEmail: KEY,
  encAskUsername: BLOB,
  encAskEmail: BLOB,
  turnstileToken: z.string().max(4096).optional(),
});

/**
 * Feature flags for provider-dependent functionality. The UI renders these
 * features greyed out ("not available yet") when false. Never fake them.
 */
export interface Capabilities {
  emailDelivery: boolean; // email verification, email reset, email OTP, alerts
  sms: boolean; // SMS 2FA
  gifs: boolean; // GIF search (needs a provider key)
  turnstileSiteKey: string | null;
}

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  status: string;
}

export interface VaultBlobs {
  encAsk: string;
  slot: 'password-username' | 'password-email';
  encPrivateKeys: string;
}
export * from './ambient';
export * from './projects';
export * from './tracks';
export * from './profiles';
export * from './collab';
