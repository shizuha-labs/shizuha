/**
 * PLAT-11763: cross-process MCP reconnect telemetry for mcp-proxy children.
 *
 * PLAT-4112/PLAT-8689 put the MCP reconnect observability (consecutive-failures
 * gauge + closed reason-class counters) inside the gateway's in-process MCP
 * manager. Generation 53 moved platform MCP connections into per-server
 * `mcp-proxy` child processes (src/mcp-proxy/server.ts) — each child registers
 * the metrics in its own prom-client registry, but only the gateway parent
 * serves :9103, and the parent never dials upstream anymore. Result: the
 * families were declared (HELP) but sample-less fleet-wide, which tripped
 * ShizuhaAgentRuntimeMetricsAbsent and orphaned the reconnect-wedge alert.
 *
 * Fix follows the established cross-process pattern (renderMetricsFromFiles,
 * JSONL/JSON state files instead of shared memory): each child rewrites ONE
 * small JSON snapshot per service under the shared runtime dir, and the parent
 * merges the snapshots into the same metric families in renderMetrics().
 *
 * Never fatal: a persistence failure must not take down the proxy — log via
 * the caller's `log()`-equivalent (silent by design here) and continue.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface McpReconnectSnapshot {
  /** Agent label (AGENT_USERNAME/AGENT_NAME), matches the in-process families. */
  agent: string;
  /** Logical service name, e.g. "pulse". */
  server: string;
  /** Current consecutive reconnect failures (reset to 0 on success). */
  consecutive_failures: number;
  /** Cumulative reconnect failures since cluster epoch (survives child restarts via seed). */
  failures_total: number;
  /** Cumulative successful (re)connects (survives child restarts via seed). */
  success_total: number;
  /** Last failure's closed reason class (never untrusted upstream text). */
  last_reason_class: string;
  /** Snapshot epoch ms — lets the parent skip stale/dead children. */
  updated_at: number;
}

export const MCP_RECONNECT_REASON_CLASSES = [
  'auth',
  'route_missing',
  'http_5xx',
  'timeout',
  'conn_reset',
  'dns',
  'other',
] as const;

export type McpReconnectReasonClass = (typeof MCP_RECONNECT_REASON_CLASSES)[number];

/** Snapshot freshness bound: entries older than this are not rendered. */
export const MCP_RECONNECT_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

export function mcpReconnectStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['MCP_RECONNECT_STATE_DIR'] || '/run/shizuha/mcp-reconnect-state';
}

function snapshotPath(stateDir: string, server: string): string {
  // Service names are configured platform slugs (alnum/dash), but stay defensive:
  // strip anything outside the safe label charset before using it in a path.
  const safe = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(stateDir, `${safe}.json`);
}

/**
 * Read the existing snapshot (if any) so cumulative counters survive a child
 * restart; returns zeros when absent/corrupt.
 */
export function seedMcpReconnectTotals(
  server: string,
  env: NodeJS.ProcessEnv = process.env,
): { failuresTotal: number; successTotal: number } {
  try {
    const raw = fs.readFileSync(snapshotPath(mcpReconnectStateDir(env), server), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<McpReconnectSnapshot>;
    return {
      failuresTotal: Math.max(0, Number(parsed.failures_total) || 0),
      successTotal: Math.max(0, Number(parsed.success_total) || 0),
    };
  } catch {
    return { failuresTotal: 0, successTotal: 0 };
  }
}

/** Atomic, best-effort snapshot rewrite (temp file + rename). */
export function persistMcpReconnectState(snapshot: McpReconnectSnapshot, env: NodeJS.ProcessEnv = process.env): void {
  const dir = mcpReconnectStateDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = snapshotPath(dir, snapshot.server);
    const temp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(temp, target);
  } catch {
    // Observability persistence is best-effort; the proxy must keep serving.
  }
}

/**
 * Map a raw upstream failure message onto the CLOSED reason-class union used by
 * `shizuha_mcp_reconnect_failures_total` (same union as the in-process path,
 * src/metrics/registry.ts). Never returns untrusted text.
 */
export function classifyMcpReconnectError(message: string): McpReconnectReasonClass {
  const msg = (message || '').toLowerCase();
  if (msg.includes('http 401') || msg.includes('http 403') || msg.includes('status 401') ||
      msg.includes('status 403') || msg.includes('401 unauthorized') || msg.includes('403 forbidden') ||
      msg.includes('unauthorized') || msg.includes('invalid_token')) {
    return 'auth';
  }
  if (/\b405\b/.test(msg) || /\b501\b/.test(msg) || msg.includes('not allowed')) {
    return 'route_missing';
  }
  if (/\b5\d\d\b/.test(msg) || msg.includes('http 5') || msg.includes('bad gateway') ||
      msg.includes('service unavailable')) {
    return 'http_5xx';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout') ||
      msg.includes('deadline')) {
    return 'timeout';
  }
  if (msg.includes('reset') || msg.includes('econnaborted') || msg.includes('socket hang up') ||
      msg.includes('closed')) {
    return 'conn_reset';
  }
  if (msg.includes('dns') || msg.includes('enotfound') || msg.includes('eai_again')) {
    return 'dns';
  }
  return 'other';
}
