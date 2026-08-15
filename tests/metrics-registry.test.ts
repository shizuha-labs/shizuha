import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMetricsFromFiles } from '../src/metrics/registry.js';
import type { TurnTelemetryRecord } from '../src/telemetry/turn-telemetry.js';

function record(overrides: Partial<TurnTelemetryRecord>): TurnTelemetryRecord {
  return {
    runId: 'run-1',
    agent: 'cora',
    turnIndex: 0,
    ts: 1_000,
    model: 'deepseek-v4-flash',
    provider: 'vllm',
    toolCalls: [],
    toolOk: 0,
    toolError: 0,
    toolNoOp: 0,
    filesEdited: 0,
    inputTokens: 10,
    outputTokens: 2,
    ttftMs: null,
    decodeTokensPerSec: null,
    timeOnTurnMs: 100,
    loopGuardHits: 0,
    ...overrides,
  };
}

describe('PLAT-1227 fleet metrics expose heartbeat prompt budget telemetry', () => {
  it('renders latest current-run heartbeat estimate, TTFT, source, action, and budget flag from JSONL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-1227-metrics-'));
    const file = path.join(dir, 'turn-telemetry.jsonl');
    fs.writeFileSync(file, [
      record({ runId: 'old-run', turnIndex: 0, promptTokenEstimate: 150_000, ttftMs: 90_000, sourceKind: 'heartbeat', compactionAction: 'none', preProviderBudgetExceeded: true }),
      record({ runId: 'run-1', turnIndex: 0, sourceKind: 'user', promptTokenEstimate: 20_000, ttftMs: 500 }),
      record({ runId: 'run-1', turnIndex: 1, sourceKind: 'heartbeat', promptTokenEstimate: 58_000, ttftMs: 21_000, compactionAction: 'compact', preProviderBudgetExceeded: false }),
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const metrics = await renderMetricsFromFiles([file]);

    expect(metrics).toContain('shizuha_agent_heartbeat_prompt_token_estimate{agent="cora",run_id="run-1",model="deepseek-v4-flash",source_kind="heartbeat",compaction_action="compact"} 58000');
    expect(metrics).toContain('shizuha_agent_heartbeat_ttft_ms{agent="cora",run_id="run-1",model="deepseek-v4-flash",source_kind="heartbeat",compaction_action="compact"} 21000');
    expect(metrics).toContain('shizuha_agent_heartbeat_pre_provider_budget_exceeded{agent="cora",run_id="run-1",model="deepseek-v4-flash",source_kind="heartbeat",compaction_action="compact"} 0');
    expect(metrics).not.toContain('150000');
  });
});

describe('PLAT-4112 sustained MCP reconnect watchdog metric', () => {
  it('exports the current per-agent/server streak and resets it after recovery', async () => {
    const { setMcpReconnectConsecutiveFailures, renderMetricsFromFiles } = await import('../src/metrics/registry.js');
    const previousAgent = process.env.AGENT_USERNAME;
    process.env.AGENT_USERNAME = 'ryo';
    try {
      setMcpReconnectConsecutiveFailures('shizuha-pulse', 3);
      let out = await renderMetricsFromFiles([]);
      expect(out).toContain('shizuha_mcp_reconnect_consecutive_failures{agent="ryo",server="shizuha-pulse"} 3');

      setMcpReconnectConsecutiveFailures('shizuha-pulse', 0);
      out = await renderMetricsFromFiles([]);
      expect(out).toContain('shizuha_mcp_reconnect_consecutive_failures{agent="ryo",server="shizuha-pulse"} 0');
    } finally {
      if (previousAgent === undefined) delete process.env.AGENT_USERNAME;
      else process.env.AGENT_USERNAME = previousAgent;
    }
  });
});

describe('PLAT-1309 agent-state reconciler drift/convergence metrics', () => {
  it('exports drift, convergence, repairs, skips, failures, and ENFORCE mode on /metrics render', async () => {
    const {
      setReconcileMode,
      recordReconcileCycle,
      recordRuntimeSsotRefresh,
      recordReconcileStartFailure,
      recordReconcileRepairBackoff,
      recordReconcileRepairDeferral,
      clearReconcileRepairBackoff,
      renderMetricsFromFiles,
    } = await import('../src/metrics/registry.js');

    // ENFORCE mode published once at daemon init.
    setReconcileMode('enforce');

    // Cycle 1: two agents drifted (1 zombie to stop, 1 desired-enabled to re-apply).
    recordReconcileCycle({ driftCount: 2, repairsStop: 1, repairsStartK8s: 1, skipped: null });
    recordRuntimeSsotRefresh(true, 2);
    // A k8s re-apply failed → drift not converging signal.
    recordReconcileStartFailure();
    recordReconcileRepairBackoff('mio', 'refresh', 2, 1_784_210_000_000);
    recordReconcileRepairDeferral('refresh', 'in_flight');
    recordReconcileRepairDeferral('refresh', 'backoff');
    // Cycle 2: repairs landed → drift back to 0 (convergence within one cycle).
    recordReconcileCycle({ driftCount: 0, repairsStop: 0, repairsStartK8s: 0, skipped: null });
    // Cycle 3: safety guard tripped → skip recorded, drift left unrepaired (not swallowed).
    recordReconcileCycle({ driftCount: 0, repairsStop: 0, repairsStartK8s: 0, skipped: 'mass-stop-circuit-breaker' });

    const out = await renderMetricsFromFiles([]);

    // liveness + mode observability (confirms ENFORCE off-host)
    expect(out).toContain('shizuha_reconcile_mode{mode="enforce"} 1');
    expect(out).toMatch(/shizuha_reconcile_last_run_timestamp_seconds \d/);
    expect(out).toMatch(/shizuha_reconcile_cycles_total \d/);
    // convergence: drift observable and returned to 0 after repairs
    expect(out).toContain('shizuha_reconcile_agents_in_drift 0');
    // repairs attributed by action
    expect(out).toContain('shizuha_reconcile_repairs_total{action="stop"} 1');
    expect(out).toContain('shizuha_reconcile_repairs_total{action="start_k8s"} 1');
    // fail-loud signals: start failure + safety-guard skip both counted
    expect(out).toContain('shizuha_reconcile_start_failures_total 1');
    expect(out).toContain('shizuha_reconcile_runtime_ssot_refresh_ok 0');
    expect(out).toContain('shizuha_reconcile_runtime_ssot_refresh_failures_total 2');
    expect(out).toContain('shizuha_reconcile_skipped_total{reason="mass-stop-circuit-breaker"} 1');
    expect(out).toContain('shizuha_reconcile_repair_failure_streak{agent="mio",action="refresh"} 2');
    expect(out).toContain('shizuha_reconcile_repair_next_retry_timestamp_seconds{agent="mio",action="refresh"} 1784210000');
    expect(out).toContain('shizuha_reconcile_repair_deferrals_total{action="refresh",reason="in_flight"} 1');
    expect(out).toContain('shizuha_reconcile_repair_deferrals_total{action="refresh",reason="backoff"} 1');

    clearReconcileRepairBackoff('mio', 'refresh');
    const cleared = await renderMetricsFromFiles([]);
    expect(cleared).toContain('shizuha_reconcile_repair_failure_streak{agent="mio",action="refresh"} 0');
    expect(cleared).toContain('shizuha_reconcile_repair_next_retry_timestamp_seconds{agent="mio",action="refresh"} 0');
  });
});

describe('PLAT-3170 k8s GitHub auth fail-loud metrics', () => {
  it('exports per-agent GitHub auth probe state with team/owner labels and bounded failure reason', async () => {
    const {
      recordK8sGithubAuthProbe,
      recordK8sGithubAuthAndonSendFailure,
      renderMetricsFromFiles,
    } = await import('../src/metrics/registry.js');

    recordK8sGithubAuthProbe([
      {
        username: 'revi',
        team: 'review',
        ownerGroup: 'review',
        ok: false,
        reason: 'github_api_failed',
        checkedAt: '2026-07-04T17:00:00.000Z',
      },
      {
        username: 'saki',
        team: 'engineering',
        ownerGroup: 'engineering',
        ok: true,
        reason: 'ok',
        checkedAt: '2026-07-04T17:00:10.000Z',
      },
    ]);
    recordK8sGithubAuthAndonSendFailure();

    const out = await renderMetricsFromFiles([]);

    expect(out).toContain('shizuha_k8s_github_auth_ok{agent="revi",team="review",owner_group="review"} 0');
    expect(out).toContain('shizuha_k8s_github_auth_failures_total{agent="revi",team="review",owner_group="review",reason="github_api_failed"} 1');
    expect(out).toContain('shizuha_k8s_github_auth_last_check_timestamp_seconds{agent="saki",team="engineering",owner_group="engineering"} 1783184410');
    expect(out).toContain('shizuha_k8s_github_auth_andon_failures_total 1');
  });
});

describe('PLAT-4006 account reconcile fail-loud metrics', () => {
  it('exports daemon-side account reconcile ANDON notifier outcomes', async () => {
    const {
      recordAgentAccountReconcileAndonOutcome,
      renderMetricsFromFiles,
    } = await import('../src/metrics/registry.js');

    recordAgentAccountReconcileAndonOutcome('sent');
    recordAgentAccountReconcileAndonOutcome('failed');
    recordAgentAccountReconcileAndonOutcome('rate_limited');

    const out = await renderMetricsFromFiles([]);

    expect(out).toContain('shizuha_agent_account_reconcile_andon_total{outcome="sent"} 1');
    expect(out).toContain('shizuha_agent_account_reconcile_andon_total{outcome="failed"} 1');
    expect(out).toContain('shizuha_agent_account_reconcile_andon_total{outcome="rate_limited"} 1');
  });
});

describe('PLAT-5335 runtime-roll deferral metric', () => {
  it('exports the persisted start timestamp and removes stale reason labels on change/clear', async () => {
    const {
      setRuntimeRollDeferralStartTimestamp,
      clearRuntimeRollDeferralStartTimestamp,
      renderMetricsFromFiles,
    } = await import('../src/metrics/registry.js');

    setRuntimeRollDeferralStartTimestamp('sara', 'bridge-busy', 'drain-v1', 1_800_000);
    let out = await renderMetricsFromFiles([]);
    expect(out).toContain(
      'shizuha_runtime_roll_deferral_start_timestamp_seconds{agent="sara",reason="bridge-busy",protocol="drain-v1"} 1800',
    );

    setRuntimeRollDeferralStartTimestamp('sara', 'probe-failed', 'unknown', 1_800_000);
    out = await renderMetricsFromFiles([]);
    expect(out).not.toContain('agent="sara",reason="bridge-busy"');
    expect(out).toContain(
      'shizuha_runtime_roll_deferral_start_timestamp_seconds{agent="sara",reason="probe-failed",protocol="unknown"} 1800',
    );

    clearRuntimeRollDeferralStartTimestamp('sara');
    out = await renderMetricsFromFiles([]);
    expect(out).not.toContain('shizuha_runtime_roll_deferral_start_timestamp_seconds{agent="sara"');
  });
});
