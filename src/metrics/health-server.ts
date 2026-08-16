/**
 * PLAT-479: Agent health exporter on port 9888.
 *
 * Serves the per-agent metrics consumed by the Pulse org-health sweep
 * (shizuha-tasks/tasks/views.py _scrape_agent_health). The URL is controlled
 * by PULSE_HEALTH_EXPORTER_URL in the Pulse environment; the default is
 * http://host.docker.internal:9888/metrics.
 *
 * Metrics emitted (all with label agent="<username>"):
 *   shizuha_agent_process_up        — 1 if agent process is running, else 0
 *   shizuha_agent_enabled           — 1 if agent is enabled, else 0
 *   shizuha_agent_last_activity_seconds — Unix timestamp of the last completed
 *                                         turn (from turn-telemetry JSONL)
 *
 *   shizuha_agent_capacity_unavailable — 1 if agent is in PLAT-879 token-pool backoff (PLAT-962)
 *                                      or recent Claude Code quota/session-limit exhaustion
 *   shizuha_agent_calls_per_minute — current-run turn/provider-call rate from turn telemetry
 *   shizuha_agent_prompt_output_ratio — current-run prompt:output token ratio
 *   shizuha_agent_loop_guard_hits — current-run loop/expensive-turn guard hits
 *
 * Metrics intentionally NOT emitted here (assumed healthy by the sweep):
 *   shizuha_agent_wedge_errors  (default 0 — no wedge)
 *   shizuha_agent_auth_errors   (default 0 — no auth errors)
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TurnTelemetryRecord } from '../telemetry/turn-telemetry.js';
import { getAutoAndonMetricsSnapshot } from '../daemon/auto-andon.js';

const serversByPort = new Map<number, http.Server>();

const PROVIDER_EXHAUSTED_RE =
  /hit your usage limit|usage limit reached|you've hit your usage|you've hit your weekly limit|you've hit your session limit|hit your weekly limit|hit your session limit|quota exceeded|insufficient_quota|exceeded your current quota|429 too many requests/i;
const PROVIDER_EXHAUSTION_WINDOW_MS =
  Number(process.env.AGENT_HEALTH_PROVIDER_EXHAUSTION_WINDOW_MS ?? 30 * 60 * 1000);
const SESSION_TAIL_BYTES =
  Number(process.env.AGENT_HEALTH_SESSION_TAIL_BYTES ?? 1024 * 1024);

export interface AgentHealthInfo {
  username: string;
  enabled: boolean;
  running: boolean;
  /** PLAT-962: true when bridge is in PLAT-879 token-pool backoff (capacity-limited, not crashed) */
  capacityUnavailable: boolean;
}

/**
 * PLAT-587 AC4: build the exporter's per-agent health view with `enabled` derived
 * from the AUTHORITATIVE enabled-agents.json set — NOT from a cached daemon.json
 * `enabled` flag. The caller passes a freshly-read `enabledAgentIds` on every
 * scrape, so toggling an agent in the daemon (which writes enabled-agents.json)
 * reflects in the next scrape → Pulse routing within one gather cycle (AC5). This
 * removes the split-brain where a stale daemon-state cache reported an agent
 * enabled/disabled out of sync with the source of truth (the 2026-06-13 stall).
 */
export function buildAgentHealth(
  agents: Array<{ id: string; username: string }>,
  enabledAgentIds: Set<string>,
  runningAgentIds: Set<string>,
  /** PLAT-962: agent IDs currently in PLAT-879 token-pool backoff */
  capacityUnavailableIds: Set<string> = new Set(),
): AgentHealthInfo[] {
  return agents.map((a) => ({
    username: a.username,
    enabled: enabledAgentIds.has(a.id),
    running: runningAgentIds.has(a.id),
    capacityUnavailable: capacityUnavailableIds.has(a.id),
  }));
}

function readLastTelemetryRecordsSync(username: string, n = 50): TurnTelemetryRecord[] {
  const p = path.join(
    os.homedir(),
    '.shizuha', 'claude-sessions', username, 'turn-telemetry.jsonl',
  );
  try {
    const content = fs.readFileSync(p, 'utf-8');
    const lines = content.trimEnd().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line) as TurnTelemetryRecord;
        } catch {
          return null;
        }
      })
      .filter((rec): rec is TurnTelemetryRecord => rec !== null);
  } catch {
    return [];
  }
}

function currentRunTelemetry(records: TurnTelemetryRecord[]): TurnTelemetryRecord[] {
  if (records.length === 0) return [];
  const currentRunId = records[records.length - 1]?.runId;
  return records.filter((rec) => rec.runId === currentRunId);
}

function appendEfficiencyTelemetryMetrics(lines: string[], agents: AgentHealthInfo[]): void {
  lines.push(
    '# HELP shizuha_agent_calls_per_minute Completed model turns/provider calls per minute over the current telemetry window (SCLI-198).',
    '# TYPE shizuha_agent_calls_per_minute gauge',
    '# HELP shizuha_agent_prompt_output_ratio Prompt input tokens divided by output tokens over the current telemetry window (SCLI-198).',
    '# TYPE shizuha_agent_prompt_output_ratio gauge',
    '# HELP shizuha_agent_loop_guard_hits Loop/expensive-turn guard hits over the current telemetry window (SCLI-198).',
    '# TYPE shizuha_agent_loop_guard_hits gauge',
  );

  for (const a of agents) {
    const records = currentRunTelemetry(readLastTelemetryRecordsSync(a.username));
    if (records.length === 0) continue;
    const first = records[0]!;
    const last = records[records.length - 1]!;
    const runId = last.runId;
    const model = last.model || 'unknown';
    const firstTs = first.ts ?? last.ts ?? Date.now();
    const lastTs = last.ts ?? firstTs;
    const elapsedMs = Math.max(1_000, lastTs - firstTs);
    const callsPerMinute = records.length / (elapsedMs / 60_000);
    const inputTokens = records.reduce((sum, rec) => sum + (rec.inputTokens ?? 0), 0);
    const outputTokens = records.reduce((sum, rec) => sum + (rec.outputTokens ?? 0), 0);
    const ratio = inputTokens / Math.max(1, outputTokens);
    const guardHits = records.reduce((sum, rec) => sum + (rec.loopGuardHits ?? 0), 0);
    const labels = `agent="${a.username}",run_id="${runId}",model="${model}"`;
    lines.push(`shizuha_agent_calls_per_minute{${labels}} ${callsPerMinute}`);
    lines.push(`shizuha_agent_prompt_output_ratio{${labels}} ${ratio}`);
    lines.push(`shizuha_agent_loop_guard_hits{${labels}} ${guardHits}`);
  }
}

function readLastTsSync(username: string): number | null {
  const p = path.join(
    os.homedir(),
    '.shizuha', 'claude-sessions', username, 'turn-telemetry.jsonl',
  );
  try {
    const content = fs.readFileSync(p, 'utf-8');
    const lines = content.trimEnd().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const rec = JSON.parse(lines[lines.length - 1]!) as TurnTelemetryRecord;
    return rec.ts ?? null;
  } catch {
    return null;
  }
}

function readTailSync(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function latestClaudeSessionPath(username: string): string | null {
  const dir = path.join(
    os.homedir(),
    '.shizuha', 'claude-sessions', username, 'projects', '-workspace',
  );
  try {
    let best: { file: string; mtimeMs: number } | null = null;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, ent.name);
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const rec = item as { text?: unknown; content?: unknown };
      if (typeof rec.text === 'string') return rec.text;
      if (typeof rec.content === 'string') return rec.content;
    }
    return '';
  }).join(' ');
}

function hasRecentClaudeProviderExhaustion(username: string, now = Date.now()): boolean {
  const file = latestClaudeSessionPath(username);
  if (!file) return false;
  const cutoff = now - PROVIDER_EXHAUSTION_WINDOW_MS;
  try {
    for (const line of readTailSync(file, SESSION_TAIL_BYTES).split('\n')) {
      if (!PROVIDER_EXHAUSTED_RE.test(line)) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          message?: { model?: string; content?: unknown };
        };
        if (obj.type !== 'assistant' || obj.message?.model !== '<synthetic>') continue;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        if (PROVIDER_EXHAUSTED_RE.test(textFromContent(obj.message.content))) return true;
      } catch {
        // Not a structured Claude session record; ignore it to avoid prose false positives.
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function buildMetrics(agents: AgentHealthInfo[]): string {
  const lines: string[] = [];
  const providerExhausted = new Map<string, boolean>();
  // This scrape is built immediately after the caller reads the authoritative
  // enabled-agent set. Pulse uses the marker to order a cached lifecycle
  // snapshot against a newer authenticated agent heartbeat, preventing a
  // just-started agent from being demoted by the previous enabled=0 sample.
  const enabledSnapshotObservedAt = Date.now() / 1000;

  for (const a of agents) {
    providerExhausted.set(
      a.username,
      a.running && hasRecentClaudeProviderExhaustion(a.username),
    );
  }

  lines.push(
    '# HELP shizuha_agent_process_up 1 if the agent process is running, 0 otherwise',
    '# TYPE shizuha_agent_process_up gauge',
  );
  for (const a of agents) {
    lines.push(`shizuha_agent_process_up{agent="${a.username}"} ${a.running ? 1 : 0}`);
  }

  lines.push(
    '# HELP shizuha_agent_enabled 1 if the agent is enabled, 0 if disabled',
    '# TYPE shizuha_agent_enabled gauge',
  );
  for (const a of agents) {
    lines.push(`shizuha_agent_enabled{agent="${a.username}"} ${a.enabled ? 1 : 0}`);
  }
  lines.push(
    '# HELP shizuha_agent_enabled_snapshot_timestamp_seconds Unix timestamp after the lifecycle state backing shizuha_agent_enabled was observed',
    '# TYPE shizuha_agent_enabled_snapshot_timestamp_seconds gauge',
    `shizuha_agent_enabled_snapshot_timestamp_seconds ${enabledSnapshotObservedAt}`,
  );

  lines.push(
    '# HELP shizuha_agent_last_activity_seconds Unix timestamp (seconds) of the last completed turn',
    '# TYPE shizuha_agent_last_activity_seconds gauge',
  );
  for (const a of agents) {
    const ts = readLastTsSync(a.username);
    if (ts !== null) {
      lines.push(`shizuha_agent_last_activity_seconds{agent="${a.username}"} ${ts / 1000}`);
    }
  }

  appendEfficiencyTelemetryMetrics(lines, agents);

  lines.push(
    '# HELP shizuha_agent_capacity_unavailable 1 if agent is in PLAT-879 token-pool backoff (PLAT-962)',
    '# TYPE shizuha_agent_capacity_unavailable gauge',
  );
  for (const a of agents) {
    const exhausted = providerExhausted.get(a.username) ?? false;
    lines.push(`shizuha_agent_capacity_unavailable{agent="${a.username}"} ${a.capacityUnavailable || exhausted ? 1 : 0}`);
  }

  lines.push(
    '# HELP shizuha_agent_provider_healthy Model provider reachable (1) or down/quota-exhausted (0).',
    '# TYPE shizuha_agent_provider_healthy gauge',
  );
  for (const a of agents) {
    const exhausted = providerExhausted.get(a.username) ?? false;
    lines.push(`shizuha_agent_provider_healthy{agent="${a.username}",cohort="claude"} ${exhausted ? 0 : 1}`);
  }

  const autoAndon = getAutoAndonMetricsSnapshot();
  lines.push(
    '# HELP shizuha_auto_andon_fired_total Total auto-andon manager DMs sent successfully by the bridge detector.',
    '# TYPE shizuha_auto_andon_fired_total counter',
    `shizuha_auto_andon_fired_total ${autoAndon.firedTotal}`,
    '# HELP shizuha_auto_andon_send_failed_total Total auto-andon manager DM send failures; rate limit is cleared on failure so the detector can retry.',
    '# TYPE shizuha_auto_andon_send_failed_total counter',
    `shizuha_auto_andon_send_failed_total ${autoAndon.sendFailedTotal}`,
    '# HELP shizuha_auto_andon_rate_limited_total Total auto-andon signals suppressed by the per-agent/per-obstacle 6h rate limit.',
    '# TYPE shizuha_auto_andon_rate_limited_total counter',
    `shizuha_auto_andon_rate_limited_total ${autoAndon.rateLimitedTotal}`,
  );

  // PLAT-1113 / PLAT-1073: expose bridge-degradation metric families consumed
  // by ShizuhaAgent* Prometheus alerts. The runtime daemon already knows the
  // capacity/backoff and provider-exhaustion signals; deeper bridge fields that
  // are not available in this in-process exporter are emitted as explicit zeroes
  // so alert rules can safely join on stable families instead of missing series.
  lines.push(
    '# HELP shizuha_agent_bridge_degraded 1 if bridge health reports any degraded provider/auth/capacity/runaway/empty-turn signal.',
    '# TYPE shizuha_agent_bridge_degraded gauge',
    '# HELP shizuha_agent_bridge_auth_unavailable 1 if bridge health reports auth unavailable.',
    '# TYPE shizuha_agent_bridge_auth_unavailable gauge',
    '# HELP shizuha_agent_bridge_capacity_unavailable 1 if bridge health reports provider capacity/quota unavailable.',
    '# TYPE shizuha_agent_bridge_capacity_unavailable gauge',
    '# HELP shizuha_agent_consecutive_error_turns Consecutive provider/error turns from bridge health.',
    '# TYPE shizuha_agent_consecutive_error_turns gauge',
    '# HELP shizuha_agent_empty_turn_streak Consecutive empty turns from bridge health.',
    '# TYPE shizuha_agent_empty_turn_streak gauge',
    '# HELP shizuha_agent_runaway_queue_depth 1 if bridge health reports busy with runaway queue depth.',
    '# TYPE shizuha_agent_runaway_queue_depth gauge',
  );
  for (const a of agents) {
    const exhausted = providerExhausted.get(a.username) ?? false;
    const capacity = a.capacityUnavailable || exhausted;
    const degraded = a.running && capacity;
    lines.push(`shizuha_agent_bridge_degraded{agent="${a.username}"} ${degraded ? 1 : 0}`);
    lines.push(`shizuha_agent_bridge_auth_unavailable{agent="${a.username}"} 0`);
    lines.push(`shizuha_agent_bridge_capacity_unavailable{agent="${a.username}"} ${capacity ? 1 : 0}`);
    lines.push(`shizuha_agent_consecutive_error_turns{agent="${a.username}"} 0`);
    lines.push(`shizuha_agent_empty_turn_streak{agent="${a.username}"} 0`);
    lines.push(`shizuha_agent_runaway_queue_depth{agent="${a.username}"} 0`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Start the agent health exporter HTTP server.
 *
 * @param getAgents  Callback invoked on every scrape to return current agent state.
 *                   Re-reads disk state (enabled-agents.json + agents.json) on each
 *                   call so enable/disable changes are reflected without a restart
 *                   (PLAT-588).
 * @param port       Default 9888, matching PULSE_HEALTH_EXPORTER_URL default.
 */
export function startAgentHealthServer(
  getAgents: () => AgentHealthInfo[],
  port = 9888,
): http.Server {
  const existing = serversByPort.get(port);
  if (existing) return existing;

  const server = http.createServer((_req, res) => {
    try {
      const body = buildMetrics(getAgents());
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });

  serversByPort.set(port, server);
  server.once('close', () => {
    if (serversByPort.get(port) === server) serversByPort.delete(port);
  });
  server.listen(port, '0.0.0.0');
  server.on('error', (err) => {
    if (!server.listening && serversByPort.get(port) === server) {
      serversByPort.delete(port);
    }
    // Non-fatal: if 9888 is already taken, log and continue without the exporter.
    console.warn(`[agent-health-exporter] port ${port} error: ${(err as Error).message}`);
  });

  return server;
}

export function stopAgentHealthServer(port = 9888): Promise<void> {
  const server = serversByPort.get(port);
  if (!server) return Promise.resolve();
  serversByPort.delete(port);
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
