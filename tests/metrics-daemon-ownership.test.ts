import { describe, expect, it, vi } from 'vitest';

/**
 * PLAT-5758: daemon-owned metric families must only register when the daemon
 * module is imported — never when an agent/gateway process imports the shared
 * agent-side registry. Each test uses a fresh module graph (vi.resetModules)
 * so the shared metricsRegistry is re-created per scenario.
 */
describe('PLAT-5758 daemon-owned metrics ownership split', () => {
  it('agent-side registry import registers ZERO daemon-owned families', async () => {
    vi.resetModules();
    const { metricsRegistry } = await import('../src/metrics/registry.js');
    const names = metricsRegistry.getMetricsAsArray().map((m) => m.name);

    expect(names.some((n) => n.startsWith('shizuha_reconcile_'))).toBe(false);
    expect(names.some((n) => n.startsWith('shizuha_k8s_github_auth_'))).toBe(false);
    expect(names.some((n) => n.startsWith('shizuha_runtime_roll_deferral_'))).toBe(false);
    expect(names.some((n) => n.startsWith('shizuha_agent_account_reconcile_'))).toBe(false);
    expect(names.some((n) => n === 'shizuha_agent_identity_ok')).toBe(false);
  });

  it('daemon module registers the reconcile family so the daemon target still emits it', async () => {
    vi.resetModules();
    const { metricsRegistry } = await import('../src/metrics/registry.js');
    await import('../src/metrics/daemon.js');
    const names = metricsRegistry.getMetricsAsArray().map((m) => m.name);

    expect(names).toContain('shizuha_reconcile_cycles_total');
    expect(names).toContain('shizuha_reconcile_runtime_ssot_refresh_ok');
    expect(names).toContain('shizuha_reconcile_last_run_timestamp_seconds');
    expect(names).toContain('shizuha_k8s_github_auth_ok');
  });
});
