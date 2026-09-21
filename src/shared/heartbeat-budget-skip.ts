/**
 * PLAT-6187: heartbeat budget-skip signal.
 *
 * A queue-blind lease holder burns model tokens on every idle heartbeat even
 * when there is no Pulse queue work to do (the Pulse preflight used to
 * fail-open on an empty/stale token, so the gateway invoked the model on
 * every idle beat). The durable net is: an idle heartbeat NEVER invokes the
 * model unless the Pulse preflight confirms ready work, and every skip is
 * counted and surfaced as `[heartbeat-budget-skip]` so "empty-queue idle" is
 * measurable fleet-wide (PLS-741 signal gap).
 *
 * This module is intentionally independent from manager.ts so both the daemon
 * dashboard and the gateway runtime can share the same in-memory counter
 * without introducing a manager↔gateway import cycle.
 */

export type HeartbeatBudgetSkipReason =
  | 'queue_empty'          // Pulse preflight confirmed no ready work
  | 'no_token'             // preflight had no usable Pulse token / emails
  | 'preflight_http_error' // preflight HTTP failure (fail-closed)
  | 'preflight_exception'; // preflight threw (fail-closed)

export interface HeartbeatBudgetSkipRecord {
  agentId: string;
  count: number;
  reason: HeartbeatBudgetSkipReason;
  observedAt: string;
}

export const HEARTBEAT_BUDGET_SKIP_LOG_PREFIX = '[heartbeat-budget-skip]';

const skipCounts = new Map<string, number>();

/**
 * Record one idle-heartbeat model skip and return the running count for the
 * agent. Emit the returned record via formatHeartbeatBudgetSkipLogLine so the
 * health/heartbeat log line carries the cumulative count + reason.
 */
export function recordHeartbeatBudgetSkip(
  agentId: string,
  reason: HeartbeatBudgetSkipReason,
  observedAt = new Date().toISOString(),
): HeartbeatBudgetSkipRecord {
  const count = (skipCounts.get(agentId) ?? 0) + 1;
  skipCounts.set(agentId, count);
  return { agentId, count, reason, observedAt };
}

export function getHeartbeatBudgetSkipCount(agentId: string): number {
  return skipCounts.get(agentId) ?? 0;
}

export function listHeartbeatBudgetSkipCounts(): Array<{ agentId: string; count: number }> {
  return [...skipCounts.entries()]
    .map(([agentId, count]) => ({ agentId, count }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function clearHeartbeatBudgetSkipsForTests(): void {
  skipCounts.clear();
}

export function formatHeartbeatBudgetSkipLogLine(record: HeartbeatBudgetSkipRecord): string {
  return `${HEARTBEAT_BUDGET_SKIP_LOG_PREFIX} ${JSON.stringify(record)}`;
}

/**
 * Project the latest skip count into the bridge telemetry envelope so Hive /
 * the fleet watcher can observe "empty-queue idle" without staff-side manual
 * discovery. Returns null when no skip has been recorded for the agent.
 */
export function heartbeatBudgetSkipTelemetry(agentId: string): Record<string, unknown> | null {
  const count = getHeartbeatBudgetSkipCount(agentId);
  if (count === 0) return null;
  return {
    heartbeat_budget_skips: count,
  };
}
