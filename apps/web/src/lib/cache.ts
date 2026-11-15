/**
 * Small in-memory caches of already-decrypted data, so a screen you have seen
 * before draws at once and is then refreshed in the background. Nothing here
 * is written to disk, and everything is dropped on sign-out.
 */
const all = new Set<Map<unknown, unknown>>();

export function memoryCache<K, V>(): Map<K, V> {
  const m = new Map<K, V>();
  all.add(m as Map<unknown, unknown>);
  return m;
}

export function clearMemoryCaches(): void {
  all.forEach((m) => m.clear());
}
