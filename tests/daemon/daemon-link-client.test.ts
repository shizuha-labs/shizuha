import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DaemonLinkClient, resolveDaemonLinkUrl } from '../../src/daemon/daemon-link-client.js';
import type { AgentInfo, DaemonState } from '../../src/daemon/types.js';
import {
  clearHeartbeatQueueDrainOutcomesForTests,
  formatHeartbeatQueueDrainOutcomeLogLine,
  ingestHeartbeatQueueDrainOutcomeLogLine,
} from '../../src/daemon/heartbeat-outcome.js';

// PLAT-4172: seed the module-level heartbeat-outcome map the way the daemon does
// (parse a bridge stdout log line) so the DaemonLink serializer can read it.
function seedHeartbeatOutcome(agentId: string, outcome: string, reason: string): void {
  ingestHeartbeatQueueDrainOutcomeLogLine(
    formatHeartbeatQueueDrainOutcomeLogLine({
      agentId,
      outcome,
      reason,
      observedAt: '2026-07-11T00:00:00.000Z',
      readyTaskCount: 4,
      blockedTaskCount: 0,
      futureDueCount: 0,
      progressEventCount: 0,
      forwardedEventCount: 0,
      pulseGetMyTasksOnly: false,
      consecutiveReadyNoProgressHeartbeats: 2,
      needsHelpAfter: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
    agentId,
  );
}

const servers: WebSocketServer[] = [];
const clients: DaemonLinkClient[] = [];

function laneDigest(lane: Record<string, unknown>): string {
  const stable = JSON.stringify(lane, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  clearHeartbeatQueueDrainOutcomesForTests();
});

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'Nagi',
    username: 'nagi',
    email: 'nagi@shizuha.com',
    role: 'Engineer',
    team: 'engineering',
    status: 'active',
    executionMethod: 'shizuha',
    runtimeEnvironment: 'k8s',
    model: 'cortex/DeepSeek-V4-Flash',
    modelFallbacks: [{ method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash', reasoningEffort: 'low' }],
    modelOverrides: { shizuha: 'cortex/DeepSeek-V4-Flash' },
    env: { PUBLIC_FLAG: '1', GITHUB_TOKEN: 'should-not-leak' },
    mcpServers: [{ name: 'Pulse', slug: 'pulse', command: '', args: [], env: {}, transportType: 'stdio' }],
    personalityTraits: {},
    skills: ['pulse-core'],
    eagerSkills: ['connect-messaging'],
    ...overrides,
  } as AgentInfo;
}

function makeState(): DaemonState {
  return {
    pid: 123,
    startedAt: '2026-07-04T00:00:00.000Z',
    platformUrl: 'https://shizuha.test',
    agents: [{
      agentId: 'agent-1',
      agentName: 'Nagi',
      tokenPrefix: 'local',
      status: 'running',
      enabled: true,
      startedAt: '2026-07-04T00:00:00.000Z',
    }],
  };
}

async function withServer(options: { seedRequired?: boolean } = {}): Promise<{ url: string; messages: Record<string, unknown>[]; socket: () => WebSocket | null }> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  const messages: Record<string, unknown>[] = [];
  let connected: WebSocket | null = null;
  server.on('connection', (ws) => {
    connected = ws;
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(frame);
      if (frame.type === 'register') {
        ws.send(JSON.stringify({ type: 'register_ack', seq: 1, seed_required: options.seedRequired ?? true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  return {
    url: `ws://127.0.0.1:${address.port}/v1/fleet/daemon-link`,
    messages,
    socket: () => connected,
  };
}

async function waitForMessage(
  messages: Record<string, unknown>[],
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for message; saw ${messages.map((m) => m.type).join(', ')}`);
}

describe('DaemonLinkClient', () => {
  it('derives the Hive daemon-link websocket URL from platform roots', () => {
    expect(resolveDaemonLinkUrl('https://platform.example/id/api')).toBe('wss://platform.example/v1/fleet/daemon-link');
    expect(resolveDaemonLinkUrl('http://platform.example/hive/api')).toBe('ws://platform.example/v1/fleet/daemon-link');
    expect(resolveDaemonLinkUrl('http://platform.example', 'ws://override/ws')).toBe('ws://override/ws');
  });

  it('registers and sends a full agent snapshot without leaking secret env keys', async () => {
    const server = await withServer();
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      fleetId: 'fleet-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      getLastActiveAt: () => '2026-07-13T09:10:11.000Z',
    });
    clients.push(client);

    expect(client.start()).toBe(true);

    const register = await waitForMessage(server.messages, (message) => message.type === 'register');
    expect(register).toMatchObject({ daemon_id: 'daemon-test', fleet_id: 'fleet-test', token: 'daemon-secret' });

    const snapshot = await waitForMessage(server.messages, (message) => message.type === 'state_snapshot');
    expect(snapshot.child_id).toBe('agent-1');
    const data = snapshot.data as Record<string, unknown>;
    expect(data).toMatchObject({
      agent_id: 'agent-1',
      agent_username: 'nagi',
      enabled: true,
      status: 'running',
      last_active_at: '2026-07-13T09:10:11.000Z',
    });
    const config = data.config as Record<string, unknown>;
    expect(config).toMatchObject({
      execution_method: 'shizuha',
      runtime_environment: 'k8s',
      model: 'cortex/DeepSeek-V4-Flash',
      model_overrides: {},
      env: { PUBLIC_FLAG: '1' },
      reasoning_effort: 'low',
    });
    expect(JSON.stringify(config)).not.toContain('should-not-leak');
    expect(data.env_redacted_keys).toEqual(['GITHUB_TOKEN']);

    const complete = await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    expect(complete.child_count).toBe(1);
  });

  it('refreshes the harness report on heartbeats without reconnecting', async () => {
    const server = await withServer({ seedRequired: false });
    let image = 'registry/shizuha-agent-runtime:harness-old';
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      heartbeatIntervalMs: 20,
      getHarnessReport: () => ({ agent_runtime_image: image }),
    });
    clients.push(client);
    client.start();

    const register = await waitForMessage(server.messages, (message) => message.type === 'register');
    expect(register.harness_report).toEqual({ agent_runtime_image: image });
    image = 'registry/shizuha-agent-runtime:harness-new';
    const heartbeat = await waitForMessage(
      server.messages,
      (message) => message.type === 'heartbeat'
        && (message.harness_report as Record<string, unknown> | undefined)?.agent_runtime_image === image,
    );
    expect(heartbeat.harness_report).toEqual({ agent_runtime_image: image });
  });



  it('does not send a reconnect snapshot unless Hive asks for an initial seed', async () => {
    const server = await withServer({ seedRequired: false });
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'register');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.messages.some((message) => message.type === 'state_snapshot')).toBe(false);
    expect(client.getStatus()).toMatchObject({ status: 'connected', connected: true, seedRequired: false });
  });

  it('fences late socket callbacks after reconnect and schedules only one next reconnect', async () => {
    const server = await withServer({ seedRequired: false });
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      reconnectBaseMs: 100,
      reconnectMaxMs: 100,
      heartbeatIntervalMs: 1_000,
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'register');
    const socketA = (client as unknown as { ws: WebSocket }).ws;
    expect(socketA).toBeTruthy();
    server.socket()?.close();

    const secondRegisterDeadline = Date.now() + 2_000;
    while (server.messages.filter((message) => message.type === 'register').length < 2) {
      if (Date.now() >= secondRegisterDeadline) throw new Error('replacement socket B did not register');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    while (!client.getStatus().connected) {
      if (Date.now() >= secondRegisterDeadline) throw new Error('replacement socket B did not receive register_ack');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const socketB = (client as unknown as { ws: WebSocket }).ws;
    expect(socketB).not.toBe(socketA);
    const heartbeatB = (client as unknown as { heartbeatTimer: NodeJS.Timeout | null }).heartbeatTimer;
    expect(heartbeatB).not.toBeNull();
    const lastFrameAtB = String(client.getStatus().lastFrameAt);

    // EventEmitter callbacks can be queued before A closes and delivered after B
    // is authoritative. None may register/send through B, handle A's frame,
    // degrade shared status, stop B's heartbeat, or schedule socket C.
    socketA.emit('open');
    socketA.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat', seq: 707 })));
    socketA.emit('error', new Error('late A error'));
    socketA.emit('close', 1006, Buffer.from('late A close'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(server.messages.filter((message) => message.type === 'register')).toHaveLength(2);
    expect(server.messages).not.toContainEqual(expect.objectContaining({ type: 'ack', seq: 707 }));
    expect((client as unknown as { heartbeatTimer: NodeJS.Timeout | null }).heartbeatTimer).toBe(heartbeatB);
    expect((client as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer).toBeNull();
    expect(client.getStatus()).toMatchObject({ status: 'connected', connected: true, lastError: '', lastFrameAt: lastFrameAtB });

    // The authoritative B close relinquishes ownership and schedules exactly
    // one reconnect. Duplicate/late B callbacks cannot accumulate timers.
    server.socket()?.close();
    const reconnectScheduledDeadline = Date.now() + 500;
    while (!(client as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer) {
      if (Date.now() >= reconnectScheduledDeadline) throw new Error('socket B close did not schedule reconnect');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const reconnectTimer = (client as unknown as { reconnectTimer: NodeJS.Timeout }).reconnectTimer;
    socketB.emit('close', 1006, Buffer.from('duplicate B close'));
    socketB.emit('error', new Error('late B error'));
    expect((client as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer).toBe(reconnectTimer);
    expect(client.getStatus().reconnectAttempts).toBe(1);

    const thirdRegisterDeadline = Date.now() + 2_000;
    while (server.messages.filter((message) => message.type === 'register').length < 3) {
      if (Date.now() >= thirdRegisterDeadline) throw new Error('socket C did not register');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(server.messages.filter((message) => message.type === 'register')).toHaveLength(3);
    expect(client.getStatus()).toMatchObject({ status: 'connected', connected: true, reconnectAttempts: 0, lastError: '' });
    expect((client as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer).toBeNull();
  });

  it('fences in-flight config and delete continuations when their sockets are superseded', async () => {
    const server = await withServer({ seedRequired: false });
    let startApply!: () => void;
    let finishApply!: (result: { ok: boolean; error?: string }) => void;
    const applyStarted = new Promise<void>((resolve) => { startApply = resolve; });
    const applyResult = new Promise<{ ok: boolean; error?: string }>((resolve) => { finishApply = resolve; });
    let startDelete!: () => void;
    let finishDelete!: (result: { ok: boolean; error?: string }) => void;
    const deleteStarted = new Promise<void>((resolve) => { startDelete = resolve; });
    const deleteResult = new Promise<{ ok: boolean; error?: string }>((resolve) => { finishDelete = resolve; });
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      reconnectBaseMs: 50,
      reconnectMaxMs: 50,
      applyConfig: () => {
        startApply();
        return applyResult;
      },
      deleteAgent: () => {
        startDelete();
        return deleteResult;
      },
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'register');
    const lane = { lane_id: 'reviewed-lane', runtime_release_id: 'scli-reviewed' };
    const laneFenceDigest = laneDigest(lane);
    const serverSocketA = server.socket();
    expect(serverSocketA).not.toBeNull();
    serverSocketA!.send(JSON.stringify({
      type: 'config_update',
      seq: 808,
      agent_id: 'agent-1',
      change_id: 'stale-A-config',
      desired_generation: 11,
      runtime_lane_digest: laneFenceDigest,
      runtime_lane: lane,
      config: { model: 'gpt-5.6-sol' },
    }));
    await applyStarted;
    serverSocketA!.close();

    const socketBDeadline = Date.now() + 2_000;
    while (server.messages.filter((message) => message.type === 'register').length < 2 || !client.getStatus().connected) {
      if (Date.now() >= socketBDeadline) throw new Error('socket B did not become authoritative');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    finishApply({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect((client as unknown as { appliedRuntimeLanes: Map<string, unknown> }).appliedRuntimeLanes.size).toBe(0);
    expect(server.messages).not.toContainEqual(expect.objectContaining({ type: 'config_result', ack_seq: 808 }));
    expect(server.messages).not.toContainEqual(expect.objectContaining({ type: 'ack', seq: 808 }));
    expect(server.messages).not.toContainEqual(expect.objectContaining({
      type: 'state_delta',
      data: expect.objectContaining({ reason: 'config_applied' }),
    }));

    const serverSocketB = server.socket();
    expect(serverSocketB).not.toBeNull();
    serverSocketB!.send(JSON.stringify({ type: 'delete_agent', seq: 809, agent_id: 'agent-1' }));
    await deleteStarted;
    serverSocketB!.close();

    const socketCDeadline = Date.now() + 2_000;
    while (server.messages.filter((message) => message.type === 'register').length < 3 || !client.getStatus().connected) {
      if (Date.now() >= socketCDeadline) throw new Error('socket C did not become authoritative');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    finishDelete({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(server.messages).not.toContainEqual(expect.objectContaining({ type: 'delete_result', ack_seq: 809 }));
    expect(server.messages).not.toContainEqual(expect.objectContaining({ type: 'ack', seq: 809 }));
    expect(client.getStatus()).toMatchObject({ status: 'connected', connected: true, lastError: '' });
    expect((client as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer).toBeNull();
  });

  it('surfaces missing-token status for fail-loud health checks', () => {
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      token: '',
      getAgents: () => [makeAgent()],
    });
    clients.push(client);
    expect(client.start()).toBe(false);
    expect(client.getStatus()).toMatchObject({
      status: 'disabled',
      connected: false,
      lastError: 'missing_daemon_link_token',
    });
  });

  it('applies Hive config frames through the daemon mutation callback and acks success', async () => {
    const server = await withServer();
    let applied: { agentId: string; updates: Record<string, unknown> } | null = null;
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      applyConfig: (agentId, updates) => {
        applied = { agentId, updates };
        return { ok: true };
      },
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    server.socket()?.send(JSON.stringify({
      type: 'config',
      seq: 77,
      agent_id: 'agent-1',
      config_fingerprints: {
        execution_method: 'a'.repeat(64),
        model_overrides: 'B'.repeat(64),
        eager_skills: 'c'.repeat(64),
        ignored_extra_key: 'd'.repeat(64),
      },
      config: {
        executionMethod: 'codex_app_server',
        modelOverrides: { codex_app_server: 'gpt-5.5' },
        eagerSkills: ['pulse-core'],
      },
    }));

    const result = await waitForMessage(server.messages, (message) => message.type === 'config_result');
    expect(applied).toEqual({
      agentId: 'agent-1',
      updates: {
        execution_method: 'codex_app_server',
        model_overrides: { codex_app_server: 'gpt-5.5' },
        eager_skills: ['pulse-core'],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      config_fingerprints: {
        execution_method: 'a'.repeat(64),
        model_overrides: 'b'.repeat(64),
        eager_skills: 'c'.repeat(64),
      },
    });
    expect(result).not.toHaveProperty('config');
    expect(result).not.toHaveProperty('updates');
    expect(server.messages).toContainEqual(expect.objectContaining({ type: 'ack', seq: 77 }));
  });

  it('does not acknowledge fingerprints when authoritative config persistence fails', async () => {
    const server = await withServer();
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      applyConfig: () => ({ ok: false, error: 'state store unavailable' }),
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    server.socket()?.send(JSON.stringify({
      type: 'config_update',
      seq: 79,
      agent_id: 'agent-1',
      config: { env: { SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS: '160000' } },
      config_fingerprints: { env: 'e'.repeat(64) },
    }));

    const result = await waitForMessage(server.messages, (message) => message.type === 'config_result');
    expect(result).toMatchObject({
      ok: false,
      error: 'state store unavailable',
      config_fingerprints: {},
    });
    expect(server.messages).not.toContainEqual(expect.objectContaining({ type: 'ack', seq: 79 }));
  });

  it('echoes exact RuntimeLane fences after durable apply and emits correlated failure then rollback health', async () => {
    const server = await withServer();
    const health = [
      {
        apply_status: 'failed' as const,
        workload_ready: true,
        container_ready: true,
        harness_ready: false,
        provider_health: { available: false, quota_ok: true, in_backoff: false },
        error: 'codex broker auth unavailable',
      },
      {
        apply_status: 'ok' as const,
        workload_ready: true,
        container_ready: true,
        harness_ready: true,
        provider_health: { available: true, quota_ok: true, in_backoff: false },
      },
    ];
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      applyConfig: () => ({ ok: true }),
      probeRuntimeLaneHealth: () => health.shift()!,
    });
    clients.push(client);
    client.start();
    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');

    const forwardLane = {
      lane_id: 'openai-codex', registry_version: 'v1', runtime_release_id: 'scli-1',
      execution_method: 'codex_app_server', primary: { provider: 'openai', model_id: 'gpt-5.6-sol' },
      model: 'gpt-5.6-sol', model_fallbacks: [], model_overrides: {}, provider: 'openai',
      credential_requirements: ['codex.oauth'],
    };
    const forwardDigest = laneDigest(forwardLane);
    server.socket()?.send(JSON.stringify({
      type: 'config_update', seq: 80, agent_id: 'agent-1', change_id: 'forward',
      desired_generation: 7, runtime_lane_digest: forwardDigest, runtime_lane: forwardLane,
      config: { model: 'gpt-5.6-sol', execution_method: 'codex_app_server' },
      config_fingerprints: { model: 'a'.repeat(64), execution_method: 'b'.repeat(64) },
    }));
    const forwardResult = await waitForMessage(
      server.messages,
      (message) => message.type === 'config_result' && message.desired_generation === 7,
    );
    expect(forwardResult).toMatchObject({
      ok: true, desired_generation: 7, runtime_lane_digest: forwardDigest,
    });
    const failedHealth = await waitForMessage(
      server.messages,
      (message) => message.type === 'health_snapshot' && message.observed_generation === 7,
    );
    expect(failedHealth).toMatchObject({
      apply_status: 'failed', harness_ready: false,
      provider_health: { available: false, quota_ok: true, in_backoff: false },
    });

    const rollbackLane = {
      ...forwardLane,
      lane_id: 'deepseek-shizuha', execution_method: 'shizuha',
      primary: { provider: 'deepseek', model_id: 'DeepSeek-V4-Flash' },
      model: 'DeepSeek-V4-Flash', provider: 'deepseek',
      credential_requirements: ['cortex.invoke:deepseek'],
    };
    const rollbackDigest = laneDigest(rollbackLane);
    server.socket()?.send(JSON.stringify({
      type: 'config_update', seq: 81, agent_id: 'agent-1', change_id: 'rollback',
      desired_generation: 8, runtime_lane_digest: rollbackDigest, runtime_lane: rollbackLane,
      config: { model: 'DeepSeek-V4-Flash', execution_method: 'shizuha' },
      config_fingerprints: { model: 'c'.repeat(64), execution_method: 'd'.repeat(64) },
    }));
    const rolledBackHealth = await waitForMessage(
      server.messages,
      (message) => message.type === 'health_snapshot' && message.observed_generation === 8,
    );
    expect(rolledBackHealth).toMatchObject({
      apply_status: 'ok', workload_ready: true, container_ready: true,
      harness_ready: true,
      provider_health: { available: true, quota_ok: true, in_backoff: false },
    });
  });

  it('restores the durable RuntimeLane fence before consuming frames after daemon reconstruction', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lane-fence-'));
    const statePath = path.join(stateDir, 'fences.json');
    const server = await withServer();
    const lane = {
      lane_id: 'openai-codex', registry_version: 'v1', runtime_release_id: 'scli-1',
      execution_method: 'codex_app_server', primary: { provider: 'openai', model_id: 'gpt-5.6-sol' },
      model: 'gpt-5.6-sol', model_fallbacks: [], model_overrides: {}, provider: 'openai',
      credential_requirements: ['codex.oauth'],
    };
    const digest = laneDigest(lane);
    const first = new DaemonLinkClient({
      platformUrl: 'https://platform.example', url: server.url, token: 'daemon-secret',
      getAgents: () => [makeAgent()], getDaemonState: () => makeState(),
      runtimeLaneFenceStatePath: statePath,
      applyConfig: () => ({ ok: true }),
    });
    clients.push(first);
    first.start();
    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    server.socket()?.send(JSON.stringify({
      type: 'config_update', seq: 90, agent_id: 'agent-1', change_id: 'forward',
      desired_generation: 9, runtime_lane_digest: digest, runtime_lane: lane,
      config: { model: 'gpt-5.6-sol', execution_method: 'codex_app_server' },
    }));
    await waitForMessage(
      server.messages,
      (message) => message.type === 'config_result' && message.desired_generation === 9,
    );
    first.stop();

    let reconstructedApplyCalls = 0;
    const reconstructed = new DaemonLinkClient({
      platformUrl: 'https://platform.example', url: server.url, token: 'daemon-secret',
      getAgents: () => [makeAgent()], getDaemonState: () => makeState(),
      runtimeLaneFenceStatePath: statePath,
      applyConfig: () => { reconstructedApplyCalls += 1; return { ok: true }; },
    });
    clients.push(reconstructed);
    reconstructed.start();
    const reconnectDeadline = Date.now() + 2_000;
    while (server.messages.filter((message) => message.type === 'register').length < 2) {
      if (Date.now() >= reconnectDeadline) throw new Error('reconstructed client did not register');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    server.socket()?.send(JSON.stringify({
      type: 'config_update', seq: 91, agent_id: 'agent-1', change_id: 'delayed',
      desired_generation: 8, runtime_lane_digest: digest, runtime_lane: lane,
      config: { model: 'gpt-5.6-sol', execution_method: 'codex_app_server' },
    }));
    const rejected = await waitForMessage(
      server.messages,
      (message) => message.type === 'config_result' && message.desired_generation === 8,
    );
    expect(rejected).toMatchObject({ ok: false, error: 'stale_or_conflicting_runtime_lane_generation' });
    expect(reconstructedApplyCalls).toBe(0);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('applies Hive delete tombstones through the daemon mutation callback and acks success', async () => {
    const server = await withServer();
    const deleted: string[] = [];
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      deleteAgent: (agentId) => {
        deleted.push(agentId);
        return { ok: true };
      },
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    server.socket()?.send(JSON.stringify({
      type: 'delete_agent',
      seq: 78,
      agent_id: 'agent-1',
      reason: 'hive_desired_deleted',
    }));

    await waitForMessage(server.messages, (message) => message.type === 'delete_result');
    expect(deleted).toEqual(['agent-1']);
    expect(server.messages).toContainEqual(expect.objectContaining({ type: 'ack', seq: 78 }));
  });

  it('sends deltas for runtime/config changes after registration', async () => {
    const server = await withServer();
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
      getLastActiveAt: () => '2026-07-13T09:12:13.000Z',
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    expect(client.sendAgentDelta('agent-1', 'unit-test')).toBe(true);

    const delta = await waitForMessage(
      server.messages,
      (message) => message.type === 'state_delta' && (message.data as Record<string, unknown> | undefined)?.reason === 'unit-test',
    );
    expect(delta.child_id).toBe('agent-1');
    expect((delta.data as Record<string, unknown>).observed_config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(delta.data).toEqual(expect.objectContaining({
      last_active_at: '2026-07-13T09:12:13.000Z',
    }));
  });

  it('propagates the heartbeat needs_help outcome to Hive in the delta frame (PLAT-4172)', async () => {
    // The queue-blind escalation is invisible to the operator unless it reaches
    // Hive: nova fired needs_help but /hive/agents showed 0. Prove the DaemonLink
    // frame now carries needs_help + reason so Hive can surface it.
    seedHeartbeatOutcome('agent-1', 'needs_help', '4 ready task(s) with no progress for 2 heartbeat(s)');
    const server = await withServer();
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
    });
    clients.push(client);
    client.start();

    // seeded on the register/snapshot seed itself
    const snapshot = await waitForMessage(server.messages, (message) => message.type === 'state_snapshot');
    const data = snapshot.data as Record<string, unknown>;
    expect(data.needs_help).toBe(true);
    expect(data.needs_help_reason).toBe('4 ready task(s) with no progress for 2 heartbeat(s)');
    expect(data.heartbeat_outcome).toBe('needs_help');
    expect(data.heartbeat_observed_at).toBe('2026-07-11T00:00:00.000Z');
  });

  it('clears needs_help in the frame once the agent resumes exposing its queue (PLAT-4172)', async () => {
    // A non-needs_help outcome (agent checked its queue again) must push
    // needs_help:false so the Hive Agents page stops flagging it.
    seedHeartbeatOutcome('agent-1', 'queue_empty', 'no actionable ready, blocked, or future tasks observed');
    const server = await withServer();
    const client = new DaemonLinkClient({
      platformUrl: 'https://platform.example',
      url: server.url,
      daemonId: 'daemon-test',
      token: 'daemon-secret',
      getAgents: () => [makeAgent()],
      getDaemonState: () => makeState(),
    });
    clients.push(client);
    client.start();

    await waitForMessage(server.messages, (message) => message.type === 'state_snapshot_complete');
    expect(client.sendAgentDelta('agent-1', 'heartbeat_outcome')).toBe(true);
    const delta = await waitForMessage(
      server.messages,
      (message) => message.type === 'state_delta' && (message.data as Record<string, unknown> | undefined)?.reason === 'heartbeat_outcome',
    );
    const data = delta.data as Record<string, unknown>;
    expect(data.needs_help).toBe(false);
    expect(data.needs_help_reason).toBe('');
    expect(data.heartbeat_outcome).toBe('queue_empty');
  });
});
