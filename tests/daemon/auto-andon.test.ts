import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  AUTO_ANDON_RATE_LIMIT_MS,
  AUTO_ANDON_STREAK_WINDOW_MS,
  clearAutoAndonRateLimit,
  getAutoAndonMetricsSnapshot,
  recordAutoAndonFired,
  recordAutoAndonSendFailed,
  observeAutoAndonLine,
  resetAutoAndonStateForTests,
  resolveClusterManagerUsername,
  sendAutoAndonToClusterManager,
} from '../../src/daemon/auto-andon.js';

vi.mock('../../src/platform/connect-dm.js', () => ({
  sendConnectDm: vi.fn(async () => ({ ok: true, messageId: 'm1' })),
}));

import { sendConnectDm } from '../../src/platform/connect-dm.js';

describe('PLAT-1242 auto-andon bridge thrash detector', () => {
  beforeEach(() => {
    resetAutoAndonStateForTests();
    vi.clearAllMocks();
  });

  it('routes teams to the configured cluster manager table', () => {
    expect(resolveClusterManagerUsername('engineering')).toBe('aoi');
    expect(resolveClusterManagerUsername('devops')).toBe('ichi');
    expect(resolveClusterManagerUsername('documentation')).toBe('sora');
    expect(resolveClusterManagerUsername('research-analytics')).toBe('sora');
    expect(resolveClusterManagerUsername('trading-engineering')).toBe('banto');
    expect(resolveClusterManagerUsername('unknown')).toBe('aoi');
  });

  it('signals a sustained empty-turn streak once and rate-limits the same obstacle for 6h', () => {
    const agentId = 'agent-empty';
    expect(observeAutoAndonLine(agentId, '[codex-bridge] Empty turn #1 (model=o3)', 'stdout', 1_000)).toBeNull();
    expect(observeAutoAndonLine(agentId, '[codex-bridge] Empty turn #2 (model=o3)', 'stdout', 2_000)).toBeNull();

    const first = observeAutoAndonLine(agentId, '[codex-bridge] Empty turn #3 (model=o3)', 'stdout', 3_000);
    expect(first).toMatchObject({ pattern: 'empty-turn-streak', count: 3 });

    expect(observeAutoAndonLine(agentId, '[codex-bridge] Empty turn #4 (model=o3)', 'stdout', 4_000)).toBeNull();

    const afterLimit = observeAutoAndonLine(
      agentId,
      '[codex-bridge] Empty turn #5 (model=o3)',
      'stdout',
      3_000 + AUTO_ANDON_RATE_LIMIT_MS + 1,
    );
    expect(afterLimit).toMatchObject({ pattern: 'empty-turn-streak', count: 5 });
  });

  it('signals repeated same stderr errors', () => {
    const agentId = 'agent-error';
    const line = 'Error: Failed to run pre-sampling compact: input too large 12345';

    expect(observeAutoAndonLine(agentId, line, 'stderr', 1)).toBeNull();
    expect(observeAutoAndonLine(agentId, line, 'stderr', 2)).toBeNull();
    expect(observeAutoAndonLine(agentId, line.replace('12345', '67890'), 'stderr', 3)).toMatchObject({
      pattern: 'same-error-streak',
      count: 3,
    });
  });

  it('signals repeated identical failing tool calls', () => {
    const agentId = 'agent-tool';
    const line = '[codex-rpc] item/completed item.type=mcpToolCall server=shizuha-pulse tool=pulse_get_my_tasks status=failed durationMs=22';

    expect(observeAutoAndonLine(agentId, line, 'stdout', 1)).toBeNull();
    expect(observeAutoAndonLine(agentId, line, 'stdout', 2)).toBeNull();
    expect(observeAutoAndonLine(agentId, line, 'stdout', 3)).toMatchObject({
      pattern: 'identical-failing-tool-call',
      count: 3,
    });
  });



  it('resets same-error and tool streaks outside the consecutive time window', () => {
    const errAgent = 'agent-error-window';
    const line = 'Error: Failed to run pre-sampling compact: input too large 12345';

    expect(observeAutoAndonLine(errAgent, line, 'stderr', 1_000)).toBeNull();
    expect(observeAutoAndonLine(errAgent, line, 'stderr', 2_000)).toBeNull();
    expect(observeAutoAndonLine(errAgent, line, 'stderr', 2_000 + AUTO_ANDON_STREAK_WINDOW_MS + 1)).toBeNull();
    expect(observeAutoAndonLine(errAgent, line, 'stderr', 2_000 + AUTO_ANDON_STREAK_WINDOW_MS + 2_000)).toBeNull();
    expect(observeAutoAndonLine(errAgent, line, 'stderr', 2_000 + AUTO_ANDON_STREAK_WINDOW_MS + 3_000)).toMatchObject({
      pattern: 'same-error-streak',
      count: 3,
    });

    resetAutoAndonStateForTests();
    const toolAgent = 'agent-tool-window';
    const tool = '[codex-rpc] item/completed item.type=mcpToolCall server=shizuha-pulse tool=pulse_get_my_tasks status=failed durationMs=22';
    expect(observeAutoAndonLine(toolAgent, tool, 'stdout', 1_000)).toBeNull();
    expect(observeAutoAndonLine(toolAgent, tool, 'stdout', 2_000)).toBeNull();
    expect(observeAutoAndonLine(toolAgent, tool, 'stdout', 2_000 + AUTO_ANDON_STREAK_WINDOW_MS + 1)).toBeNull();
    expect(observeAutoAndonLine(toolAgent, tool, 'stdout', 2_000 + AUTO_ANDON_STREAK_WINDOW_MS + 2_000)).toBeNull();
    expect(observeAutoAndonLine(toolAgent, tool, 'stdout', 2_000 + AUTO_ANDON_STREAK_WINDOW_MS + 3_000)).toMatchObject({
      pattern: 'identical-failing-tool-call',
      count: 3,
    });
  });

  it('can clear a consumed rate-limit window after send failure and exposes liveness counters', () => {
    const agentId = 'agent-rate-clear';
    const line = 'Error: Failed to run pre-sampling compact: input too large 12345';
    observeAutoAndonLine(agentId, line, 'stderr', 1_000);
    observeAutoAndonLine(agentId, line, 'stderr', 2_000);
    const first = observeAutoAndonLine(agentId, line, 'stderr', 3_000);
    expect(first).toMatchObject({ pattern: 'same-error-streak' });

    expect(observeAutoAndonLine(agentId, line, 'stderr', 4_000)).toBeNull();
    expect(getAutoAndonMetricsSnapshot().rateLimitedTotal).toBe(1);

    clearAutoAndonRateLimit(agentId, first!);
    expect(observeAutoAndonLine(agentId, line, 'stderr', 5_000)).toMatchObject({ pattern: 'same-error-streak' });

    recordAutoAndonFired();
    recordAutoAndonSendFailed();
    expect(getAutoAndonMetricsSnapshot()).toMatchObject({
      firedTotal: 1,
      sendFailedTotal: 1,
      rateLimitedTotal: 1,
    });
  });

  it('DMs the detected agent cluster manager with sender credentials and context', async () => {
    await sendAutoAndonToClusterManager({
      agent: {
        id: 'sara-id',
        name: 'Sara',
        username: 'sara',
        email: 'sara@agents.shizuha.io',
        team: 'engineering',
        enabled: true,
      } as any,
      config: { agents: [], platformUrl: 'http://platform.test' } as any,
      senderPassword: 'agent-password',
      signal: {
        pattern: 'same-error-streak',
        signature: 'Error: boom',
        count: 3,
        detail: '3 repeated stderr errors',
        excerpt: 'Error: boom',
      },
    });

    expect(sendConnectDm).toHaveBeenCalledWith(expect.objectContaining({
      recipientUsername: 'aoi',
      platformUrl: 'http://platform.test',
      senderPassword: 'agent-password',
      sender: expect.objectContaining({ username: 'sara', isAgent: true }),
      content: expect.stringContaining('AUTO-ANDON'),
    }));
  });
});
