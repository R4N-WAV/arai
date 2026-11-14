import { describe, expect, it } from 'vitest';
import { base32, totpAt, verifyTotp } from '../src/lib/totp';
import { Client, registered } from './helpers';

function fromBase32(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
const code = (secret: string, offsetSteps = 0) => totpAt(fromBase32(secret), Math.floor(Date.now() / 30_000) + offsetSteps);

describe('TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 test vector', async () => {
    const secret = new TextEncoder().encode('12345678901234567890');
    expect(await totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(await totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(base32(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(await verifyTotp(secret, '000000', 59_000)).toBeNull();
  });
});

describe('two-factor sign-in', () => {
  it('sets up with a code, then sign-in needs a fresh code or a one-time recovery code', async () => {
    const { c, reg } = await registered('mfa_user');
    expect((await c.call('GET', '/account/totp')).json.enabled).toBe(false);
    expect((await c.call('POST', '/account/totp/setup', { currentAuthKey: 'A'.repeat(43) })).status).toBe(401);
    const setup = (await c.call('POST', '/account/totp/setup', { currentAuthKey: reg.authKeyUsername })).json;
    expect(setup.uri).toContain('otpauth://totp/Arai%3Amfa_user');
    expect((await c.call('POST', '/account/totp/enable', { code: '000000' })).status).toBe(400);
    const enable = await c.call('POST', '/account/totp/enable', { code: await code(setup.secret) });
    expect(enable.json.recoveryCodes).toHaveLength(10);
    expect((await c.call('GET', '/account/totp')).json).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    const login = (extra: Record<string, string> = {}) => new Client().call('POST', '/auth/login', { identifier: 'mfa_user', authKey: reg.authKeyUsername, ...extra });
    const first = await login();
    expect(first.status).toBe(401);
    expect(first.json.error).toBe('mfa_required');
    expect(first.json.vault).toBeUndefined();
    expect((await login({ totpCode: '123456' })).json.error).toBe('invalid_mfa');
    // The code used to enable is spent; the next window's code works once.
    const next = await code(setup.secret, 1);
    expect((await login({ totpCode: next })).status).toBe(200);
    expect((await login({ totpCode: next })).json.error).toBe('invalid_mfa');
    const rc = enable.json.recoveryCodes[0];
    expect((await login({ mfaRecoveryCode: rc.toUpperCase() })).status).toBe(200);
    expect((await login({ mfaRecoveryCode: rc })).json.error).toBe('invalid_mfa');
    expect((await c.call('GET', '/account/totp')).json.recoveryCodesLeft).toBe(9);

    expect((await c.call('POST', '/account/totp/disable', { currentAuthKey: reg.authKeyUsername })).status).toBe(200);
    expect((await login()).status).toBe(200);
  });
});
