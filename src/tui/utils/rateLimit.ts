/** Rate limit warning thresholds */
const WARN_75 = 0.75;
const WARN_90 = 0.90;
const WARN_95 = 0.95;

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: number;
  usagePercent: number;
  warning: string | null;
}

/** Parse rate limit headers from API response */
export function parseRateLimitHeaders(headers: Record<string, string | undefined>): RateLimitInfo | null {
  const limit = parseInt(headers['x-ratelimit-limit-requests'] ?? headers['x-ratelimit-limit'] ?? '', 10);
  const remaining = parseInt(headers['x-ratelimit-remaining-requests'] ?? headers['x-ratelimit-remaining'] ?? '', 10);
  const resetStr = headers['x-ratelimit-reset-requests'] ?? headers['x-ratelimit-reset'] ?? '';

  if (isNaN(limit) || isNaN(remaining)) return null;

  let resetAt = 0;
  if (resetStr) {
    // Try as numeric seconds first (e.g. "60" or "3.5")
    const secs = parseFloat(resetStr);
    if (!isNaN(secs) && /^\d+(\.\d+)?$/.test(resetStr.trim())) {
      resetAt = Date.now() + secs * 1000;
    } else {
      // Try as ISO date string
      const parsed = Date.parse(resetStr);
      if (!isNaN(parsed)) {
        resetAt = parsed;
      }
    }
  }

  const usagePercent = limit > 0 ? (limit - remaining) / limit : 0;

  let warning: string | null = null;
  if (usagePercent >= WARN_95) {
    warning = `Rate limit critical: ${remaining}/${limit} remaining`;
  } else if (usagePercent >= WARN_90) {
    warning = `Rate limit warning: ${remaining}/${limit} remaining`;
  } else if (usagePercent >= WARN_75) {
    warning = `Rate limit: ${Math.round(usagePercent * 100)}% used`;
  }

  return { remaining, limit, resetAt, usagePercent, warning };
}
