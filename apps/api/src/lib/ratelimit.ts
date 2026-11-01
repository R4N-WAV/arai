/**
 * Fixed-window counters in D1. Returns true if the action is allowed.
 * Keys never contain raw IPs or emails (callers pass HMACs / ids).
 */
export async function rateLimit(db: D1Database, key: string, max: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const windowStart = now - (now % windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? max + 1) <= max;
}

/** Read-only check (does not count an attempt). */
export async function isLimited(db: D1Database, key: string, max: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const windowStart = now - (now % windowMs);
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?').bind(key, windowStart).first<{ count: number }>();
  return (row?.count ?? 0) >= max;
}
