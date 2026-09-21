/**
 * BRW-38 (BRW-32 G1) — browser default-mode policy for sensitive surfaces.
 *
 * The `browser` tool defaults to headless `fast` mode. The HLD (G1) requires
 * that login-gated / anti-bot surfaces (X, Income Tax portal, MCA, banking)
 * run in `human` mode by default and fail closed rather than silently falling
 * back to headless automation.
 *
 * This module resolves the effective browser mode from:
 *   1. an explicit mode passed by the caller (wins),
 *   2. a sensitive-host match (forces `human`),
 *   3. the configured `browser.defaultMode` (default `fast`).
 *
 * Pure functions — no I/O — so the policy is unit-testable in isolation.
 */
import type { BrowserMode } from '../browser/session.js';

export interface BrowserSection {
  /** Default mode when no explicit mode is given and the target is not sensitive. */
  defaultMode?: BrowserMode;
  /**
   * Host patterns (glob) that require `human` mode. `*.gov.in` matches
   * `incometax.gov.in` and any subdomain; `x.com` matches `x.com` and
   * `www.x.com`. When unset, a conservative built-in list of documented
   * sensitive surfaces is used (X, government/income-tax/MCA, banking).
   */
  sensitiveHosts?: string[];
}

/** Conservative built-in sensitive surfaces (documented in the HLD / BRW-32). */
export const DEFAULT_SENSITIVE_HOSTS: string[] = [
  'x.com',
  'twitter.com',
  '*.gov.in',
  'incometax.gov.in',
  'mca.gov.in',
  '*.incometax.gov.in',
  '*.mca.gov.in',
  '*.bank',
  '*.banking',
];

/** True when the URL's hostname matches any sensitive-host pattern. */
export function isSensitiveHost(url: string, sensitiveHosts?: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const patterns = sensitiveHosts && sensitiveHosts.length > 0
    ? sensitiveHosts
    : DEFAULT_SENSITIVE_HOSTS;
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // '.gov.in'
      const bare = pattern.slice(2); // 'gov.in'
      if (host.endsWith(suffix) || host === bare) return true;
    } else if (host === pattern || host.endsWith('.' + pattern)) {
      return true;
    }
  }
  return false;
}

export interface ResolvedBrowserMode {
  mode: BrowserMode;
  /** True when the target URL matched a sensitive-host pattern. */
  sensitive: boolean;
}

/**
 * Resolve the effective browser mode for a target URL.
 *
 * Priority: explicit mode > sensitive-host match (forces `human`) >
 * configured `defaultMode` > `fast`.
 */
export function resolveBrowserMode(
  url: string | undefined,
  explicitMode: BrowserMode | undefined,
  browser?: BrowserSection,
): ResolvedBrowserMode {
  const sensitive = url ? isSensitiveHost(url, browser?.sensitiveHosts) : false;
  if (explicitMode) return { mode: explicitMode, sensitive };
  if (sensitive) return { mode: 'human', sensitive };
  return { mode: browser?.defaultMode ?? 'fast', sensitive };
}
