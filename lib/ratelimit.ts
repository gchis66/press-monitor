/**
 * ratelimit.ts — in-memory IP rate limiter.
 *
 * The demo URL is public and every preview costs real money: 6 Firecrawl
 * credits plus ~$0.001 of model spend per run. This is a SPEND GUARD, not a
 * security control.
 *
 * In-memory means it resets on cold start and is per-instance. Accepted MVP
 * tradeoff; production uses Upstash Redis (and the production system is
 * scheduled, not user-triggered, so this concern disappears entirely).
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PREVIEWS_PER_WINDOW = 20;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  ip: string,
  cost = 1,
): { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  const existing = buckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    buckets.set(ip, { count: cost, resetAt: now + WINDOW_MS });
    return { ok: true, remaining: MAX_PREVIEWS_PER_WINDOW - cost };
  }

  if (existing.count + cost > MAX_PREVIEWS_PER_WINDOW) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += cost;
  return { ok: true, remaining: MAX_PREVIEWS_PER_WINDOW - existing.count };
}

/** Best-effort client IP from proxy headers. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
