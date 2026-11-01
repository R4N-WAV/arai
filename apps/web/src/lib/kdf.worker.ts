/// <reference lib="webworker" />
// Argon2id runs off the main thread so the UI stays responsive (≈1 s on phones).
import { derivePasswordKeys, type KdfParams } from '@arai/crypto';

self.onmessage = async (e: MessageEvent<{ id: number; password: string; salt: Uint8Array; params: KdfParams }>) => {
  const { id, password, salt, params } = e.data;
  try {
    const keys = await derivePasswordKeys(password, salt, params);
    (self as unknown as Worker).postMessage({ id, keys }, [keys.authKey.buffer, keys.vaultKey.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
