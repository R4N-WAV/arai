import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

/**
 * Encrypted audio chunk storage, one instance per project (10 GB each,
 * free-plan SQLite storage). It only ever sees ciphertext; authorization is
 * done by the Worker before any call reaches it.
 */
export class FileStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS chunks (file_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file_id, idx))');
  }

  async putChunk(fileId: string, idx: number, data: ArrayBuffer): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO chunks (file_id, idx, data) VALUES (?, ?, ?)', fileId, idx, data);
  }

  async getChunk(fileId: string, idx: number): Promise<ArrayBuffer | null> {
    const rows = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM chunks WHERE file_id = ? AND idx = ?', fileId, idx).toArray();
    return rows[0]?.data ?? null;
  }

  async chunkSizes(fileId: string): Promise<{ idx: number; size: number }[]> {
    return this.ctx.storage.sql.exec<{ idx: number; size: number }>('SELECT idx, length(data) AS size FROM chunks WHERE file_id = ? ORDER BY idx', fileId).toArray();
  }

  async deleteFile(fileId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM chunks WHERE file_id = ?', fileId);
  }
}
