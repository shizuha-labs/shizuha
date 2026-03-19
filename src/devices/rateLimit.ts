const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface Entry {
  failures: number;
  windowStart: number;
}

const limits = new Map<string, Entry>();

function prune(): void {
  const now = Date.now();
  for (const [ip, entry] of limits) {
    if (now - entry.windowStart > WINDOW_MS) limits.delete(ip);
  }
}

export function checkRateLimit(ip: string): boolean {
  prune();
  const entry = limits.get(ip);
  if (!entry) return true;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    limits.delete(ip);
    return true;
  }
  return entry.failures < MAX_FAILURES;
}

export function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = limits.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    limits.set(ip, { failures: 1, windowStart: now });
  } else {
    entry.failures++;
  }
}

export function resetFailures(ip: string): void {
  limits.delete(ip);
}
