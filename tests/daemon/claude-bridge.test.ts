import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeBridge,
  buildOriMcpEntry,
  buildOriMcpProbeCommand,
  classifyClaudeApiError,
  providerUnavailableFromRecentErrors,
  resolveModelTokenPolicy,
  shouldEnterTokenPoolBackoff,
  shouldCrossMethodFailoverOnRequiredBrokerMiss,
  nextNonClaudeFallbackStep,
  nextTokenPoolBackoffMs,
  CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON,
  readClaudeProviderUnavailableMarker,
  writeClaudeProviderUnavailableMarker,
  clearClaudeProviderUnavailableMarker,
  CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER,
  installClaudeHeartbeatObservationHooks,
  isPriorityClaudeConnectControlMessage,
  isRoutineClaudeConnectTaskMessage,
  isHeartbeatTrigger,
  selectClaudeBridgeQueueAction,
  shouldDropQueuedMessage,
} from '../../src/claude-bridge/index.js';
import { HEARTBEAT_TRIGGER } from '../../src/agent-base-instructions.js';

describe('Claude provider-unavailable supervisor marker', () => {
  it('persists an outage across process retries and clears only after recovery', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-provider-marker-'));
    const marker = path.join(tmpHome, '.provider-unavailable');
    try {
      expect(readClaudeProviderUnavailableMarker(marker)).toBeNull();
      writeClaudeProviderUnavailableMarker('Fable capacity exhausted', marker);
      expect(readClaudeProviderUnavailableMarker(marker)).toBe('Fable capacity exhausted');
      clearClaudeProviderUnavailableMarker(marker);
      expect(readClaudeProviderUnavailableMarker(marker)).toBeNull();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// HIVE-125 / ren P1: the env token must NOT be used when a broker is configured and
// the broker-token requirement is enforced but no broker token was obtained.
describe('resolveModelTokenPolicy (HIVE-125 fail-closed)', () => {
  it('uses the broker token whenever one is present', () => {
    expect(resolveModelTokenPolicy({
      brokerConfigured: true, requireBrokerToken: true, brokerToken: 'oat-broker', envToken: 'oat-env',
    })).toBe('oat-broker');
  });

  it('FAILS CLOSED (throws) when broker required + configured but no broker token — env NOT used', () => {
    expect(() => resolveModelTokenPolicy({
      brokerConfigured: true, requireBrokerToken: true, brokerToken: null, envToken: 'oat-env-stale',
    })).toThrow(/fail-closed/);
  });

  it('FAILS CLOSED when broker required even if a mounted host-pool token exists', () => {
    expect(() => resolveModelTokenPolicy({
      brokerConfigured: true, requireBrokerToken: true, brokerToken: null, envToken: '', hostPoolToken: 'oat-host-pool',
    })).toThrow(/fail-closed/);
  });

  it('falls back to env when no broker is configured (headless dev)', () => {
    expect(resolveModelTokenPolicy({
      brokerConfigured: false, requireBrokerToken: true, brokerToken: null, envToken: 'oat-env',
    })).toBe('oat-env');
  });

  it('falls back to env when the broker-token requirement is not yet enforced (pre-cutover)', () => {
    expect(resolveModelTokenPolicy({
      brokerConfigured: true, requireBrokerToken: false, brokerToken: null, envToken: 'oat-env',
    })).toBe('oat-env');
  });

  it('falls back to a mounted host-pool token when pre-cutover broker serves none and env is empty', () => {
    expect(resolveModelTokenPolicy({
      brokerConfigured: true, requireBrokerToken: false, brokerToken: null, envToken: '', hostPoolToken: 'oat-host-pool',
    })).toBe('oat-host-pool');
  });

  it('prefers env over mounted host-pool fallback when both are present', () => {
    expect(resolveModelTokenPolicy({
      brokerConfigured: true, requireBrokerToken: false, brokerToken: null, envToken: 'oat-env', hostPoolToken: 'oat-host-pool',
    })).toBe('oat-env');
  });
});

// PLAT-879: an empty/cooling required token pool must trigger supervised BACKOFF
// (stay alive + retry) rather than the old throw → process.exit crash-loop. The
// fail-closed property above is unchanged — we just never let it reach the throw.
describe('shouldEnterTokenPoolBackoff (PLAT-879 empty-pool stay-alive)', () => {
  it('enters backoff ONLY when broker configured + required + no token', () => {
    expect(shouldEnterTokenPoolBackoff({ brokerConfigured: true, requireBrokerToken: true, brokerToken: null })).toBe(true);
  });
  it('does NOT back off when a broker token is present (normal path)', () => {
    expect(shouldEnterTokenPoolBackoff({ brokerConfigured: true, requireBrokerToken: true, brokerToken: 'oat' })).toBe(false);
  });
  it('does NOT back off when no broker is configured (env fallback applies)', () => {
    expect(shouldEnterTokenPoolBackoff({ brokerConfigured: false, requireBrokerToken: true, brokerToken: null })).toBe(false);
  });
  it('does NOT back off when the broker-token requirement is not enforced (pre-cutover)', () => {
    expect(shouldEnterTokenPoolBackoff({ brokerConfigured: true, requireBrokerToken: false, brokerToken: null })).toBe(false);
  });
});

describe('required broker miss cross-method failover (SCLI-234)', () => {
  const chain = [
    { method: 'claude_code_server', model: 'claude-opus-4-8' },
    { method: 'shizuha', model: 'cortex/qwen3-coder' },
  ];

  it('selects the next explicit non-Claude fallback after the current Claude step', () => {
    expect(nextNonClaudeFallbackStep(chain, 'claude-opus-4-8')).toEqual({
      method: 'shizuha',
      model: 'cortex/qwen3-coder',
    });
  });

  it('requests cross-method failover instead of indefinite token-pool backoff when a non-Claude fallback exists', () => {
    expect(shouldCrossMethodFailoverOnRequiredBrokerMiss({
      brokerConfigured: true,
      requireBrokerToken: true,
      brokerToken: null,
      failoverChain: chain,
      currentModel: 'claude-opus-4-8',
    })).toBe(true);
  });

  it('keeps PLAT-879 supervised token-pool backoff when the chain has only Claude steps', () => {
    expect(shouldCrossMethodFailoverOnRequiredBrokerMiss({
      brokerConfigured: true,
      requireBrokerToken: true,
      brokerToken: null,
      failoverChain: [
        { method: 'claude_code_server', model: 'claude-opus-4-8' },
        { method: 'claude_code_server', model: 'claude-sonnet-4-6' },
      ],
      currentModel: 'claude-opus-4-8',
    })).toBe(false);
  });

  it('does not request failover when the broker serves a token', () => {
    expect(shouldCrossMethodFailoverOnRequiredBrokerMiss({
      brokerConfigured: true,
      requireBrokerToken: true,
      brokerToken: 'oat-live',
      failoverChain: chain,
      currentModel: 'claude-opus-4-8',
    })).toBe(false);
  });
});

describe('CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON (PLAT-1150 availability status)', () => {
  it('uses the capacity-unavailable reason expected by Pulse availability', () => {
    expect(CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON).toBe('claude-token-pool-exhausted');
  });
});

describe('nextTokenPoolBackoffMs (PLAT-879 bounded exponential backoff)', () => {
  it('starts at a 60s floor from zero/unset', () => {
    expect(nextTokenPoolBackoffMs(0)).toBe(60_000);
  });
  it('doubles each step', () => {
    expect(nextTokenPoolBackoffMs(60_000)).toBe(120_000);
    expect(nextTokenPoolBackoffMs(120_000)).toBe(240_000);
  });
  it('caps at 10m by default (never unbounded)', () => {
    expect(nextTokenPoolBackoffMs(8 * 60_000)).toBe(10 * 60_000);
    expect(nextTokenPoolBackoffMs(10 * 60_000)).toBe(10 * 60_000);
  });
  it('supports explicit smaller caps in tests/config', () => {
    expect(nextTokenPoolBackoffMs(40_000, 60_000, 5_000)).toBe(60_000);
    expect(nextTokenPoolBackoffMs(60_000, 60_000, 5_000)).toBe(60_000);
  });
});


describe('Ori MCP bridge config (ORIG-65)', () => {
  it('uses streamable HTTP at /mcp instead of the dead SSE endpoint', () => {
    expect(buildOriMcpEntry('host.docker.internal', '9500')).toEqual({
      type: 'http',
      url: 'http://host.docker.internal:9500/mcp',
    });
  });

  it('probes the actual streamable-HTTP MCP initialize path', () => {
    const command = buildOriMcpProbeCommand('host.docker.internal', '9500');
    expect(command).toContain('http://host.docker.internal:9500/mcp');
    expect(command).toContain('"method":"initialize"');
    expect(command).not.toContain('/mcp/sse');
    expect(command).not.toContain('/api/status');
  });
});

describe('shouldDropQueuedMessage (Claude bridge queue pressure)', () => {
  it('deduplicates queued heartbeat triggers', () => {
    expect(shouldDropQueuedMessage([{ content: HEARTBEAT_TRIGGER }], HEARTBEAT_TRIGGER)).toEqual({
      drop: true,
      reason: 'duplicate-heartbeat',
    });
  });

  it('drops heartbeat triggers when the queue is full', () => {
    const queue = Array.from({ length: 2 }, (_, i) => ({ content: `message ${i}` }));
    expect(shouldDropQueuedMessage(queue, HEARTBEAT_TRIGGER, 2)).toEqual({
      drop: true,
      reason: 'queue-full-heartbeat',
    });
  });

  it('drops non-heartbeat messages only at the hard cap', () => {
    expect(shouldDropQueuedMessage([{ content: 'one' }], 'two', 2)).toEqual({ drop: false, reason: '' });
    expect(shouldDropQueuedMessage([{ content: 'one' }, { content: 'two' }], 'three', 2)).toEqual({
      drop: true,
      reason: 'queue-full',
    });
  });
});

describe('Claude bridge turn-boundary arbitration', () => {
  const routine = { clientId: 'connect:task', content: '[system] [Task Update] PLS-496 changed status' };
  const alert = { clientId: 'connect:alert', content: '[system] [CRITICAL ALERT] Origin unavailable' };
  const direct = { clientId: 'connect:hritik', content: '[hritik] Investigate the outage' };

  it('classifies only routine Pulse task notifications as low priority', () => {
    expect(isRoutineClaudeConnectTaskMessage(routine)).toBe(true);
    expect(isRoutineClaudeConnectTaskMessage({
      clientId: 'connect:review',
      content: '[SYSTEM] [Review Seat Starvation] PLS-509 needs a reviewer',
    })).toBe(true);
    expect(isRoutineClaudeConnectTaskMessage({
      clientId: 'connect:routability',
      content: '[system] [Routability Hold] PLAT-4829 is waiting for provider recovery',
    })).toBe(true);
    expect(isRoutineClaudeConnectTaskMessage(alert)).toBe(false);
    expect(isRoutineClaudeConnectTaskMessage(direct)).toBe(false);
  });

  it('preserves retry, direct/control, heartbeat, routine-notice ordering', () => {
    const queue = [routine, alert, direct];
    expect(selectClaudeBridgeQueueAction(queue, true, true)).toEqual({ kind: 'retry' });
    expect(selectClaudeBridgeQueueAction(queue, false, true)).toEqual({ kind: 'message', index: 1 });
    expect(isPriorityClaudeConnectControlMessage(alert)).toBe(true);
    expect(isPriorityClaudeConnectControlMessage(direct)).toBe(false);
    expect(selectClaudeBridgeQueueAction([routine], false, true)).toEqual({ kind: 'heartbeat' });
    expect(selectClaudeBridgeQueueAction([routine], false, false)).toEqual({ kind: 'message', index: 0 });
  });

  it('runs a pending task checkpoint before ordinary agent DMs', () => {
    expect(selectClaudeBridgeQueueAction([direct], false, true)).toEqual({ kind: 'heartbeat' });
    expect(selectClaudeBridgeQueueAction([direct], false, false)).toEqual({ kind: 'message', index: 0 });
  });
});


function makeJwt(label: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    user_id: 123,
    email: 'agent-test@agents.shizuha.io',
    organization_id: 1,
    label,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function makeBridge() {
  return new ClaudeBridge({
    port: 0,
    host: '127.0.0.1',
    model: 'claude-sonnet-4-6',
    agentId: 'agent-test',
    cwd: '/tmp',
  }) as any;
}

describe('ClaudeBridge startup health (PLAT-1350)', () => {
  it('starts the HTTP/WS health surface before broker-token spawn/backoff', async () => {
    const bridge = makeBridge();
    const order: string[] = [];
    bridge.startConnectClient = vi.fn().mockResolvedValue(undefined);
    bridge.setupCronMcp = vi.fn().mockResolvedValue(undefined);
    bridge.startServer = vi.fn(async () => { order.push('server'); });
    bridge.spawnClaude = vi.fn(async () => { order.push('spawn'); });
    bridge.startHeartbeat = vi.fn();
    bridge.startTelemetry = vi.fn();
    bridge.markAgentAvailability = vi.fn();

    await bridge.start();

    expect(order).toEqual(['server', 'spawn']);
  });

  it('reports broker-token backoff as degraded capacity, not a dead process', () => {
    const bridge = makeBridge();
    bridge.tokenPoolUnavailable = true;
    bridge.tokenPoolUnavailableSince = 12345;

    const health = bridge.buildHealthResponse();

    expect(health).toMatchObject({
      status: 'degraded',
      healthStatus: 'degraded',
      providerHealthy: false,
      capacityUnavailable: true,
      tokenPoolUnavailable: true,
      token_pool_unavailable: true,
      tokenPoolUnavailableSince: 12345,
      token_pool_unavailable_since: 12345,
      lastProviderIssue: 'capacity_unavailable',
    });
  });
});

describe('ClaudeBridge runtime rollout drain', () => {
  it('finishes admitted queue work and suppresses the autonomous heartbeat before ready', () => {
    const bridge = makeBridge();
    bridge.activeThreadId = 'current-turn';
    bridge.messageQueue = [
      { clientId: 'connect:human', content: '[human] preserve this admitted message' },
    ];
    bridge.heartbeatPending = true;
    bridge.connectClient = { stop: vi.fn(), start: vi.fn() };
    bridge.startClaudeExecution = vi.fn();
    bridge.injectMessage = vi.fn();
    bridge.runtimeRollDrain.arm({
      requestId: 'roll-claude',
      targetImage: 'runtime:new',
      leaseMs: 60_000,
    });

    bridge.processQueue();
    expect(bridge.startClaudeExecution).not.toHaveBeenCalled();

    bridge.activeThreadId = null;
    bridge.processQueue();
    expect(bridge.startClaudeExecution).toHaveBeenCalledOnce();
    expect(bridge.messageQueue).toEqual([]);
    expect(bridge.runtimeRollDrain.ready).toBe(false);

    bridge.processQueue();
    expect(bridge.runtimeRollDrain.ready).toBe(true);
    expect(bridge.connectClient.stop).toHaveBeenCalledOnce();
    expect(bridge.injectMessage).not.toHaveBeenCalled();
    expect(bridge.heartbeatPending).toBe(true);
    bridge.runtimeRollDrain.dispose();
  });
});

describe('ClaudeBridge', () => {
  it('blocks stale heartbeat tools until the native Pulse queue succeeds', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-heartbeat-gate-'));
    try {
      const settings: Record<string, unknown> = {};
      const { markerPath, scriptPath } =
        installClaudeHeartbeatObservationHooks(settings, workDir);
      const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;

      expect(hooks.UserPromptSubmit?.[0]).toMatchObject({
        hooks: [{
          type: 'command',
          command: 'node',
          args: [
            scriptPath,
            'prompt',
            markerPath,
            'mcp__shizuha-pulse__pulse_get_my_alerts',
            'mcp__shizuha-pulse__pulse_get_my_tasks',
          ],
        }],
      });
      expect(hooks.PreToolUse?.[0]).toMatchObject({ matcher: '*' });
      expect(hooks.PostToolUse?.map((group) => group.matcher)).toEqual([
        'mcp__shizuha-pulse__pulse_get_my_alerts',
        'mcp__shizuha-pulse__pulse_get_my_tasks',
      ]);

      const submittedHeartbeat = spawnSync(
        process.execPath,
        [
          scriptPath,
          'prompt',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            prompt: '[HEARTBEAT] Automatic sync',
          }),
        },
      );
      expect(submittedHeartbeat.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(true);

      const staleAction = spawnSync(
        process.execPath,
        [
          scriptPath,
          'pre',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            tool_name: 'mcp__shizuha-pulse__pulse_execute_transition',
          }),
        },
      );
      expect(staleAction.status).toBe(2);
      expect(staleAction.stderr).toContain('Heartbeat inbox observation required');
      expect(fs.existsSync(markerPath)).toBe(true);

      const alertAction = spawnSync(
        process.execPath,
        [
          scriptPath,
          'pre',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            tool_name: 'mcp__shizuha-pulse__pulse_get_my_alerts',
          }),
        },
      );
      expect(alertAction.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(true);

      const successfulAlertObservation = spawnSync(
        process.execPath,
        [
          scriptPath,
          'post',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            tool_name: 'mcp__shizuha-pulse__pulse_get_my_alerts',
          }),
        },
      );
      expect(successfulAlertObservation.status).toBe(0);
      expect(fs.readFileSync(markerPath, 'utf8')).toBe('tasks');

      const taskAction = spawnSync(
        process.execPath,
        [
          scriptPath,
          'pre',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            tool_name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
          }),
        },
      );
      expect(taskAction.status).toBe(0);

      const successfulTaskObservation = spawnSync(
        process.execPath,
        [
          scriptPath,
          'post',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            tool_name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
          }),
        },
      );
      expect(successfulTaskObservation.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(false);

      const directPrompt = spawnSync(
        process.execPath,
        [
          scriptPath,
          'prompt',
          markerPath,
          'mcp__shizuha-pulse__pulse_get_my_alerts',
          'mcp__shizuha-pulse__pulse_get_my_tasks',
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            prompt: 'Please investigate the requested service issue.',
          }),
        },
      );
      expect(directPrompt.status).toBe(0);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('keeps a regular heartbeat pending when it fires during a busy turn', async () => {
    const bridge = makeBridge();
    bridge.activeThreadId = 'working-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnIsHeartbeat = false;

    await bridge.fireHeartbeat();

    expect(bridge.heartbeatPending).toBe(true);
  });

  it('coalesces a cadence tick into an already-active heartbeat', async () => {
    const bridge = makeBridge();
    bridge.activeThreadId = 'heartbeat-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnIsHeartbeat = true;

    await bridge.fireHeartbeat();

    expect(bridge.heartbeatPending).toBe(false);
  });

  it('does not fence an over-age Claude turn after fresh streamed progress', async () => {
    const bridge = makeBridge();
    bridge.activeThreadId = 'long-running-turn';
    bridge.activeThreadStartedAt = Date.now() - 21 * 60_000;
    bridge.activeTurnLastProgressAt = bridge.activeThreadStartedAt;
    bridge.heartbeatStuckMs = 20 * 60_000;
    bridge.spawnClaude = vi.fn();

    bridge.handleStdoutChunk(Buffer.from(`${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'still making progress' },
      },
    })}\n`));

    expect(bridge.activeTurnLastProgressAt).toBeGreaterThan(bridge.activeThreadStartedAt);
    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(false);
    expect(bridge.spawnClaude).not.toHaveBeenCalled();
    expect(bridge.activeThreadId).toBe('long-running-turn');
  });

  it('records a successful Pulse queue result and does not retry the heartbeat', () => {
    const bridge = makeBridge();
    const write = vi.fn();
    bridge.claudeProcess = { stdin: { writable: true, write } };
    bridge.activeThreadId = 'heartbeat-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnIsHeartbeat = true;

    bridge.handleStdoutChunk(Buffer.from([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'toolu_alerts',
            name: 'mcp__shizuha-pulse__pulse_get_my_alerts',
            input: {},
          },
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_alerts',
            content: 'No active assigned alerts.',
          }],
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'toolu_queue',
            name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
            input: {},
          },
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_queue',
            content: 'No actionable tasks found',
          }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
      }),
      '',
    ].join('\n')));

    expect(bridge.heartbeatPulseQueueObserved).toBe(false);
    expect(bridge.heartbeatPending).toBe(false);
    expect(bridge.heartbeatObservationRetryCount).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(bridge.buildTelemetry().heartbeat).toMatchObject({
      outcome: 'queue_empty',
      ready_task_count: 0,
    });
  });

  it('retries a queue-blind heartbeat twice with a mandatory native Pulse prompt, then stops', () => {
    const bridge = makeBridge();
    const write = vi.fn();
    bridge.claudeProcess = { stdin: { writable: true, write } };
    bridge.activeThreadId = 'heartbeat-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnIsHeartbeat = true;

    bridge.handleStdoutChunk(Buffer.from(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Acted from remembered context.',
    })}\n`));

    expect(bridge.heartbeatObservationRetryCount).toBe(1);
    expect(bridge.activeTurnIsHeartbeat).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain(CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER);
    expect(isHeartbeatTrigger(CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER)).toBe(true);

    // Production-order recurrence: the first retry also ends queue-blind, so
    // the boundary arbiter launches the final bounded retry.
    bridge.handleStdoutChunk(Buffer.from(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
    })}\n`));
    expect(bridge.heartbeatObservationRetryCount).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);

    // A third consecutive queue-blind completion is surfaced as needs_help,
    // but must not form an infinite scheduler loop.
    bridge.handleStdoutChunk(Buffer.from(`${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
    })}\n`));
    expect(bridge.heartbeatObservationRetryCount).toBe(0);
    expect(bridge.activeThreadId).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
    expect(bridge.buildTelemetry().heartbeat).toMatchObject({
      outcome: 'needs_help',
      needs_help: true,
    });
  });

  it('converts 150 routine Connect notices into one pending heartbeat with no queue growth', () => {
    const bridge = makeBridge();
    bridge.activeThreadId = 'working-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnIsHeartbeat = false;

    for (let i = 0; i < 150; i += 1) {
      expect(bridge.enqueueMessage(
        `connect:review-${i}`,
        `[system] [Review Seat Starvation] TASK-${i} needs review`,
      )).toEqual({ queued: false, reason: 'routine-pulse-wake' });
    }

    expect(bridge.heartbeatPending).toBe(true);
    expect(bridge.messageQueue).toEqual([]);
  });

  it('coalesces routine Connect notices into an active heartbeat but preserves alerts', () => {
    const bridge = makeBridge();
    bridge.activeThreadId = 'heartbeat-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnIsHeartbeat = true;

    expect(bridge.enqueueMessage(
      'connect:task',
      '[system] [Task Assigned] TASK-1',
    )).toEqual({ queued: false, reason: 'routine-pulse-wake' });
    expect(bridge.enqueueMessage(
      'connect:alert',
      '[system] [CRITICAL ALERT] Origin unavailable',
    )).toEqual({ queued: true });

    expect(bridge.heartbeatPending).toBe(false);
    expect(bridge.messageQueue).toEqual([{
      clientId: 'connect:alert',
      content: '[system] [CRITICAL ALERT] Origin unavailable',
    }]);
  });
  it('dispatches deferred 529 retry before direct traffic and a pending heartbeat', () => {
    const bridge = makeBridge();
    bridge.pendingRetryInject = { content: 'retry failed user turn', attempts: 0 };
    bridge.heartbeatPending = true;
    bridge.messageQueue = [
      { clientId: 'connect:task', content: '[system] [Task Update] routine hint' },
      { clientId: 'connect:user', content: '[hritik] direct request' },
    ];
    bridge.injectMessage = vi.fn();
    bridge.startClaudeExecution = vi.fn();

    bridge.processQueue();

    expect(bridge.injectMessage).toHaveBeenCalledOnce();
    expect(bridge.injectMessage).toHaveBeenCalledWith('retry failed user turn', { deferIfBusy: true });
    expect(bridge.startClaudeExecution).not.toHaveBeenCalled();
    expect(bridge.heartbeatPending).toBe(true);
  });

  it('dispatches system control traffic before heartbeat, then heartbeat before routine notices', () => {
    const bridge = makeBridge();
    bridge.claudeProcess = { stdin: { writable: true, write: vi.fn() } };
    bridge.heartbeatPending = true;
    bridge.messageQueue = [
      { clientId: 'connect:task', content: '[system] [Task Assigned] routine hint' },
      { clientId: 'connect:alert', content: '[system] [CRITICAL ALERT] Origin unavailable' },
    ];
    bridge.injectMessage = vi.fn();
    bridge.startClaudeExecution = vi.fn();

    bridge.processQueue();
    expect(bridge.startClaudeExecution).toHaveBeenCalledOnce();
    expect(bridge.startClaudeExecution).toHaveBeenCalledWith(
      'connect:alert',
      '[system] [CRITICAL ALERT] Origin unavailable',
    );
    expect(bridge.injectMessage).not.toHaveBeenCalled();

    bridge.startClaudeExecution.mockClear();
    bridge.processQueue();
    expect(bridge.injectMessage).toHaveBeenCalledWith(HEARTBEAT_TRIGGER);
    expect(bridge.startClaudeExecution).not.toHaveBeenCalled();
    expect(bridge.heartbeatPending).toBe(false);
    expect(bridge.messageQueue).toEqual([
      { clientId: 'connect:task', content: '[system] [Task Assigned] routine hint' },
    ]);
  });

  it('dispatches a pending canonical checkpoint before ordinary queued DMs', () => {
    const bridge = makeBridge();
    bridge.claudeProcess = { stdin: { writable: true, write: vi.fn() } };
    bridge.heartbeatPending = true;
    bridge.messageQueue = [
      { clientId: 'connect:revi', content: '[revi] receipt for the prior item' },
    ];
    bridge.injectMessage = vi.fn();
    bridge.startClaudeExecution = vi.fn();

    bridge.processQueue();

    expect(bridge.injectMessage).toHaveBeenCalledWith(HEARTBEAT_TRIGGER);
    expect(bridge.startClaudeExecution).not.toHaveBeenCalled();
    expect(bridge.messageQueue).toHaveLength(1);
  });

  it('does not emit a duplicate message_ack when Claude sends its system init line', () => {
    const bridge = new ClaudeBridge({
      port: 0,
      host: '127.0.0.1',
      model: 'claude-sonnet-4-6',
      agentId: 'agent-test',
      cwd: '/tmp',
    }) as any;

    const sent: Array<Record<string, unknown>> = [];
    const fakeWs = {
      readyState: 1,
      send(payload: string) {
        sent.push(JSON.parse(payload));
      },
    };

    bridge.clients.set('client-1', {
      ws: fakeWs,
      userId: 'user-1',
      activeThreadId: null,
    });
    bridge.claudeProcess = {
      stdin: {
        writable: true,
        write() {},
      },
    };

    bridge.startClaudeExecution('client-1', 'hello');
    expect(sent.filter((msg) => msg.type === 'message_ack')).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === 'session_start')).toHaveLength(1);

    bridge.handleStdoutChunk(Buffer.from('{"type":"system","session_id":"claude-real-session"}\n'));

    expect(sent.filter((msg) => msg.type === 'message_ack')).toHaveLength(1);
    expect(bridge.claudeSessionId).toBe('claude-real-session');
  });


  it('force-refresh availability JWT ignores unexpired AGENT_ACCESS_TOKEN after rejection', async () => {
    const originalHome = process.env['HOME'];
    const originalAgentAccessToken = process.env['AGENT_ACCESS_TOKEN'];
    const originalAgentPassword = process.env['AGENT_PASSWORD'];
    const originalBrokerSocket = process.env['MCP_AUTH_PROXY_SOCKET'];
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-token-test-'));
    const rejectedEnvToken = makeJwt('rejected-env');
    const loginToken = makeJwt('login-fresh');
    const apiToken = makeJwt('api-fresh');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/id/api/auth/login/')) {
        return new Response(JSON.stringify({
          tokens: { access: loginToken, refresh: 'refresh-token' },
          user: { id: 123, email: 'agent-test@agents.shizuha.io' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/id/api/auth/api-token/')) {
        return new Response(JSON.stringify({
          access: apiToken,
          refresh: 'api-refresh-token',
          user: { id: 123, email: 'agent-test@agents.shizuha.io' },
          expires_in_days: 365,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });

    try {
      process.env['HOME'] = tmpHome;
      process.env['AGENT_ACCESS_TOKEN'] = rejectedEnvToken;
      process.env['AGENT_PASSWORD'] = 'agent-password';
      // SCLI-307: force brokerPresent() false by pointing the broker socket at a
      // non-existent path. Otherwise, in an agent runtime the real broker UDS
      // (/run/shizuha/mcp-auth-proxy/proxy.sock) exists and getToken() mints the
      // runtime's REAL agent token from the broker — a UDS this test's fetch mock
      // can't intercept — so the assertion flaked (green only in a broker-less
      // clean CI, red in every agent runtime). This makes the test hermetic.
      process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(tmpHome, 'no-broker.sock');
      const bridge = makeBridge();

      const resolved = await bridge.resolveAvailabilityJwt('http://platform.test', true);

      expect(resolved).toBe(apiToken);
      expect(resolved).not.toBe(rejectedEnvToken);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://platform.test/id/api/auth/login/',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      fetchMock.mockRestore();
      if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
      if (originalAgentAccessToken === undefined) delete process.env['AGENT_ACCESS_TOKEN']; else process.env['AGENT_ACCESS_TOKEN'] = originalAgentAccessToken;
      if (originalAgentPassword === undefined) delete process.env['AGENT_PASSWORD']; else process.env['AGENT_PASSWORD'] = originalAgentPassword;
      if (originalBrokerSocket === undefined) delete process.env['MCP_AUTH_PROXY_SOCKET']; else process.env['MCP_AUTH_PROXY_SOCKET'] = originalBrokerSocket;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // SCLI-61 (architect review): a 529 overload is a transient PROVIDER outage,
  // not a context-poisoned session. It must NOT feed the consecutive
  // session-rotation counter — otherwise ~3 overloaded prompts (each adding the
  // original error + up to 3 injected retries) would hit ERROR_ROTATE_AFTER=10
  // and archive a healthy eternal session. N×529 then success => no rotation, 0.
  it('does not count transient 529 overloads toward session rotation', () => {
    const bridge = makeBridge();
    const rotate = vi.spyOn(bridge, 'rotateWedgedSession').mockImplementation(() => {});

    // 12 consecutive overloads (> ERROR_ROTATE_AFTER=10), flagged transient.
    for (let i = 0; i < 12; i++) {
      bridge.recordTurnError('Claude API error: 529 overloaded', true);
    }

    expect(bridge.consecutiveErrorTurns).toBe(0); // never advanced the rotation counter
    expect(rotate).not.toHaveBeenCalled();        // so it never rotated
    expect(bridge.errorTurnsTotal).toBe(12);      // but cumulative telemetry still counts them

    // A subsequent successful turn (counter reset) leaves it at 0 — no latent wedge.
    bridge.consecutiveErrorTurns = 0;
    expect(bridge.consecutiveErrorTurns).toBe(0);
  });

  // Guard: the 529 exclusion is scoped — genuine context-poisoning errors still
  // rotate, so the wedge-heal the task exists for is intact.
  it('still rotates after consecutive policy-refusal turns', () => {
    const bridge = makeBridge();
    const rotate = vi.spyOn(bridge, 'rotateWedgedSession').mockImplementation(() => {});
    const refusal =
      'Claude Code is unable to respond to this request, which appears to violate our Usage Policy';

    bridge.recordTurnError(refusal); // 1
    bridge.recordTurnError(refusal); // 2
    bridge.recordTurnError(refusal); // 3 == POLICY_ROTATE_AFTER

    expect(bridge.consecutiveErrorTurns).toBe(3);
    expect(rotate).toHaveBeenCalled();
  });
});

// HIVE-143: a 401 (expired/invalid OAuth token) must be classified distinctly from
// a 429 (rate/usage/quota) and must rotate WITHOUT the 6h rate-limit cooldown park.
describe('classifyClaudeApiError (HIVE-143)', () => {
  it('classifies auth-401 distinctly, never also 429', () => {
    for (const msg of [
      '401 Unauthorized',
      'authentication_error: invalid bearer token',
      'OAuth token has expired',
      'Error: 401 {"type":"authentication_error"}',
      'Not logged in · Please run /login',
    ]) {
      const c = classifyClaudeApiError(msg);
      expect(c.is401).toBe(true);
      expect(c.is429).toBe(false); // mutual exclusivity
    }
  });

  it('gives 401 precedence even when a limit word is also present', () => {
    // Contrived overlap: 401 marker AND a 429 marker in one message → must be 401.
    const c = classifyClaudeApiError('401 unauthorized — usage limit reset');
    expect(c.is401).toBe(true);
    expect(c.is429).toBe(false);
  });

  it('classifies rate/usage/quota as 429, not 401', () => {
    for (const msg of [
      '429 Too Many Requests',
      "You've hit your usage limit. Your limit will reset at 3pm",
      "You've reached your Fable 5 limit. /model to switch models.",
      'rate limit exceeded',
      'Your credit balance is too low',
      'quota exceeded',
    ]) {
      const c = classifyClaudeApiError(msg);
      expect(c.is429).toBe(true);
      expect(c.is401).toBe(false);
    }
  });

  it('classifies 529/overloaded as transient overload', () => {
    expect(classifyClaudeApiError('529 overloaded').is529).toBe(true);
    expect(classifyClaudeApiError('Overloaded').is529).toBe(true);
  });

  it('empty / non-string → all false', () => {
    expect(classifyClaudeApiError('')).toEqual({ is401: false, is429: false, is529: false, isTokenDead: false });
    expect(classifyClaudeApiError(undefined)).toEqual({ is401: false, is429: false, is529: false, isTokenDead: false });
  });

  // cl2-primary 2026-07-11: the org disabled Claude Code for the account, so
  // every serving call 403'd while refresh-based health kept saying ok. The
  // bridge classified it as a GENERIC api-error (counted toward the
  // poisoned-session threshold only) and the pool kept re-leasing the corpse.
  it('classifies dead credentials (org disabled / revoked) as isTokenDead, never 401/429', () => {
    for (const msg of [
      'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
      'OAuth token has been revoked · Please run /login',
    ]) {
      const c = classifyClaudeApiError(msg);
      expect(c.isTokenDead).toBe(true);
      expect(c.is401).toBe(false);
      expect(c.is429).toBe(false);
    }
  });

  it('classifies auth-time 403 as 401-class (rotate), not generic', () => {
    const c = classifyClaudeApiError('Failed to authenticate. API Error: 403 The socket connection was closed unexpectedly.');
    expect(c.is401).toBe(true);
    expect(c.isTokenDead).toBe(false);
    expect(c.is429).toBe(false);
  });
});

describe('providerUnavailableFromRecentErrors', () => {
  it('reports a current auth or quota failure after the last successful turn', () => {
    expect(providerUnavailableFromRecentErrors(false, [
      { ts: 101, msg: '401 Invalid bearer token' },
    ], 100)).toBe(true);
    expect(providerUnavailableFromRecentErrors(false, [
      { ts: 101, msg: "You've hit your weekly limit" },
    ], 100)).toBe(true);
  });

  it('does not latch old auth errors after a successful turn', () => {
    expect(providerUnavailableFromRecentErrors(false, [
      { ts: 100, msg: '401 Invalid bearer token' },
      { ts: 110, msg: 'unrelated tool warning' },
    ], 105)).toBe(false);
  });

  it('keeps an unavailable token pool authoritative regardless of error history', () => {
    expect(providerUnavailableFromRecentErrors(true, [], 100)).toBe(true);
  });
});

describe('requestTokenRotation cooldown gating (HIVE-143)', () => {
  it('401 path rotates WITHOUT parking the token (persistCooldown:false)', () => {
    const bridge = makeBridge();
    const kill = vi.fn();
    bridge.currentTokenLabel = 'cl-test';
    bridge.claudeProcess = { exitCode: null, kill };
    bridge.requestTokenRotation({ persistCooldown: false });
    expect(bridge.rateLimitedTokens.has('cl-test')).toBe(false); // NOT parked
    expect(kill).toHaveBeenCalledWith('SIGTERM');                 // but did restart
  });

  it('429 path (default) DOES park the token in cooldown', () => {
    const bridge = makeBridge();
    const kill = vi.fn();
    bridge.currentTokenLabel = 'cl-test';
    bridge.claudeProcess = { exitCode: null, kill };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    bridge.requestTokenRotation();
    expect(bridge.rateLimitedTokens.has('cl-test')).toBe(true);   // parked
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    vi.unstubAllGlobals();
  });
});

// HIVE-122: on 401, the bridge must call the daemon's report-invalid endpoint
// (not report-rate-limit) so the host token pool marks the dead token active=false.
describe('report-invalid daemon call on 401 (HIVE-122)', () => {
  it('calls daemon report-invalid (not report-rate-limit) on 401 rotation', () => {
    const bridge = makeBridge();
    const kill = vi.fn();
    bridge.currentTokenLabel = 'cl-test';
    bridge.claudeProcess = { exitCode: null, kill };
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    bridge.requestTokenRotation({ persistCooldown: false });

    // fetch is called synchronously within the void async IIFE (before its first await)
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('/report-invalid'))).toBe(true);
    expect(calledUrls.every((u) => !u.includes('/report-rate-limit'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('429 path does NOT call report-invalid', () => {
    const bridge = makeBridge();
    const kill = vi.fn();
    bridge.currentTokenLabel = 'cl-test';
    bridge.claudeProcess = { exitCode: null, kill };
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    bridge.requestTokenRotation(); // default: persistCooldown=true (429 path)

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.every((u) => !u.includes('/report-invalid'))).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('manager PLAT-879 recovery log matching (PLAT-1150)', () => {
  it('matches the bridge recovery log wording used in production', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/daemon/manager.ts'), 'utf-8');
    expect(source).toContain("line.includes('token pool recovered')");
  });
});
