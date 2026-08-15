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
import type {
  RuntimeRollDeferralProtocol,
  RuntimeRollDeferralReason,
} from '../daemon/runtime-roll-deferral.js';
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

// HIVE-249 (ADR-0004 ph6): identity-guarantee gauge — 1 = healthy, 0 = violates invariant.
// Set by the daemon at each agent spawn via setAgentIdentityOk(); persists until next spawn.
const agentIdentityOk = new Gauge({
  name: 'shizuha_agent_identity_ok',
  help: '1 if the agent satisfies the canonical Shizuha-ID invariant (ADR-0004), 0 if it violates it',
  labelNames: ['agent'] as const,
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

export function setAgentIdentityOk(agent: string, ok: boolean): void {
  agentIdentityOk.set({ agent }, ok ? 1 : 0);
}

// CTX-123: provider timeout counter — incremented by vllm.ts on non-streaming response timeouts.
// Scraped by Prometheus → PrometheusRule → Alertmanager → Pulse incident.
export const providerTimeouts = new Counter({
  name: 'cortex_provider_timeout_total',
  help: 'Total vLLM non-streaming response timeouts on the cortex gateway (CTX-123)',
  labelNames: ['reason'] as const,
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

// PLAT-1309 (PLAT-706/PLAT-1061 INV-6 "drift is observable" + PLAT-1254 fail-loud):
// agent-state reconciler (reconcileRuntimeLifecycle) drift/convergence metrics.
// Set in-process by the daemon reconcile loop; the daemon /metrics endpoint renders
// the same shared metricsRegistry, so these ride out on every scrape. renderMetrics*
// never reset them (they are daemon-owned lifecycle state, not per-run windows), so a
// reconciler that silently stops converging is visible: agents_in_drift stays > 0 and
// last_run_timestamp stops advancing → ReconcilerDriftPersists alert → owner-team DM.
const reconcileCyclesTotal = new Counter({
  name: 'shizuha_reconcile_cycles_total',
  help: 'Total agent-state reconcile cycles the daemon has run (PLAT-1309)',
  registers: [metricsRegistry],
});

const reconcileLastRunTs = new Gauge({
  name: 'shizuha_reconcile_last_run_timestamp_seconds',
  help: 'Unix timestamp (seconds) of the most recent reconcile cycle — liveness signal; stalls if the loop dies (PLAT-1309)',
  registers: [metricsRegistry],
});

const reconcileAgentsInDrift = new Gauge({
  name: 'shizuha_reconcile_agents_in_drift',
  help: 'Agents whose runtime diverged from desired state at the last non-skipped reconcile (toStop + toStartK8s); should return to 0 within one cycle (PLAT-1309/INV-6)',
  registers: [metricsRegistry],
});

const reconcileRepairsTotal = new Counter({
  name: 'shizuha_reconcile_repairs_total',
  help: 'Total reconcile repairs attempted, by action (stop = zombie stopped, start_k8s = desired-enabled re-applied) (PLAT-1309)',
  labelNames: ['action'] as const,
  registers: [metricsRegistry],
});

const reconcileStartFailuresTotal = new Counter({
  name: 'shizuha_reconcile_start_failures_total',
  help: 'Total k8s reconcile start failures (desired-enabled agent could not be re-applied) — repeated failures mean drift is NOT converging (PLAT-1309/PLAT-1254)',
  registers: [metricsRegistry],
});

const reconcileRepairNextRetryTs = new Gauge({
  name: 'shizuha_reconcile_repair_next_retry_timestamp_seconds',
  help: 'Unix timestamp for the next admitted runtime repair after per-agent failure backoff; 0 means no repair is backed off',
  labelNames: ['agent', 'action'] as const,
  registers: [metricsRegistry],
});

const reconcileRepairFailureStreak = new Gauge({
  name: 'shizuha_reconcile_repair_failure_streak',
  help: 'Consecutive runtime repair failures for one agent and desired-state key; resets when desired state changes or repair converges',
  labelNames: ['agent', 'action'] as const,
  registers: [metricsRegistry],
});

const reconcileRepairDeferralsTotal = new Counter({
  name: 'shizuha_reconcile_repair_deferrals_total',
  help: 'Runtime repair attempts suppressed by per-agent in-flight deduplication or failure backoff',
  labelNames: ['action', 'reason'] as const,
  registers: [metricsRegistry],
});

// PLAT-5335: timestamp (rather than a retry counter) makes the duration stable
// across the controller's variable reconcile cadence. Prometheus computes the
// live elapsed wait as time() - this value; the manager removes the series as
// soon as the bridge admits the roll or the Deployment converges.
const runtimeRollDeferralStartTimestampSeconds = new Gauge({
  name: 'shizuha_runtime_roll_deferral_start_timestamp_seconds',
  help: 'Unix timestamp when the current runtime-roll live-gate deferral began; absent when the agent is not actively deferred (PLAT-5335)',
  labelNames: ['agent', 'reason', 'protocol'] as const,
  registers: [metricsRegistry],
});

type RuntimeRollDeferralMetricLabels = {
  agent: string;
  reason: RuntimeRollDeferralReason;
  protocol: RuntimeRollDeferralProtocol;
};

// A reason/protocol change must remove the old labelled series rather than
// leave two simultaneous alerts for one agent.
const runtimeRollDeferralMetricLabels = new Map<string, RuntimeRollDeferralMetricLabels>();

const reconcileSkippedTotal = new Counter({
  name: 'shizuha_reconcile_skipped_total',
  help: 'Total reconcile cycles skipped by a SCLI-149 safety guard, by reason (empty-set / mass-stop circuit breaker) — persistent skips mean drift is not being repaired (PLAT-1309)',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

const reconcileMode = new Gauge({
  name: 'shizuha_reconcile_mode',
  help: '1 for the active reconcile mode; the runtime reconcile is ENFORCE (it actually stops/starts runtimes — there is no observe/dry-run code path) (PLAT-1309)',
  labelNames: ['mode'] as const,
  registers: [metricsRegistry],
});

const runtimeSsotRefreshOk = new Gauge({
  name: 'shizuha_reconcile_runtime_ssot_refresh_ok',
  help: '1 when the latest Hive runtime-lane SSOT refresh did not fail fleet-wide; 0 when every attempted authenticated read failed (PLAT-4112)',
  registers: [metricsRegistry],
});

const runtimeSsotRefreshLastSuccessTs = new Gauge({
  name: 'shizuha_reconcile_runtime_ssot_refresh_last_success_timestamp_seconds',
  help: 'Unix timestamp of the latest non-total-failure Hive runtime-lane SSOT refresh (PLAT-4112)',
  registers: [metricsRegistry],
});

const runtimeSsotRefreshFailuresTotal = new Counter({
  name: 'shizuha_reconcile_runtime_ssot_refresh_failures_total',
  help: 'Total per-agent Hive runtime-lane SSOT read failures (PLAT-4112)',
  registers: [metricsRegistry],
});

// PLAT-3170 / PLAT-1254 fail-loud GitHub credential invariant for k8s-native
// fleet agents. Prometheus can alert on shizuha_k8s_github_auth_ok == 0 and
// route by owner_group/team while naming the affected agent. The daemon also
// sends a rate-limited Connect DM to the resolved cluster manager on failures;
// the counters below make notifier liveness/failure observable.
const k8sGithubAuthOk = new Gauge({
  name: 'shizuha_k8s_github_auth_ok',
  help: '1 when a k8s-native agent with an active GitHub grant has a non-empty runtime GITHUB_TOKEN and the live token passes gh api user + private repo probe; 0 means the GitHub auth invariant is broken (PLAT-3170)',
  labelNames: ['agent', 'team', 'owner_group'] as const,
  registers: [metricsRegistry],
});

const k8sGithubAuthLastCheckTs = new Gauge({
  name: 'shizuha_k8s_github_auth_last_check_timestamp_seconds',
  help: 'Unix timestamp (seconds) of the most recent k8s GitHub auth probe for this agent — liveness signal for PLAT-3170',
  labelNames: ['agent', 'team', 'owner_group'] as const,
  registers: [metricsRegistry],
});

const k8sGithubAuthFailuresTotal = new Counter({
  name: 'shizuha_k8s_github_auth_failures_total',
  help: 'Total failed k8s GitHub auth probes by bounded reason; alert annotations use the matching shizuha_k8s_github_auth_ok labels to name agent/team/owner_group (PLAT-3170)',
  labelNames: ['agent', 'team', 'owner_group', 'reason'] as const,
  registers: [metricsRegistry],
});

const k8sGithubAuthAndonFailuresTotal = new Counter({
  name: 'shizuha_k8s_github_auth_andon_failures_total',
  help: 'Total failures sending the rate-limited Connect DM page for k8s GitHub auth probe failures (PLAT-3170/PLAT-1254)',
  registers: [metricsRegistry],
});

const agentAccountReconcileAndonTotal = new Counter({
  name: 'shizuha_agent_account_reconcile_andon_total',
  help: 'Total daemon-side Connect DM notifier outcomes for failed agent account password reconcile/provisioning at startup (PLAT-4006/PLAT-1254)',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

/** PLAT-1309: called once at daemon init to make ENFORCE mode observable on /metrics. */
export function setReconcileMode(mode: 'enforce' | 'observe'): void {
  reconcileMode.set({ mode }, 1);
}

export function recordRuntimeSsotRefresh(totalFailure: boolean, failedAgents: number): void {
  runtimeSsotRefreshOk.set(totalFailure ? 0 : 1);
  if (!totalFailure) runtimeSsotRefreshLastSuccessTs.set(Date.now() / 1000);
  if (failedAgents > 0) runtimeSsotRefreshFailuresTotal.inc(failedAgents);
}

/**
 * PLAT-1309: record one reconcile cycle. `skipped` = the SCLI-149 safety-guard reason
 * when the plan was not executed (empty-set / mass-stop circuit breaker), else null.
 * On a non-skipped cycle `driftCount` is the number of agents that needed repair
 * (toStop + toStartK8s) — it should fall back to 0 the next cycle once repairs land.
 */
export function recordReconcileCycle(opts: {
  driftCount: number;
  repairsStop: number;
  repairsStartK8s: number;
  skipped?: string | null;
}): void {
  reconcileCyclesTotal.inc();
  reconcileLastRunTs.set(Date.now() / 1000);
  if (opts.skipped) {
    reconcileSkippedTotal.inc({ reason: opts.skipped });
    // Leave agents_in_drift at its last computed value: a skip means the guard
    // refused to act, so any drift is still unrepaired — not resolved.
    return;
  }
  reconcileAgentsInDrift.set(opts.driftCount);
  if (opts.repairsStop > 0) reconcileRepairsTotal.inc({ action: 'stop' }, opts.repairsStop);
  if (opts.repairsStartK8s > 0) reconcileRepairsTotal.inc({ action: 'start_k8s' }, opts.repairsStartK8s);
}

/** PLAT-1309: increment when a k8s reconcile start fails (drift not converging). */
export function recordReconcileStartFailure(): void {
  reconcileStartFailuresTotal.inc();
}

export function recordReconcileRepairBackoff(
  agent: string,
  action: 'start' | 'refresh',
  failureCount: number,
  nextRetryAtMs: number,
): void {
  reconcileRepairFailureStreak.set({ agent, action }, failureCount);
  reconcileRepairNextRetryTs.set({ agent, action }, nextRetryAtMs / 1000);
}

export function recordReconcileRepairDeferral(
  action: 'start' | 'refresh',
  reason: 'in_flight' | 'backoff' | 'settling',
): void {
  reconcileRepairDeferralsTotal.inc({ action, reason });
}

export function clearReconcileRepairBackoff(agent: string, action: 'start' | 'refresh'): void {
  reconcileRepairFailureStreak.set({ agent, action }, 0);
  reconcileRepairNextRetryTs.set({ agent, action }, 0);
}

export function setRuntimeRollDeferralStartTimestamp(
  agent: string,
  reason: RuntimeRollDeferralReason,
  protocol: RuntimeRollDeferralProtocol,
  sinceMs: number,
): void {
  const previous = runtimeRollDeferralMetricLabels.get(agent);
  if (previous && (previous.reason !== reason || previous.protocol !== protocol)) {
    runtimeRollDeferralStartTimestampSeconds.remove(previous);
  }
  const labels = { agent, reason, protocol };
  runtimeRollDeferralStartTimestampSeconds.set(labels, sinceMs / 1000);
  runtimeRollDeferralMetricLabels.set(agent, labels);
}

export function clearRuntimeRollDeferralStartTimestamp(agent: string): void {
  const previous = runtimeRollDeferralMetricLabels.get(agent);
  if (!previous) return;
  runtimeRollDeferralStartTimestampSeconds.remove(previous);
  runtimeRollDeferralMetricLabels.delete(agent);
}

export interface K8sGithubAuthProbeMetricSample {
  username: string;
  team?: string | null;
  ownerGroup?: string | null;
  ok: boolean;
  reason: string;
  checkedAt?: string;
}

/** PLAT-3170: publish the GitHub-auth probe outcome with alert-routing labels. */
export function recordK8sGithubAuthProbe(samples: K8sGithubAuthProbeMetricSample[]): void {
  for (const sample of samples) {
    const labels = {
      agent: sample.username,
      team: sample.team || 'unknown',
      owner_group: sample.ownerGroup || sample.team || 'unknown',
    };
    k8sGithubAuthOk.set(labels, sample.ok ? 1 : 0);
    const ts = sample.checkedAt && Number.isFinite(Date.parse(sample.checkedAt))
      ? Date.parse(sample.checkedAt) / 1000
      : Date.now() / 1000;
    k8sGithubAuthLastCheckTs.set(labels, ts);
    if (!sample.ok) {
      k8sGithubAuthFailuresTotal.inc({ ...labels, reason: sample.reason || 'unknown' });
    }
  }
}

/** PLAT-3170: fail-loud if the direct Connect page path itself breaks. */
export function recordK8sGithubAuthAndonSendFailure(): void {
  k8sGithubAuthAndonFailuresTotal.inc();
}

/** PLAT-4006: make account-reconcile fail-loud notifier liveness observable. */
export function recordAgentAccountReconcileAndonOutcome(outcome: 'sent' | 'failed' | 'rate_limited'): void {
  agentAccountReconcileAndonTotal.inc({ outcome });
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
