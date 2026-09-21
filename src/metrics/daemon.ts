/**
 * PLAT-5758: daemon-owned metrics — registered ONLY when this module is
 * imported, which happens exclusively from the daemon/control-plane process
 * (src/daemon/*). Agent/gateway processes import src/metrics/registry.ts for
 * their runtime metrics and must NEVER register these daemon-owned families.
 *
 * Before this split, the reconcile gauges (shizuha_reconcile_*) lived in the
 * shared registry module, so any agent process that emitted a runtime metric
 * also registered the daemon's reconcile family at default 0 — turning every
 * agent pod into a latent RuntimeFleetSsotRefreshFailed alert target
 * (PLAT-5717 false-positive class). Keeping daemon-owned families in their own
 * module closes the ownership leak: an agent process cannot register what it
 * never imports.
 *
 * The daemon /metrics endpoint renders the same shared metricsRegistry, so
 * these families still ride out on every daemon scrape exactly as before.
 */
import { Gauge, Counter } from 'prom-client';
import { metricsRegistry } from './registry.js';
import type {
  RuntimeRollDeferralProtocol,
  RuntimeRollDeferralReason,
} from '../daemon/runtime-roll-deferral.js';

// HIVE-249 (ADR-0004 ph6): identity-guarantee gauge — 1 = healthy, 0 = violates invariant.
// Set by the daemon at each agent spawn via setAgentIdentityOk(); persists until next spawn.
const agentIdentityOk = new Gauge({
  name: 'shizuha_agent_identity_ok',
  help: '1 if the agent satisfies the canonical Shizuha-ID invariant (ADR-0004), 0 if it violates it',
  labelNames: ['agent'] as const,
  registers: [metricsRegistry],
});

export function setAgentIdentityOk(agent: string, ok: boolean): void {
  agentIdentityOk.set({ agent }, ok ? 1 : 0);
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
