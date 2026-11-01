import { sha256Hex } from './ids.js';

/**
 * Tamper-evident audit log: each row's hash covers the previous row's hash.
 * Inserts are conditional on the chain head being unchanged (optimistic
 * concurrency), so concurrent writers cannot fork the chain.
 */
export const GENESIS = 'GENESIS';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
}

interface Row {
  seq: number;
  at: number;
  actor_id: string | null;
  action: string;
  target: string | null;
  details_json: string | null;
  prev_hash: string;
  hash: string;
}

function material(prev: string, at: number, e: { actor_id: string | null; action: string; target: string | null; details_json: string | null }): string {
  return JSON.stringify([prev, at, e.actor_id, e.action, e.target, e.details_json]);
}

export async function appendAudit(db: D1Database, entry: AuditEntry, now = Date.now()): Promise<void> {
  const row = {
    actor_id: entry.actorId,
    action: entry.action,
    target: entry.target ?? null,
    details_json: entry.details ? JSON.stringify(entry.details) : null,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').first<{ hash: string }>();
    const prev = head?.hash ?? GENESIS;
    const hash = await sha256Hex(material(prev, now, row));
    const res = await db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target, details_json, prev_hash, hash)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE COALESCE((SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1), ?) = ?`,
      )
      .bind(now, row.actor_id, row.action, row.target, row.details_json, prev, hash, GENESIS, prev)
      .run();
    if (res.meta.changes === 1) return;
  }
  throw new Error('audit log contention');
}

/** Returns the seq of the first broken row, or null if the chain is intact. */
export async function verifyAuditChain(db: D1Database): Promise<number | null> {
  const { results } = await db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all<Row>();
  let prev = GENESIS;
  for (const r of results) {
    if (r.prev_hash !== prev || (await sha256Hex(material(prev, r.at, r))) !== r.hash) return r.seq;
    prev = r.hash;
  }
  return null;
}
