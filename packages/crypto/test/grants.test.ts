import { describe, expect, it } from 'vitest';
import { CryptoError, createGrant, generateAccountKeys, generateKey, openGrant, sealTo, sign } from '../src/index.js';

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('key grants', () => {
  it('round-trips a signed project key grant', async () => {
    const owner = await generateAccountKeys();
    const k = await generateKey();
    const g = await createGrant(owner, owner.box.publicKey, 'project', 'p1', 1, 'u1', k);
    expect(eq(await openGrant(owner, owner.sign.publicKey, 'project', 'p1', 1, 'u1', g.wrapped, g.signature), k)).toBe(true);
  });

  it('rejects a key substituted by the server', async () => {
    const owner = await generateAccountKeys();
    const server = await generateAccountKeys();
    const g = await createGrant(owner, owner.box.publicKey, 'project', 'p1', 1, 'u1', await generateKey());
    const forgedWrapped = await sealTo(owner.box.publicKey, await generateKey());
    await expect(openGrant(owner, owner.sign.publicKey, 'project', 'p1', 1, 'u1', forgedWrapped, g.signature)).rejects.toThrow(CryptoError);
    const forgedSig = await sign(server.sign.privateKey, new Uint8Array([1]));
    await expect(openGrant(owner, owner.sign.publicKey, 'project', 'p1', 1, 'u1', g.wrapped, forgedSig)).rejects.toThrow(CryptoError);
  });

  it('binds project id, version and recipient', async () => {
    const owner = await generateAccountKeys();
    const g = await createGrant(owner, owner.box.publicKey, 'project', 'p1', 1, 'u1', await generateKey());
    for (const [id, v, r] of [['p2', 1, 'u1'], ['p1', 2, 'u1'], ['p1', 1, 'u2']] as const) {
      await expect(openGrant(owner, owner.sign.publicKey, 'project', id, v, r, g.wrapped, g.signature)).rejects.toThrow(CryptoError);
    }
    await expect(openGrant(owner, owner.sign.publicKey, 'conversation', 'p1', 1, 'u1', g.wrapped, g.signature)).rejects.toThrow(CryptoError);
  });
});
