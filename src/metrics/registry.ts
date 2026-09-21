/**
 * SCLI-74: Prometheus metrics registry — Phase 1 gauges from SCLI-31 telemetry.
 * PLAT-479: Added shizuha_agent_last_activity_seconds for org-health sweep.
 *
 * renderMetrics()         — aggregate across all registered in-process windows.
 * renderMetricsFromFiles() — read per-agent JSONL telemetry files; used by the
 *                            daemon dashboard which cannot share in-process memory
 *                            with child gateway processes.
 *
 * Both paths filter records to the most-recent runId before aggregating so that
 * prior-run data does not bleed into current-run metrics (kei P1).
 */
import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import * as fs from 'node:fs';
import { getAllTelemetryWindows } from '../agent/loop.js';
import type { TurnTelemetryRecord } from '../telemetry/turn-telemetry.js';

export const metricsRegistry = new Registry();

const activeRuns = new Gauge({
  name: 'shizuha_active_runs',
  help: 'Number of active CLI sessions (1 per gateway process with a running session)',
  labelNames: ['agent', 'model'] as const,
  registers: [metricsRegistry],
});

const tokensPerTurn = new Gauge({
  name: 'shizuha_run_tokens_per_turn',
  help: 'Rolling average output tokens per turn for the current run',
  labelNames: ['agent', 'run_id', 'model'] as const,
  registers: [metricsRegistry],
});

const errorDensity = new Gauge({
  name: 'shizuha_run_error_density',
  help: 'Fraction of tool calls that resulted in an error (last N turns, current run only)',
  labelNames: ['agent', 'run_id', 'model'] as const,
  registers: [metricsRegistry],
});

const turnCount = new Gauge({
  name: 'shizuha_run_turn_count',
  help: 'Total turns completed in the current run',
  labelNames: ['agent', 'run_id', 'model'] as const,
  registers: [metricsRegistry],
});

const callsPerMinute = new Gauge({
  name: 'shizuha_agent_calls_per_minute',
  help: 'Completed model turns per minute over the current telemetry window (SCLI-195)',
  labelNames: ['agent', 'run_id', 'model'] as const,
  registers: [metricsRegistry],
});

const promptOutputRatio = new Gauge({
  name: 'shizuha_agent_prompt_output_ratio',
  help: 'Prompt input tokens divided by output tokens over the current telemetry window (SCLI-195)',
  labelNames: ['agent', 'run_id', 'model'] as const,
  registers: [metricsRegistry],
});

const loopGuardHits = new Gauge({
  name: 'shizuha_agent_loop_guard_hits',
  help: 'Loop/expensive-turn guard hits over the current telemetry window (SCLI-195)',
  labelNames: ['agent', 'run_id', 'model'] as const,
  registers: [metricsRegistry],
});

// PLAT-479: Last-activity timestamp consumed by shizuha-tasks _scrape_agent_health.
const lastActivityTimestamp = new Gauge({
  name: 'shizuha_agent_last_activity_seconds',
  help: 'Unix timestamp (seconds) of the most recently completed turn for this agent',
  labelNames: ['agent'] as const,
  registers: [metricsRegistry],
});

const heartbeatPromptEstimate = new Gauge({
  name: 'shizuha_agent_heartbeat_prompt_token_estimate',
  help: 'Prompt token estimate from the latest current-run heartbeat/scheduled turn for this agent',
  labelNames: ['agent', 'run_id', 'model', 'source_kind', 'compaction_action'] as const,
  registers: [metricsRegistry],
});

const heartbeatTtftMs = new Gauge({
  name: 'shizuha_agent_heartbeat_ttft_ms',
  help: 'TTFT in milliseconds from the latest current-run heartbeat/scheduled turn for this agent',
  labelNames: ['agent', 'run_id', 'model', 'source_kind', 'compaction_action'] as const,
  registers: [metricsRegistry],
});

const heartbeatBudgetExceeded = new Gauge({
  name: 'shizuha_agent_heartbeat_pre_provider_budget_exceeded',
  help: '1 if the latest current-run heartbeat/scheduled turn exceeded its pre-provider prompt budget',
  labelNames: ['agent', 'run_id', 'model', 'source_kind', 'compaction_action'] as const,
  registers: [metricsRegistry],
});

// PLAT-4112 Guard 4: the reconnect loop already tracks a consecutive streak,
// but until this gauge the streak existed only inside the agent process and a
// fleet-wide outage was indistinguishable from a quiet agent.  Alertmanager can
// page on a sustained value (for example >= 3) while retaining server identity.
const mcpReconnectConsecutiveFailures = new Gauge({
  name: 'shizuha_mcp_reconnect_consecutive_failures',
  help: 'Current consecutive MCP reconnect failures for this agent and server; reset to zero after a successful reconnect (PLAT-4112)',
  labelNames: ['agent', 'server'] as const,
  registers: [metricsRegistry],
});

export function setMcpReconnectConsecutiveFailures(server: string, failures: number): void {
  const agent = process.env['AGENT_USERNAME'] || process.env['AGENT_NAME'] || 'unknown';
  mcpReconnectConsecutiveFailures.set({ agent, server }, Math.max(0, failures));
}

// PLAT-8689 (framework legs 1+2): the consecutive-failures gauge alone could
// not answer "why is this seat wedged" — the series appeared on failure and
// its reason lived only in process-local logs the broker never surfaced.
// Two additions, mirroring the absent()-branch pattern used elsewhere:
//  - a failure counter with a CLOSED reason_class union (never untrusted text)
//    so fleet-wide queries can distinguish ingress-deny (403) from egress
//    timeouts from route-missing without scraping agent stdout;
//  - a success counter, so recovery is directly verifiable from metrics
//    (the gauge resetting to 0 is indistinguishable from a series that was
//    never created when the process never failed).
export const mcpReconnectFailures = new Counter({
  name: 'shizuha_mcp_reconnect_failures_total',
  help: 'Total MCP reconnect failures by closed reason class (PLAT-8689): auth (401/403), route_missing (405/501), http_5xx, timeout, conn_reset, dns, other',
  labelNames: ['agent', 'server', 'reason_class'] as const,
  registers: [metricsRegistry],
});

export const mcpReconnectConnectSuccesses = new Counter({
  name: 'shizuha_mcp_reconnect_connect_success_total',
  help: 'Total successful MCP (re)connects per server (PLAT-8689) — recovery is verifiable from metrics alone',
  labelNames: ['agent', 'server'] as const,
  registers: [metricsRegistry],
});

export type McpReconnectReasonClass =
  | 'auth'
  | 'route_missing'
  | 'http_5xx'
  | 'timeout'
  | 'conn_reset'
  | 'dns'
  | 'other';

export function recordMcpReconnectFailure(server: string, reasonClass: McpReconnectReasonClass): void {
  const agent = process.env['AGENT_USERNAME'] || process.env['AGENT_NAME'] || 'unknown';
  mcpReconnectFailures.inc({ agent, server, reason_class: reasonClass });
}

export function recordMcpReconnectSuccess(server: string): void {
  const agent = process.env['AGENT_USERNAME'] || process.env['AGENT_NAME'] || 'unknown';
  mcpReconnectConnectSuccesses.inc({ agent, server });
}

// CTX-123: provider timeout counter — incremented by vllm.ts on non-streaming response timeouts.
// Scraped by Prometheus → PrometheusRule → Alertmanager → Pulse incident.
export const providerTimeouts = new Counter({
  name: 'cortex_provider_timeout_total',
  help: 'Total vLLM non-streaming response timeouts on the cortex gateway (CTX-123)',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

// HIVE-2166 (HIVE-314 S3): org-scoped provider resolution liveness (PLAT-1254).
// `reason` is a closed union (ProviderUnavailableReason) — never untrusted text.
export const providerResolutionAttempts = new Counter({
  name: 'provider_resolution_attempts_total',
  help: 'Org-scoped provider resolution attempts (HIVE-314 S3), by outcome, provider type, and org-scoped reason.',
  labelNames: ['outcome', 'provider_type', 'reason'] as const,
  registers: [metricsRegistry],
});

export const providerResolutionInvariantViolations = new Counter({
  name: 'provider_resolution_invariant_violation_total',
  help: 'Cross-org provider isolation invariant violations (fail-loud, Security-owned finding + DMs).',
  labelNames: ['provider_type'] as const,
  registers: [metricsRegistry],
});

// CON-223: admission accounting at the shared Connect event-source boundary.
// `reason` is deliberately bounded by a union in recordConnectIngressEvent so
// untrusted message content can never become a high-cardinality metric label.
export type ConnectChannel = 'direct' | 'group' | 'unknown';
export type ConnectIngressOutcome = 'delivered' | 'suppressed';
export type ConnectIngressReason =
  | 'actionable'
  | 'ack_only'
  | 'reaction_only'
  | 'no_reply_requested'
  | 'thread_close'
  | 'self_echo'
  | 'duplicate'
  | 'replay_cap'
  | 'replay_too_old';

const connectIngressEventsTotal = new Counter({
  name: 'shizuha_connect_ingress_events_total',
  help: 'Connect inbound events admitted to agent turns or suppressed at ingress (CON-223)',
  labelNames: ['channel', 'decision', 'reason'] as const,
  registers: [metricsRegistry],
});

export function recordConnectIngressEvent(
  outcome: ConnectIngressOutcome,
  reason: ConnectIngressReason,
  channel: ConnectChannel = 'unknown',
): void {
  connectIngressEventsTotal.inc({ channel, decision: outcome, reason });
}

export type ConnectReplyObligation = 'none' | 'optional' | 'required';
const connectTurnsTotal = new Counter({
  name: 'shizuha_connect_turns_total',
  help: 'Connect agent turns by authenticated channel and reply obligation (CON-226)',
  labelNames: ['channel', 'reply_obligation'] as const,
  registers: [metricsRegistry],
});

export function recordConnectTurn(channel: ConnectChannel, replyObligation: ConnectReplyObligation): void {
  connectTurnsTotal.inc({ channel, reply_obligation: replyObligation });
}


export type ScliInferenceOutcome = 'success' | 'error' | 'timeout' | 'aborted';
export type ScliInferenceTimeoutPhase = 'connect' | 'headers' | 'first_chunk' | 'mid_stream_stall' | 'finalization' | 'none';

export interface ScliInferenceTelemetryMetric {
  provider: string;
  model: string;
  outcome: ScliInferenceOutcome;
  errorClass?: string;
  timeoutPhase?: ScliInferenceTimeoutPhase;
  firstChunkMs?: number | null;
  firstTokenMs?: number | null;
}

const scliInferenceRequestsTotal = new Counter({
  name: 'scli_inference_requests_total',
  help: 'Total SCLI inference requests by provider/model/outcome/error class (PLAT-3121)',
  labelNames: ['provider', 'model', 'outcome', 'error_class'] as const,
  registers: [metricsRegistry],
});

const scliInferenceFirstChunkSeconds = new Histogram({
  name: 'scli_inference_first_chunk_seconds',
  help: 'Seconds from SCLI inference request start to first received provider chunk (PLAT-3121)',
  labelNames: ['provider', 'model'] as const,
  buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

const scliInferenceFirstTokenSeconds = new Histogram({
  name: 'scli_inference_first_token_seconds',
  help: 'Seconds from SCLI inference request start to first generated text/tool token (PLAT-3121)',
  labelNames: ['provider', 'model'] as const,
  buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

const scliInferenceStreamStallsTotal = new Counter({
  name: 'scli_inference_stream_stalls_total',
  help: 'Total SCLI inference stream stalls/timeouts by provider/model/phase (PLAT-3121)',
  labelNames: ['provider', 'model', 'phase'] as const,
  registers: [metricsRegistry],
});

const scliInferenceErrorsTotal = new Counter({
  name: 'scli_inference_errors_total',
  help: 'Total SCLI inference errors by provider/model/error class (PLAT-3121)',
  labelNames: ['provider', 'model', 'error_class'] as const,
  registers: [metricsRegistry],
});

// PLAT-4189 follow-up: serialized-prompt prefix divergence counter. Incremented
// by the provider-path PromptPrefixGuard whenever a request's canonical payload
// is NOT an append-only extension of the session's previous request — every
// such divergence busts the vLLM prefix cache and forces a full re-prefill.
// `part` is a bounded class (model|tools|system|message|residual|truncation|unknown).
const scliPromptPrefixDivergenceTotal = new Counter({
  name: 'scli_prompt_prefix_divergence_total',
  help: 'Provider requests whose serialized prompt diverged from the previous request of the same session before the append point (busts the vLLM prefix cache)',
  labelNames: ['provider', 'model', 'part'] as const,
  registers: [metricsRegistry],
});

export function recordPromptPrefixDivergence(provider: string, model: string, part: string): void {
  scliPromptPrefixDivergenceTotal.inc({
    provider: boundedMetricLabel(provider, 'unknown'),
    model: boundedMetricLabel(model, 'unknown'),
    part: boundedMetricLabel(part, 'unknown'),
  });
}

function boundedMetricLabel(value: string | undefined | null, fallback: string): string {
  const raw = String(value || fallback).trim().toLowerCase();
  return raw.replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 120) || fallback;
}

export function recordScliInferenceTelemetry(event: ScliInferenceTelemetryMetric): void {
  const provider = boundedMetricLabel(event.provider, 'unknown');
  const model = boundedMetricLabel(event.model, 'unknown');
  const outcome = boundedMetricLabel(event.outcome, 'unknown');
  const errorClass = boundedMetricLabel(event.errorClass || 'none', 'none');
  scliInferenceRequestsTotal.inc({ provider, model, outcome, error_class: errorClass });
  if (event.outcome !== 'success' || errorClass !== 'none') {
    scliInferenceErrorsTotal.inc({ provider, model, error_class: errorClass });
  }
  const phase = event.timeoutPhase && event.timeoutPhase !== 'none'
    ? boundedMetricLabel(event.timeoutPhase, 'unknown')
    : '';
  if (phase) scliInferenceStreamStallsTotal.inc({ provider, model, phase });
  if (typeof event.firstChunkMs === 'number' && Number.isFinite(event.firstChunkMs) && event.firstChunkMs >= 0) {
    scliInferenceFirstChunkSeconds.observe({ provider, model }, event.firstChunkMs / 1000);
  }
  if (typeof event.firstTokenMs === 'number' && Number.isFinite(event.firstTokenMs) && event.firstTokenMs >= 0) {
    scliInferenceFirstTokenSeconds.observe({ provider, model }, event.firstTokenMs / 1000);
  }
}

/**
 * Compute Phase 1 gauges from a slice of records.
 * Filters to the most-recent runId so that prior-run records in a rolling
 * window do not inflate the current run's averages.
 */
function accumulateRecords(records: TurnTelemetryRecord[]): void {
  if (records.length === 0) return;
  const last = records[records.length - 1]!;
  const currentRunId = last.runId;
  // Only aggregate turns that belong to the current active run.
  const runRecords = records.filter((r) => r.runId === currentRunId);
  if (runRecords.length === 0) return;

  const agent = last.agent ?? '';
  const model = last.model;
  const runId = currentRunId;

  activeRuns.set({ agent, model }, 1);

  // last.ts is Date.now() (ms); convert to seconds for the Prometheus convention.
  if (last.ts) {
    lastActivityTimestamp.set({ agent }, last.ts / 1000);
  }

  const avgTokens = runRecords.reduce((s, r) => s + r.outputTokens, 0) / runRecords.length;
  tokensPerTurn.set({ agent, run_id: runId, model }, avgTokens);

  const firstTs = runRecords[0]?.ts ?? last.ts;
  const elapsedMs = Math.max(1_000, (last.ts || 0) - (firstTs || 0));
  callsPerMinute.set({ agent, run_id: runId, model }, runRecords.length / (elapsedMs / 60_000));
  const totalInputTokens = runRecords.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = runRecords.reduce((s, r) => s + r.outputTokens, 0);
  promptOutputRatio.set({ agent, run_id: runId, model }, totalInputTokens / Math.max(1, totalOutputTokens));
  loopGuardHits.set({ agent, run_id: runId, model }, runRecords.reduce((s, r) => s + r.loopGuardHits, 0));

  let totalTools = 0;
  let totalErrors = 0;
  for (const r of runRecords) {
    totalTools += r.toolOk + r.toolError + r.toolNoOp;
    totalErrors += r.toolError;
  }
  const density = totalTools > 0 ? totalErrors / totalTools : 0;
  errorDensity.set({ agent, run_id: runId, model }, density);

  turnCount.set({ agent, run_id: runId, model }, last.turnIndex + 1);

  const latestHeartbeat = [...runRecords].reverse().find((r) => r.sourceKind === 'heartbeat' || r.sourceKind === 'scheduled');
  if (latestHeartbeat) {
    const sourceKind = latestHeartbeat.sourceKind ?? 'unknown';
    const compactionAction = latestHeartbeat.compactionAction ?? 'none';
    const labels = { agent, run_id: runId, model, source_kind: sourceKind, compaction_action: compactionAction };
    if (latestHeartbeat.promptTokenEstimate !== undefined) {
      heartbeatPromptEstimate.set(labels, latestHeartbeat.promptTokenEstimate);
    }
    if (latestHeartbeat.ttftMs !== null && latestHeartbeat.ttftMs !== undefined) {
      heartbeatTtftMs.set(labels, latestHeartbeat.ttftMs);
    }
    heartbeatBudgetExceeded.set(labels, latestHeartbeat.preProviderBudgetExceeded ? 1 : 0);
  }
}

/** Read the last `n` records from a JSONL telemetry file. Returns [] on error. */
function readLastRecordsSync(filePath: string, n = 50): TurnTelemetryRecord[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trimEnd().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => { try { return JSON.parse(l) as TurnTelemetryRecord; } catch { return null; } })
      .filter((r): r is TurnTelemetryRecord => r !== null);
  } catch {
    return [];
  }
}

/**
 * Render Phase 1 metrics from all currently registered in-process telemetry
 * windows. Used by the gateway metrics server (:9103) and the serve-mode
 * /metrics endpoint in server.ts.
 */
export async function renderMetrics(): Promise<string> {
  activeRuns.reset();
  tokensPerTurn.reset();
  errorDensity.reset();
  turnCount.reset();
  callsPerMinute.reset();
  promptOutputRatio.reset();
  loopGuardHits.reset();
  lastActivityTimestamp.reset();
  heartbeatPromptEstimate.reset();
  heartbeatTtftMs.reset();
  heartbeatBudgetExceeded.reset();

  for (const win of getAllTelemetryWindows()) {
    accumulateRecords(win.query());
  }

  return metricsRegistry.metrics();
}

/**
 * Render Phase 1 metrics by reading per-agent JSONL telemetry files.
 * Used by daemon/dashboard.ts /metrics endpoint: child gateway processes are
 * separate OS processes and cannot share in-process TurnTelemetryWindow objects
 * with the daemon, so we fall back to the durable JSONL files each gateway writes.
 */
export async function renderMetricsFromFiles(jsonlPaths: string[]): Promise<string> {
  activeRuns.reset();
  tokensPerTurn.reset();
  errorDensity.reset();
  turnCount.reset();
  callsPerMinute.reset();
  promptOutputRatio.reset();
  loopGuardHits.reset();
  lastActivityTimestamp.reset();
  heartbeatPromptEstimate.reset();
  heartbeatTtftMs.reset();
  heartbeatBudgetExceeded.reset();

  for (const p of jsonlPaths) {
    accumulateRecords(readLastRecordsSync(p));
  }

  return metricsRegistry.metrics();
}
