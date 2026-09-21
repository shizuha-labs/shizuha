import { describe, expect, it } from 'vitest';
import { CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER, CODEX_HEARTBEAT_TRIGGER, CODEX_PLATFORM_MCP_TOKEN_ENV, CodexBridge, buildCodexPlatformMcpToml, buildConnectDmTurnPrompt, buildEmptyConnectDmReplay, buildHeartbeatToolObservationFromCodexMcpItem, buildPulseQueueCapabilityManifest, capabilityDigest, classifyPulseHeartbeatPreflight, connectReplyTrackedSenderUsername, enqueueBridgeMessage, isConnectSystemSenderUsername, isExplicitConnectReplyRequest, isHeartbeatTurnContent, isLowPriorityConnectSystemMessage, isMessageUserToolCall, isPriorityConnectControlMessage, isSilentSystemUpdateTurn, mcpToolCallResponseText, normalizeOpenAiBaseUrl, parseConnectSenderUsername, parsePulseHeartbeatPreflightResponse, selectBridgeQueueAction } from '../../src/codex-bridge/index.js';
import { clearHeartbeatQueueDrainOutcomesForTests, formatHeartbeatQueueDrainOutcomeLogLine, getHeartbeatQueueDrainOutcome, ingestHeartbeatQueueDrainOutcomeLogLine, recordHeartbeatQueueDrainTurn } from '../../src/daemon/heartbeat-outcome.js';

describe('normalizeOpenAiBaseUrl', () => {
  it('uses the in-cluster Cortex /v1 endpoint by default', () => {
    expect(normalizeOpenAiBaseUrl()).toBe('http://cortex.shizuha-cortex.svc.cluster.local:8040/v1');
  });

  it('appends exactly one /v1 to Cortex base URLs', () => {
    expect(normalizeOpenAiBaseUrl('http://cortex.shizuha-cortex.svc.cluster.local:8040')).toBe(
      'http://cortex.shizuha-cortex.svc.cluster.local:8040/v1',
    );
    expect(normalizeOpenAiBaseUrl('http://cortex.shizuha-cortex.svc.cluster.local:8040/')).toBe(
      'http://cortex.shizuha-cortex.svc.cluster.local:8040/v1',
    );
    expect(normalizeOpenAiBaseUrl('http://cortex.shizuha-cortex.svc.cluster.local:8040/v1')).toBe(
      'http://cortex.shizuha-cortex.svc.cluster.local:8040/v1',
    );
  });

  it('collapses repeated trailing /v1 segments from deployment env values', () => {
    expect(normalizeOpenAiBaseUrl('http://cortex.shizuha-cortex.svc.cluster.local:8040/v1/')).toBe(
      'http://cortex.shizuha-cortex.svc.cluster.local:8040/v1',
    );
    expect(normalizeOpenAiBaseUrl('http://cortex.shizuha-cortex.svc.cluster.local:8040/v1/v1')).toBe(
      'http://cortex.shizuha-cortex.svc.cluster.local:8040/v1',
    );
  });
});


describe('buildCodexPlatformMcpToml', () => {
  it('uses Codex bearer_token_env_var instead of ignored http_headers for HTTP platform MCP auth', () => {
    const toml = buildCodexPlatformMcpToml('shizuha-pulse', {
      url: 'https://platform.example/mcp/pulse/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    });

    expect(toml).toContain('[mcp_servers.shizuha-pulse]');
    expect(toml).toContain('url = "https://platform.example/mcp/pulse/mcp"');
    expect(toml).toContain(`bearer_token_env_var = "${CODEX_PLATFORM_MCP_TOKEN_ENV}"`);
    expect(toml).not.toContain('http_headers');
    expect(toml).not.toContain('secret-token');
  });
});


describe('Connect DM turn prompt', () => {
  it('extracts sender usernames from Connect-prefixed messages', () => {
    expect(parseConnectSenderUsername('[jun] please reply')).toBe('jun');
    expect(parseConnectSenderUsername('please reply')).toBeNull();
  });

  it('adds an explicit message_user delivery requirement for Connect DMs', () => {
    const prompt = buildConnectDmTurnPrompt('[jun] reply exactly `CON-98 pong`', 'direct', 'required');

    expect(prompt).toContain('[jun] reply exactly `CON-98 pong`');
    expect(prompt).toContain('Natural turn text in the Codex bridge is private');
    expect(prompt).toContain('message_user');
    expect(prompt).toContain('recipient_username="jun"');
    expect(prompt).toContain('send exactly that requested reply');
  });

  it('makes a non-request Direct message optional rather than mandatory', () => {
    const prompt = buildConnectDmTurnPrompt('[jun] Deployment is green.', 'direct');

    expect(prompt).toContain('[Connect DM delivery note]');
    expect(prompt).toContain('silence is valid');
    expect(prompt).not.toContain('MUST call');
  });

  it('fails missing provenance open to one optional-reply turn', () => {
    const prompt = buildConnectDmTurnPrompt('[jun] Deployment is green.', 'unknown');

    expect(prompt).toContain('provenance is missing or invalid');
    expect(prompt).toContain('silence is valid');
  });

  it('does not require a reply to system Connect notifications', () => {
    const content = '[system] [Task Assigned] CON-158 requires work';
    const prompt = buildConnectDmTurnPrompt(content);

    expect(isConnectSystemSenderUsername('system')).toBe(true);
    expect(isConnectSystemSenderUsername('System')).toBe(true);
    expect(prompt).toBe(content);
    expect(prompt).not.toContain('[Connect DM delivery requirement]');
    expect(prompt).not.toContain('recipient_username="system"');
  });

  it('does not track replies or provider-empty failures for reserved system notifications', () => {
    expect(connectReplyTrackedSenderUsername('[system] 🧭 Design Review — inspect this')).toBeNull();
    expect(connectReplyTrackedSenderUsername('[jun] please inspect this')).toBe('jun');
    expect(isSilentSystemUpdateTurn('[system] 🧭 Design Review — inspect this')).toBe(true);
    expect(isSilentSystemUpdateTurn('  [SYSTEM] lifecycle notice')).toBe(true);
    expect(isSilentSystemUpdateTurn('[jun] ordinary DM')).toBe(false);
  });

  it('leaves non-prefixed turns unchanged', () => {
    expect(buildConnectDmTurnPrompt('plain dashboard message')).toBe('plain dashboard message');
  });

  it('detects message_user MCP tool calls across server-name variants', () => {
    expect(isMessageUserToolCall('mcp__shizuha_connect', 'message_user')).toBe(true);
    expect(isMessageUserToolCall('mcp__shizuha-connect', 'message_user')).toBe(true);
    expect(isMessageUserToolCall('mcp__shizuha_pulse', 'pulse_get_my_tasks')).toBe(false);
  });

  it('never replays Connect DMs after a completed turn (inject-once / silence is valid)', () => {
    const original = {
      clientId: 'connect:conv-1',
      content: '[hritik] Run the Digital books computation.',
      conversationType: 'direct' as const,
      replyObligation: 'optional' as const,
    };
    // Completed-empty path: allowReplay defaults false — no retain/replay death spiral.
    expect(buildEmptyConnectDmReplay(original, true, false)).toBeNull();
    expect(buildEmptyConnectDmReplay(original, true, false, false)).toBeNull();
  });

  it('may re-inject Connect DMs only on transient provider failure (allowReplay)', () => {
    const original = {
      clientId: 'connect:conv-1',
      content: '[hritik] Run the Digital books computation.',
      conversationType: 'direct' as const,
      replyObligation: 'optional' as const,
    };
    const first = buildEmptyConnectDmReplay(original, true, false, true);
    const second = buildEmptyConnectDmReplay(first, true, false, true);

    expect(first).toEqual({ ...original, emptyTurnReplayCount: 1 });
    expect(second).toEqual({ ...original, emptyTurnReplayCount: 2 });
    expect(first?.content).not.toContain('[Connect DM delivery');
  });

  it('never replays system, productive, or already-replied Connect turns', () => {
    const direct = { clientId: 'connect:conv-1', content: '[hritik] compute reports' };
    expect(buildEmptyConnectDmReplay(direct, false, false, true)).toBeNull();
    expect(buildEmptyConnectDmReplay(direct, true, true, true)).toBeNull();
    expect(buildEmptyConnectDmReplay(
      { clientId: 'connect:system', content: '[system] [Task Update] BKSD-5 changed' },
      true,
      false,
      true,
    )).toBeNull();
    expect(buildEmptyConnectDmReplay(
      { clientId: 'dashboard', content: 'compute reports' },
      true,
      false,
      true,
    )).toBeNull();
  });
});


describe('bridge queue priority', () => {
  it('queues user Connect DMs ahead of pending system notifications', () => {
    const queue = [
      { clientId: 'connect:sys-1', content: '[system] [Task Update] queued system notification' },
      { clientId: 'connect:sys-2', content: '[system] [Task Assigned] another system notification' },
    ];

    const position = enqueueBridgeMessage(queue, {
      clientId: 'connect:user-1',
      content: '[kei] Please reply exactly `CON-98 pong`',
    });

    expect(position).toBe(0);
    expect(queue.map((item) => item.content)).toEqual([
      '[kei] Please reply exactly `CON-98 pong`',
      '[system] [Task Update] queued system notification',
      '[system] [Task Assigned] another system notification',
    ]);
  });

  it('prioritizes explicit reply probes ahead of older agent chatter', () => {
    const queue = [
      { clientId: 'connect:agent-1', content: '[sora] regular inter-agent update' },
      { clientId: 'connect:agent-2', content: '[shion] another queued agent DM' },
      { clientId: 'connect:sys-1', content: '[system] [Task Update] queued system notification' },
    ];

    const probe = {
      clientId: 'connect:qa-1',
      content: '[kei] CON-98 live verification probe. Please reply in this DM with exactly: CON-98 pong kei-0505',
    };
    const position = enqueueBridgeMessage(queue, probe);

    expect(isExplicitConnectReplyRequest(probe)).toBe(true);
    expect(position).toBe(0);
    expect(queue.map((item) => item.content)).toEqual([
      '[kei] CON-98 live verification probe. Please reply in this DM with exactly: CON-98 pong kei-0505',
      '[sora] regular inter-agent update',
      '[shion] another queued agent DM',
      '[system] [Task Update] queued system notification',
    ]);
  });

  it('SCLI-462: recognizes natural reply-with-this-exact-nonce phrasing without broadening routine traffic', () => {
    const zenWording =
      '[zen] Please call pulse_get_my_alerts, then pulse_get_my_tasks, and reply with this exact nonce plus whether both calls completed: ZEN-SORA-SCLI462-PREFIX';
    const positives = [
      zenWording,
      'reply with this exact nonce: ABC123',
      'Please reply with this exact nonce FOO',
      'reply with the exact token TOK-1',
      'Please reply exactly: ZEN-RUI-HIVE1695-20260801T1708Z',
      'Reply with the text ZEN-RUI-HIVE1695-20260801T1708Z',
    ];
    for (const content of positives) {
      expect(isExplicitConnectReplyRequest({ clientId: 'connect:ce120ec4-859e-449a-acfe-6d5f8f4947f6', content })).toBe(true);
    }

    const negatives: Array<{ clientId: string; content: string }> = [
      { clientId: 'connect:x', content: 'Thanks, noted.' },
      { clientId: 'connect:x', content: '[system] [Task Update] SCLI-462 moved to in_progress' },
      { clientId: 'connect:x', content: 'The nonce was rotated last week for security.' },
      { clientId: 'connect:x', content: 'Please review the exact diff when you can.' },
      { clientId: 'connect:x', content: 'I will reply later today.' },
      { clientId: 'connect:x', content: 'exact match required in tests' },
      { clientId: 'connect:x', content: 'token bucket rate limit' },
      { clientId: 'connect:x', content: 'heartbeat completed successfully' },
      // non-Connect client must never enter interrupt class even with probe wording
      { clientId: 'telegram:1', content: 'reply with this exact nonce: X' },
    ];
    for (const msg of negatives) {
      expect(isExplicitConnectReplyRequest(msg)).toBe(false);
    }

    // Natural nonce probe still jumps ahead of older agent chatter + system wakes.
    const queue = [
      { clientId: 'connect:agent-1', content: '[sora] regular inter-agent update' },
      { clientId: 'connect:sys-1', content: '[system] [Task Update] queued system notification' },
    ];
    const position = enqueueBridgeMessage(queue, {
      clientId: 'connect:zen-1',
      content: zenWording,
    });
    expect(position).toBe(0);
    expect(queue[0]?.content).toBe(zenWording);
    expect(queue).toHaveLength(3);
  });

  it('preserves FIFO among non-system Connect DMs', () => {
    const queue = [
      { clientId: 'connect:user-1', content: '[kei] first' },
      { clientId: 'connect:sys-1', content: '[system] [Task Update] later' },
    ];

    const position = enqueueBridgeMessage(queue, {
      clientId: 'connect:user-2',
      content: '[banto] second',
    });

    expect(position).toBe(1);
    expect(queue.map((item) => item.content)).toEqual([
      '[kei] first',
      '[banto] second',
      '[system] [Task Update] later',
    ]);
  });

  it('runs a due Pulse checkpoint before routine task-notification turns', () => {
    const queue = [
      { clientId: 'connect:sys-1', content: '[system] [Task Assigned] PLS-496 requires review' },
      { clientId: 'connect:sys-2', content: '[SYSTEM] [Review Seat Starvation] PLS-509 needs a reviewer' },
    ];

    expect(queue.every(isLowPriorityConnectSystemMessage)).toBe(true);
    expect(selectBridgeQueueAction(queue, 1_000, 1_000)).toEqual({ kind: 'heartbeat' });
  });

  it('coalesces routability-hold bursts behind the due Pulse checkpoint', () => {
    const queue = Array.from({ length: 6 }, (_, index) => ({
      clientId: `connect:hold-${index}`,
      content: `[system] [Routability Hold] PLAT-${4_298 + index} is waiting for provider recovery`,
    }));

    expect(queue.every(isLowPriorityConnectSystemMessage)).toBe(true);
    expect(selectBridgeQueueAction(queue, 1_000, 1_000)).toEqual({ kind: 'heartbeat' });
  });

  it('holds routine task notifications during a checkpoint settle delay', () => {
    const queue = [
      { clientId: 'connect:sys-1', content: '[system] [Task Update] PLS-496 changed status' },
    ];

    expect(selectBridgeQueueAction(queue, 1_250, 1_000)).toEqual({ kind: 'wait', delayMs: 250 });
  });

  it('keeps system control alerts ahead of a pending Pulse checkpoint', () => {
    const queue = [
      { clientId: 'connect:sys-task', content: '[system] [Task Update] queued scheduling hint' },
      { clientId: 'connect:alert', content: '[system] [CRITICAL ALERT] Origin is unavailable' },
      { clientId: 'connect:user', content: '[hritik] Check the incident now' },
    ];

    expect(isLowPriorityConnectSystemMessage(queue[0]!)).toBe(true);
    expect(isLowPriorityConnectSystemMessage(queue[1]!)).toBe(false);
    expect(isPriorityConnectControlMessage(queue[1]!)).toBe(true);
    expect(isPriorityConnectControlMessage(queue[2]!)).toBe(false);
    expect(selectBridgeQueueAction(queue, 1_000, 1_000)).toEqual({ kind: 'message', index: 1 });
  });

  it('runs a due task checkpoint before ordinary agent or human DMs', () => {
    const queue = [
      { clientId: 'connect:user', content: '[hritik] status update when free' },
      { clientId: 'connect:agent', content: '[revi] review receipt for the prior item' },
    ];

    expect(selectBridgeQueueAction(queue, 1_000, 1_000)).toEqual({ kind: 'heartbeat' });
    expect(selectBridgeQueueAction(queue, 1_250, 1_000)).toEqual({ kind: 'wait', delayMs: 250 });
    expect(selectBridgeQueueAction(queue, null, 1_000)).toEqual({ kind: 'message', index: 0 });
  });
});


describe('Codex heartbeat outcome instrumentation', () => {
  const pulseInventory = {
    data: [{
      name: 'shizuha-pulse',
      tools: {
        pulse_get_my_tasks: {
          name: 'pulse_get_my_tasks',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    }],
  };

  it('composes an immutable scoped capability only from the exact callable Pulse tool', () => {
    const manifest = buildPulseQueueCapabilityManifest(
      pulseInventory,
      { agent_username: 'jun', effective_mcp_services: 'pulse,connect,wiki' },
      '7:1234',
    );

    expect(manifest).toEqual({
      capability_id: 'pulse.queue.read',
      canonical_tool: 'mcp__shizuha_pulse__pulse_get_my_tasks',
      model_alias: 'mcp__shizuha-pulse__pulse_get_my_tasks',
      schema_digest: capabilityDigest({ type: 'object', properties: {}, additionalProperties: false }),
      scope_digest: capabilityDigest({ agent_username: 'jun', effective_mcp_services: 'pulse,connect,wiki' }),
      generation: '7:1234',
    });
    expect(() => buildPulseQueueCapabilityManifest(
      { data: [{ name: 'generic-resource-list', tools: {} }] },
      { agent_username: 'jun' },
      '7:1234',
    )).toThrow(/pulse\.queue\.read is absent/);
  });

  it('runtime-primes a fresh heartbeat with a real scoped queue snapshot before sampling', async () => {
    const bridge = new CodexBridge({ model: 'gpt-5.6-sol', cwd: '/tmp/scli-348-test', agentUsername: 'jun' }) as any;
    bridge.codexThreadId = 'thread-fresh';
    bridge.serverProcess = { pid: 4321 };
    bridge.activeTurnIsHeartbeat = true;
    bridge.heartbeatToolCalls = [];
    bridge.heartbeatToolResults = [];
    const queueSnapshot = `Tasks for jun@agents.shizuha.io:\nFound 1 task(s) — 1 actionable.\n- **SCLI-348** runtime gate\n  Status: in_progress | Priority: urgent`;
    const requests: Array<{ method: string; params: unknown }> = [];
    bridge.rpcRequest = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === 'mcpServerStatus/list') return pulseInventory;
      if (method === 'mcpServer/tool/call') return { content: [{ type: 'text', text: queueSnapshot }], isError: false };
      throw new Error(`unexpected ${method}`);
    };

    const prompt = await bridge.primeHeartbeatQueueObservation();

    expect(requests.map((entry) => entry.method)).toEqual([
      'mcpServerStatus/list',
      'mcpServer/tool/call',
    ]);
    expect(requests[1]?.params).toMatchObject({
      threadId: 'thread-fresh', server: 'shizuha-pulse', tool: 'pulse_get_my_tasks', arguments: {},
    });
    expect(prompt).toContain('[RUNTIME-VERIFIED PULSE QUEUE]');
    expect(prompt).toContain('SCLI-348');
    expect(bridge.heartbeatAdmissionState).toBe('queue_observed');
    expect(bridge.heartbeatToolCalls).toEqual([{ name: 'mcp__shizuha_pulse__pulse_get_my_tasks' }]);

    const outcome = recordHeartbeatQueueDrainTurn('jun-fresh-pod', {
      toolCalls: [...bridge.heartbeatToolCalls, { name: 'mcp__shizuha_pulse__pulse_add_comment' }],
      toolResults: [...bridge.heartbeatToolResults, { content: 'Comment added', isError: false }],
    });
    expect(outcome).toMatchObject({ outcome: 'worked_task', readyTaskCount: 1, progressEventCount: 1 });
  });

  it('fails closed after one bounded recompose when scoped Pulse inventory is absent', async () => {
    const bridge = new CodexBridge({ model: 'gpt-5.6-sol', cwd: '/tmp/scli-348-missing-test', agentUsername: 'jun' }) as any;
    bridge.codexThreadId = 'thread-missing';
    bridge.serverProcess = { pid: 4322 };
    const methods: string[] = [];
    bridge.rpcRequest = async (method: string) => {
      methods.push(method);
      if (method === 'config/mcpServer/reload') return {};
      return { data: [{ name: 'generic-resource-list', tools: {} }] };
    };
    bridge.markAgentAvailability = async () => undefined;

    await expect(bridge.primeHeartbeatQueueObservation())
      .rejects.toThrow(/admission failed after bounded recovery/);
    expect(methods).toEqual(['mcpServerStatus/list', 'config/mcpServer/reload', 'mcpServerStatus/list']);
    expect(bridge.heartbeatAdmissionState).toBe('needs_help');
    expect(bridge.pulseQueueCapabilityManifest).toBeNull();
  });

  it('normalizes app-server MCP content blocks without accepting metadata as queue evidence', () => {
    expect(mcpToolCallResponseText({ content: [{ type: 'text', text: 'Found 0 task(s)' }] })).toBe('Found 0 task(s)');
    expect(mcpToolCallResponseText({ structuredContent: { generic: true } })).toBe('');
  });

  it('gives app-server the native Pulse tool name instead of a coordinator-only wrapper', () => {
    expect(CODEX_HEARTBEAT_TRIGGER).toContain(
      'mcp__shizuha-pulse__pulse_get_my_work',
    );
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('do NOT invoke it through shell/Node/`functions.exec`');
    expect(CODEX_HEARTBEAT_TRIGGER).not.toContain('tools.mcp__');
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('do NOT call `list_mcp_resources`');
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('inspect files/env');
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('BOUNDED scheduler turn');
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('STOP without fetching a second item');
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('You choose what to advance');
    expect(CODEX_HEARTBEAT_TRIGGER).toContain('ZERO output is forbidden until');
    expect(CODEX_HEARTBEAT_TRIGGER).not.toContain('ordered alert-then-task pair is MANDATORY');
    expect(CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER).toContain('Call `mcp__shizuha-pulse__pulse_get_my_work` as your FIRST action');
    expect(CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER).toContain('That one snapshot is alerts + tasks');
    expect(CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER).toContain('preceding scheduler turn failed');
  });

  it('detects scheduler heartbeat turn content', () => {
    expect(isHeartbeatTurnContent('[HEARTBEAT] Automatic sync')).toBe(true);
    expect(isHeartbeatTurnContent('[HEARTBEAT RETRY] Mandatory observation')).toBe(true);
    expect(isHeartbeatTurnContent('  [heartbeat] lower-case scheduler tick')).toBe(true);
    expect(isHeartbeatTurnContent('[shion] heartbeat mentioned in chat')).toBe(false);
  });

  it('maps Codex MCP tool-call items to daemon-visible heartbeat outcomes', () => {
    clearHeartbeatQueueDrainOutcomesForTests();
    const alertObservation = buildHeartbeatToolObservationFromCodexMcpItem({
      type: 'mcpToolCall',
      server: 'shizuha-pulse',
      tool: 'pulse_get_my_alerts',
      result: 'No active assigned alerts.',
    });
    const taskObservation = buildHeartbeatToolObservationFromCodexMcpItem({
      type: 'mcpToolCall',
      server: 'shizuha-pulse',
      tool: 'pulse_get_my_tasks',
      result: `Tasks for nagi@shizuha.com:
Found 1 task(s) — 1 actionable.

- **PLAT-1108**: ready work
  Status: open | Priority: high
`,
    });

    const childOutcome = recordHeartbeatQueueDrainTurn('codex-child', {
      toolCalls: [alertObservation.toolCall, taskObservation.toolCall],
      toolResults: [alertObservation.toolResult, taskObservation.toolResult],
    }, '2026-06-30T02:00:00.000Z');
    const stdoutLine = `  [Codex] ${formatHeartbeatQueueDrainOutcomeLogLine(childOutcome)}`;

    clearHeartbeatQueueDrainOutcomesForTests();
    ingestHeartbeatQueueDrainOutcomeLogLine(stdoutLine, 'daemon-agent-id');

    expect(getHeartbeatQueueDrainOutcome('daemon-agent-id')).toMatchObject({
      outcome: 'ready_no_progress',
      readyTaskCount: 1,
      pulseGetMyTasksOnly: true,
      pulseGetMyAlertsObserved: true,
      pulseAlertTaskOrderValid: true,
    });
  });
});

describe('zero-token Pulse heartbeat preflight', () => {
  const empty = { count: 0, results: [] };
  const bounded = {
    decision: 'skip',
    reason: 'queue_empty',
    alert_count: 0,
    ready_task_count: 0,
    backlog_count: 0,
    blocked_task_count: 0,
    future_due_count: 0,
    counts_are_presence_markers: true,
  };

  it('accepts each internally consistent bounded Pulse decision', () => {
    expect(parsePulseHeartbeatPreflightResponse(bounded)).toMatchObject({
      kind: 'skip',
      blockedTaskCount: 0,
      futureDueCount: 0,
    });
    expect(parsePulseHeartbeatPreflightResponse({
      ...bounded,
      decision: 'run',
      reason: 'active_alert',
      alert_count: 1,
    })).toMatchObject({ kind: 'run', reason: 'active Pulse alert' });
    expect(parsePulseHeartbeatPreflightResponse({
      ...bounded,
      decision: 'run',
      reason: 'ready_task',
      ready_task_count: 1,
    })).toMatchObject({ kind: 'run', reason: 'ready Pulse task' });
    expect(parsePulseHeartbeatPreflightResponse({
      ...bounded,
      decision: 'run',
      reason: 'backlog_pull',
      backlog_count: 1,
    })).toMatchObject({ kind: 'run', reason: 'backlog pull item' });
    expect(parsePulseHeartbeatPreflightResponse({
      ...bounded,
      reason: 'all_blocked',
      blocked_task_count: 1,
    })).toMatchObject({ kind: 'skip', blockedTaskCount: 1 });
    expect(parsePulseHeartbeatPreflightResponse({
      ...bounded,
      reason: 'future_due',
      future_due_count: 1,
    })).toMatchObject({ kind: 'skip', futureDueCount: 1 });
  });

  it('fails open by rejecting ambiguous or self-contradictory bounded responses', () => {
    expect(() => parsePulseHeartbeatPreflightResponse({
      ...bounded,
      counts_are_presence_markers: false,
    })).toThrow(/presence markers/);
    expect(() => parsePulseHeartbeatPreflightResponse({
      ...bounded,
      ready_task_count: 1,
    })).toThrow(/skip runnable work/);
    expect(() => parsePulseHeartbeatPreflightResponse({
      ...bounded,
      decision: 'run',
      reason: 'ready_task',
    })).toThrow(/inconsistent run/);
    expect(() => parsePulseHeartbeatPreflightResponse({
      ...bounded,
      blocked_task_count: 2,
    })).toThrow(/invalid blocked/);
  });

  it('runs Codex for alerts, ready tasks, and backlog pull work', () => {
    expect(classifyPulseHeartbeatPreflight(1, empty, 0)).toMatchObject({
      kind: 'run',
      reason: '1 active alert(s)',
    });
    expect(classifyPulseHeartbeatPreflight(0, {
      count: 1,
      results: [{ status: 'in_progress' }],
    }, 0)).toMatchObject({
      kind: 'run',
      reason: 'ready Pulse task at status=in_progress',
    });
    expect(classifyPulseHeartbeatPreflight(0, {
      count: 3,
      results: [{ status: 'blocked' }],
    }, 2)).toMatchObject({
      kind: 'run',
      reason: '2 backlog pull item(s)',
    });
  });

  it('skips the model for a completely empty queue', () => {
    expect(classifyPulseHeartbeatPreflight(0, empty, 0)).toEqual({
      kind: 'skip',
      reason: 'Pulse alerts, active queue, and backlog pull lane are empty',
      readyTaskCount: 0,
      blockedTaskCount: 0,
      futureDueCount: 0,
    });
  });

  it('classifies blocked-only and future-only queues without a model turn', () => {
    expect(classifyPulseHeartbeatPreflight(0, {
      count: 4,
      results: [{ status: 'blocked' }],
    }, 0)).toMatchObject({
      kind: 'skip',
      readyTaskCount: 0,
      blockedTaskCount: 4,
      futureDueCount: 0,
    });
    expect(classifyPulseHeartbeatPreflight(0, {
      count: 2,
      results: [{ status: 'open', due_date: '2027-01-01T00:00:00Z' }],
    }, 0, Date.parse('2026-07-26T00:00:00Z'))).toMatchObject({
      kind: 'skip',
      readyTaskCount: 0,
      blockedTaskCount: 0,
      futureDueCount: 2,
    });
  });

  it('fails open when Pulse claims work but omits a readable item or status', () => {
    expect(classifyPulseHeartbeatPreflight(0, { count: 1, results: [] }, 0).kind).toBe('run');
    expect(classifyPulseHeartbeatPreflight(0, {
      count: 1,
      results: [{}],
    }, 0).kind).toBe('run');
  });
});
