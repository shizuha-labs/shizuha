import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMetrics, type AgentHealthInfo } from '../src/metrics/health-server.js';
import type { TurnTelemetryRecord } from '../src/telemetry/turn-telemetry.js';

function record(overrides: Partial<TurnTelemetryRecord>): TurnTelemetryRecord {
  return {
    runId: 'run-1',
    agent: 'reika',
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

function agent(username: string): AgentHealthInfo {
  return { username, enabled: true, running: true, capacityUnavailable: false };
}

describe('SCLI-198 agent health exporter efficiency telemetry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports calls/min, prompt:output ratio, and loop guard hits from current-run turn telemetry', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-198-health-home-'));
    vi.stubEnv('HOME', home);
    const dir = path.join(home, '.shizuha', 'claude-sessions', 'reika');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'turn-telemetry.jsonl'), [
      record({ runId: 'old-run', agent: 'reika', turnIndex: 0, ts: 1, inputTokens: 999_999, outputTokens: 1, loopGuardHits: 99 }),
      record({ runId: 'run-1', agent: 'reika', turnIndex: 0, ts: 0, inputTokens: 120_000, outputTokens: 100, loopGuardHits: 0 }),
      record({ runId: 'run-1', agent: 'reika', turnIndex: 1, ts: 60_000, inputTokens: 130_000, outputTokens: 100, loopGuardHits: 2 }),
      record({ runId: 'run-1', agent: 'reika', turnIndex: 2, ts: 120_000, inputTokens: 140_000, outputTokens: 100, loopGuardHits: 3 }),
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const metrics = buildMetrics([agent('reika')]);

    expect(metrics).toContain('shizuha_agent_calls_per_minute{agent="reika",run_id="run-1",model="deepseek-v4-flash"} 1.5');
    expect(metrics).toContain('shizuha_agent_prompt_output_ratio{agent="reika",run_id="run-1",model="deepseek-v4-flash"} 1300');
    expect(metrics).toContain('shizuha_agent_loop_guard_hits{agent="reika",run_id="run-1",model="deepseek-v4-flash"} 5');
    expect(metrics).not.toContain('old-run');
    expect(metrics).not.toContain('999999');
  });

  it('does not emit per-agent efficiency samples when telemetry is absent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-198-health-empty-'));
    vi.stubEnv('HOME', home);

    const metrics = buildMetrics([agent('quiet')]);

    expect(metrics).toContain('# HELP shizuha_agent_calls_per_minute');
    expect(metrics).not.toContain('shizuha_agent_calls_per_minute{agent="quiet"');
    expect(metrics).not.toContain('shizuha_agent_prompt_output_ratio{agent="quiet"');
    expect(metrics).not.toContain('shizuha_agent_loop_guard_hits{agent="quiet"');
  });
});

describe('agent lifecycle snapshot event time', () => {
  it('exports exactly one positive observation timestamp per scrape', () => {
    const metrics = buildMetrics([agent('kane')]);
    const samples = metrics
      .split('\n')
      .filter((line) => line.startsWith('shizuha_agent_enabled_snapshot_timestamp_seconds '));

    expect(samples).toHaveLength(1);
    expect(Number(samples[0]!.split(' ')[1])).toBeGreaterThan(0);
  });
});

describe('PLAT-3367 exporter startup is single-owner/idempotent', () => {
  const TEST_PORT = 19888;

  afterEach(async () => {
    const { stopAgentHealthServer } = await import('../src/metrics/health-server.js');
    await stopAgentHealthServer(TEST_PORT).catch(() => {});
  });

  it('second start on the same port returns the SAME server (no EADDRINUSE)', async () => {
    const { startAgentHealthServer } = await import('../src/metrics/health-server.js');
    const first = startAgentHealthServer(() => [], TEST_PORT);
    const second = startAgentHealthServer(() => [], TEST_PORT);
    expect(second).toBe(first);
  });

  it('first caller keeps serving scrapes; duplicate caller does not replace it', async () => {
    const { startAgentHealthServer } = await import('../src/metrics/health-server.js');
    const agents: AgentHealthInfo[] = [
      { username: 'jun', enabled: true, running: true, capacityUnavailable: false },
    ];
    startAgentHealthServer(() => agents, TEST_PORT);
    // Duplicate registration (the dashboard/manager double-start scenario).
    startAgentHealthServer(() => {
      throw new Error('duplicate callback must never be invoked');
    }, TEST_PORT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/metrics`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('shizuha_agent_process_up{agent="jun"} 1');
  });

  it('stop then start creates a fresh server on the same port', async () => {
    const { startAgentHealthServer, stopAgentHealthServer } = await import(
      '../src/metrics/health-server.js'
    );
    const first = startAgentHealthServer(() => [], TEST_PORT);
    await new Promise((resolve) => first.once('listening', resolve));
    await stopAgentHealthServer(TEST_PORT);
    const second = startAgentHealthServer(() => [], TEST_PORT);
    expect(second).not.toBe(first);
  });
});
