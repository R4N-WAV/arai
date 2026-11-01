import type { KdfParams, PasswordKeys } from '@arai/crypto';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (k: PasswordKeys) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; keys?: PasswordKeys; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.keys) p.resolve(e.data.keys);
      else p.reject(new Error(e.data.error ?? 'kdf_failed'));
    };
  }
  return worker;
}

export function deriveInWorker(password: string, salt: Uint8Array, params: KdfParams): Promise<PasswordKeys> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, password, salt, params });
  });
}
