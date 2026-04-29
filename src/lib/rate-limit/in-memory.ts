/**
 * in-memory.ts — Map-based per-instance rate limiter.
 *
 * Used by GET /api/billing-line-items/[id]/pay (#202 / D16) to defend
 * against scraping of the public redirect endpoint. 10 req/min/IP per Vercel
 * instance.
 *
 * Scope caveat: this counter is per-Node-process, NOT cluster-wide. A
 * coordinated attacker spread across Vercel instances bypasses it. A future
 * ticket can swap in Upstash/Vercel KV when abuse signal appears; the call
 * site only depends on the `checkRateLimit(...)` contract.
 *
 * State: a `Map<key, number[]>` mapping IP → array of recent hit timestamps
 * (ms epoch). Each call prunes timestamps older than `windowMs`. The data
 * structure is bounded by active-attacker count × `limit`; we additionally
 * cap the map size to prevent unbounded growth from per-IP bot fleets.
 */

const MAX_TRACKED_KEYS = 10_000;

type Entry = {
  // Recent hit timestamps (ms epoch), oldest first.
  hits: number[];
  // Last access time (for eviction once we hit MAX_TRACKED_KEYS).
  lastSeen: number;
};

const store: Map<string, Entry> = new Map();

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until a fresh request would succeed; only set when `ok = false`. */
  retryAfter?: number;
}

/**
 * Apply a sliding-window rate limit to `key`.
 *
 *   - On allow: records the new hit, returns { ok: true }.
 *   - On deny:  does NOT record the hit (the hit is rejected, not throttled),
 *               returns { ok: false, retryAfter } where retryAfter is the
 *               number of whole seconds the client should wait.
 *
 * `limit` and `windowMs` are caller-supplied so the same helper serves
 * different routes if needed.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { hits: [], lastSeen: now };
    store.set(key, entry);
  }

  // Prune anything older than the window. Hits are appended in order, so
  // we can stop on the first in-window timestamp.
  while (entry.hits.length > 0 && entry.hits[0] < cutoff) {
    entry.hits.shift();
  }

  if (entry.hits.length >= limit) {
    // Earliest in-window hit will leave the window at hits[0] + windowMs.
    const earliest = entry.hits[0]!;
    const retryAfterMs = earliest + windowMs - now;
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    entry.lastSeen = now;
    return { ok: false, retryAfter };
  }

  entry.hits.push(now);
  entry.lastSeen = now;

  // Cap memory growth: if we're over the soft limit, evict the LRU entry.
  if (store.size > MAX_TRACKED_KEYS) {
    let oldestKey: string | null = null;
    let oldestSeen = Infinity;
    for (const [k, v] of store) {
      if (v.lastSeen < oldestSeen) {
        oldestSeen = v.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }

  return { ok: true };
}

/**
 * Reset the limiter — for tests only.
 */
export function _resetRateLimitStoreForTests(): void {
  store.clear();
}
