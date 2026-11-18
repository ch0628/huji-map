/**
 * In-memory sliding window rate limiter for event ingestion.
 * Protects event endpoints against abuse and flooding without relying on external caches.
 * Spec: docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md
 */

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Periodic cleanup of stale rate-limit buckets (every 5 minutes)
if (typeof setInterval !== "undefined") {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < 60_000);
      if (entry.timestamps.length === 0) {
        rateLimitStore.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

/**
 * Checks whether an incoming request key (e.g. IP or browserId) exceeds the rate limit.
 *
 * @param key Identifier for the client (IP or browserId)
 * @param limit Maximum allowed events in window (default: 60)
 * @param windowMs Window duration in milliseconds (default: 60,000ms / 1 min)
 */
export function checkRateLimit(
  key: string,
  limit = 60,
  windowMs = 60_000
): RateLimitResult {
  const now = Date.now();
  let entry = rateLimitStore.get(key);

  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(key, entry);
  }

  // Remove timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);

  if (entry.timestamps.length >= limit) {
    const oldest = entry.timestamps[0] ?? now;
    const resetMs = Math.max(0, windowMs - (now - oldest));
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetMs,
    };
  }

  // Record this request
  entry.timestamps.push(now);

  return {
    allowed: true,
    limit,
    remaining: limit - entry.timestamps.length,
    resetMs: windowMs,
  };
}

/**
 * Resets the in-memory rate limiter store. Used in unit/integration testing.
 */
export function resetRateLimits(): void {
  rateLimitStore.clear();
}

