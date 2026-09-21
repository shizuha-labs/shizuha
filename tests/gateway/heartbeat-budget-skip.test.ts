import { afterEach, describe, expect, it } from 'vitest';

import { AgentProcess } from '../../src/gateway/agent-process.js';
import {
  HEARTBEAT_BUDGET_SKIP_LOG_PREFIX,
  clearHeartbeatBudgetSkipsForTests,
  formatHeartbeatBudgetSkipLogLine,
  getHeartbeatBudgetSkipCount,
  heartbeatBudgetSkipTelemetry,
  recordHeartbeatBudgetSkip,
} from '../../src/shared/heartbeat-budget-skip.js';
import { buildMetrics } from '../../src/metrics/health-server.js';

afterEach(() => clearHeartbeatBudgetSkipsForTests());

describe('PLAT-6187 heartbeat budget-skip signal', () => {
  it('records a cumulative per-agent skip count and formats the [heartbeat-budget-skip] log line', () => {
    const first = recordHeartbeatBudgetSkip('saki', 'queue_empty');
    expect(first.count).toBe(1);
    expect(first.reason).toBe('queue_empty');
    expect(first.agentId).toBe('saki');

    const second = recordHeartbeatBudgetSkip('saki', 'no_token');
    expect(second.count).toBe(2);
    expect(second.reason).toBe('no_token');

    // Other agents are independent.
    expect(getHeartbeatBudgetSkipCount('saki')).toBe(2);
    expect(getHeartbeatBudgetSkipCount('nagi')).toBe(0);

    const line = formatHeartbeatBudgetSkipLogLine(second);
    expect(line.startsWith(`${HEARTBEAT_BUDGET_SKIP_LOG_PREFIX} `)).toBe(true);
    const parsed = JSON.parse(line.slice(HEARTBEAT_BUDGET_SKIP_LOG_PREFIX.length).trim());
    expect(parsed).toMatchObject({ agentId: 'saki', count: 2, reason: 'no_token' });
  });

  it('projects the skip count into the agent telemetry envelope', () => {
    const agentId = 'gateway-hb-skip-telemetry';
    const agent = new AgentProcess({
      agentId,
      agentUsername: 'saki',
      channels: [],
      model: 'grok-4.5',
      cwd: '/tmp',
      permissionMode: 'autonomous',
    }) as unknown as { buildTelemetry: () => Record<string, any> };

    expect(agent.buildTelemetry().heartbeat).toBeNull();

    recordHeartbeatBudgetSkip(agentId, 'queue_empty');
    recordHeartbeatBudgetSkip(agentId, 'preflight_http_error');

    expect(agent.buildTelemetry().heartbeat).toMatchObject({
      heartbeat_budget_skips: 2,
    });
  });

  it('emits shizuha_agent_heartbeat_budget_skips in the health exporter only for agents with skips', () => {
    recordHeartbeatBudgetSkip('saki', 'queue_empty');
    const metrics = buildMetrics([
      { username: 'saki', enabled: true, running: true, capacityUnavailable: false },
      { username: 'nagi', enabled: true, running: true, capacityUnavailable: false },
    ]);
    expect(metrics).toContain('# HELP shizuha_agent_heartbeat_budget_skips');
    expect(metrics).toContain('shizuha_agent_heartbeat_budget_skips{agent="saki"} 1');
    expect(metrics).not.toContain('shizuha_agent_heartbeat_budget_skips{agent="nagi"}');
  });

  it('telemetry projection returns null when no skip has been recorded', () => {
    expect(heartbeatBudgetSkipTelemetry('nobody')).toBeNull();
  });
});
