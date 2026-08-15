import { afterEach, describe, expect, it } from 'vitest';

import { AgentProcess } from '../../src/gateway/agent-process.js';
import {
  clearHeartbeatQueueDrainOutcomesForTests,
  recordHeartbeatQueueDrainOutcome,
} from '../../src/daemon/heartbeat-outcome.js';

afterEach(() => clearHeartbeatQueueDrainOutcomesForTests());

describe('AgentProcess heartbeat telemetry', () => {
  it('projects a completed model/tool turn as fresh operator-visible activity', () => {
    const now = Date.now();
    const agent = new AgentProcess({
      agentId: 'gateway-turn-activity',
      agentUsername: 'nagi',
      channels: [],
      model: 'grok-4.5',
      cwd: '/tmp',
      permissionMode: 'autonomous',
    }) as unknown as {
      buildTelemetry: () => Record<string, any>;
      lastActivityAt: number;
      touchActivity: () => void;
    };
    agent.lastActivityAt = now - 30 * 60_000;

    agent.touchActivity();

    expect(agent.buildTelemetry().activity.last_activity_ms_ago).toBeLessThan(1_000);
  });

  it('publishes a sustained ready/no-progress outcome over Connect telemetry', () => {
    const agentId = 'gateway-heartbeat-telemetry';
    const agent = new AgentProcess({
      agentId,
      agentUsername: 'kumo',
      channels: [],
      model: 'grok-4.5',
      cwd: '/tmp',
      permissionMode: 'autonomous',
    }) as unknown as { buildTelemetry: () => Record<string, any> };
    recordHeartbeatQueueDrainOutcome(agentId, {
      readyTaskCount: 2,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 1,
      observedAt: '2026-07-16T22:40:00.000Z',
    });

    expect(agent.buildTelemetry().heartbeat).toMatchObject({
      outcome: 'needs_help',
      needs_help: true,
      ready_task_count: 2,
      pulse_get_my_tasks_only: true,
      observed_at: '2026-07-16T22:40:00.000Z',
    });
  });
});
