import type { Context } from 'hono';
import type { z } from 'zod';

/** Parse a JSON body against a schema; null on any failure (caller returns 400). */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return null;
  }
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}
