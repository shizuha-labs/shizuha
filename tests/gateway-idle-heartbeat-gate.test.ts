import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Warmups are retired by default (operator 2026-08-07); these tests exercise
// the preserved mechanism behind the escape hatch.
process.env.SHIZUHA_PREWARM_ENABLE = '1';

import {
  AgentProcess,
  idleHeartbeatAgentPulseEmails,
  idleHeartbeatAdmissionAllowed,
  idleHeartbeatHasReadyPulseRows,
  isReadyPulseItemForIdleHeartbeat,
  resolvePulseBaseUrl,
  resolvePulseToken,
} from '../src/gateway/agent-process.js';
import type { Channel, InboundMessage } from '../src/gateway/types.js';
import type { Inbox } from '../src/gateway/inbox.js';
import { StateStore } from '../src/state/store.js';

type HeartbeatHarness = AgentProcess & {
  sessionId: string;
  store: StateStore;
  executeTurns: ReturnType<typeof vi.fn>;
  prewarmPrefixCache: ReturnType<typeof vi.fn>;
  inbox: Inbox;
  processMessage(msg: InboundMessage): Promise<void | false>;
  loadEternalSession(): void;
};

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('gateway idle heartbeat Pulse gate', () => {
  it('does not enqueue while a turn is busy or another heartbeat is pending', () => {
    const due = { running: true, now: 200, nextDueAt: 100 };
    expect(idleHeartbeatAdmissionAllowed({ ...due, busy: true, pendingHeartbeat: false })).toBe(false);
    expect(idleHeartbeatAdmissionAllowed({ ...due, busy: false, pendingHeartbeat: true })).toBe(false);
    expect(idleHeartbeatAdmissionAllowed({ ...due, busy: false, pendingHeartbeat: false })).toBe(true);
  });

  it('does not inject a heartbeat while the seat was recently active', () => {
    const now = 30 * 60 * 1000;
    const due = { running: true, busy: false, pendingHeartbeat: false, now, nextDueAt: 0 };
    expect(idleHeartbeatAdmissionAllowed({
      ...due,
      lastActivityAt: now - 2 * 60 * 1000,
      minIdleMs: 30 * 60 * 1000,
    })).toBe(false);
    expect(idleHeartbeatAdmissionAllowed({
      ...due,
      lastActivityAt: now - 30 * 60 * 1000,
      minIdleMs: 30 * 60 * 1000,
    })).toBe(true);
  });

  it('checks both agent email forms for direct Pulse polling', () => {
    expect(idleHeartbeatAgentPulseEmails('sara', { AGENT_EMAIL: 'sara@shizuha.com' } as NodeJS.ProcessEnv)).toEqual([
      'sara@shizuha.com',
      'sara@agents.shizuha.io',
    ]);
  });

  it('skips the model when the direct Pulse payload has no ready rows', () => {
    expect(idleHeartbeatHasReadyPulseRows({ results: [] })).toBe(false);
    expect(idleHeartbeatHasReadyPulseRows({ results: [
      { status: 'blocked' },
      { status: 'scheduled' },
      { status: 'done' },
    ] })).toBe(false);
  });

  it('resolves Pulse URL and bearer the same way MCP already authenticates', () => {
    expect(resolvePulseBaseUrl({
      SHIZUHA_PLATFORM_URL: 'http://shizuha-nginx.shizuha.svc.cluster.local',
    } as NodeJS.ProcessEnv)).toBe('http://shizuha-nginx.shizuha.svc.cluster.local');
    const dir = mkdtempSync(path.join(tmpdir(), 'pulse-token-'));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, 'bearer');
    writeFileSync(tokenFile, 'jwt-from-mcp-file\n');
    expect(resolvePulseToken({
      MCP_UPSTREAM_BEARER_FILE: tokenFile,
    } as NodeJS.ProcessEnv)).toBe('jwt-from-mcp-file');
  });

  it('wakes the model when direct Pulse rows include ready work', () => {
    expect(isReadyPulseItemForIdleHeartbeat({ status: 'open' })).toBe(true);
    expect(idleHeartbeatHasReadyPulseRows({ results: [{ status: 'in_progress' }] })).toBe(true);
  });

  it('prewarms only the ready-work heartbeat before its real turn', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'idle-heartbeat-prewarm-'));
    tempDirs.push(cwd);
    const channel: Channel = {
      id: 'connect',
      type: 'connect',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined),
      sendComplete: vi.fn(),
    };
    const agent = new AgentProcess({
      channels: [], model: 'DeepSeek-V4-Flash', cwd,
      permissionMode: 'autonomous', agentId: 'idle-prewarm-test',
    }) as unknown as HeartbeatHarness;
    agent.registerChannel(channel);
    agent.store = new StateStore(path.join(cwd, '.shizuha-state.db'));
    agent.loadEternalSession();
    agent.prewarmPrefixCache = vi.fn().mockResolvedValue(true);
    agent.executeTurns = vi.fn().mockResolvedValue(undefined);
    const heartbeat = (
      id: string,
      ready: boolean,
    ): InboundMessage => ({
      id,
      channelId: 'connect',
      channelType: 'connect',
      threadId: `heartbeat-${id}`,
      userId: 'system',
      userName: 'heartbeat',
      content: 'Check Pulse for work.',
      timestamp: Date.now(),
      source: 'heartbeat',
      metadata: { idleHeartbeatReadyWork: ready },
    });

    // Production order across two top-level inbox attempts: a ready Pulse row
    // prewarms before executeTurns; the following noop/unproven beat does not.
    await agent.processMessage(heartbeat('ready', true));
    await agent.processMessage(heartbeat('noop', false));

    expect(agent.prewarmPrefixCache).toHaveBeenCalledTimes(1);
    expect(agent.executeTurns).toHaveBeenCalledTimes(2);
    expect(agent.prewarmPrefixCache.mock.invocationCallOrder[0]).toBeLessThan(
      agent.executeTurns.mock.invocationCallOrder[0]!,
    );
    agent.store.close();
  });

  it('defers the exact inbox row and never starts its turn when required prewarm fails', async () => {
    vi.useFakeTimers();
    const cwd = mkdtempSync(path.join(tmpdir(), 'idle-heartbeat-prewarm-fail-'));
    tempDirs.push(cwd);
    const channel: Channel = {
      id: 'connect',
      type: 'connect',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined),
      sendComplete: vi.fn(),
    };
    const agent = new AgentProcess({
      channels: [], model: 'DeepSeek-V4-Flash', cwd,
      permissionMode: 'autonomous', agentId: 'idle-prewarm-fail-test',
    }) as unknown as HeartbeatHarness;
    agent.registerChannel(channel);
    agent.store = new StateStore(path.join(cwd, '.shizuha-state.db'));
    agent.loadEternalSession();
    agent.prewarmPrefixCache = vi.fn().mockResolvedValue(false);
    agent.executeTurns = vi.fn().mockResolvedValue(undefined);
    const heartbeat: InboundMessage = {
      id: 'ready-failed',
      channelId: 'connect',
      channelType: 'connect',
      threadId: 'heartbeat-ready-failed',
      userId: 'system',
      userName: 'heartbeat',
      content: 'Check Pulse for work.',
      timestamp: Date.now(),
      source: 'heartbeat',
      metadata: { idleHeartbeatReadyWork: true },
    };

    const processing = agent.processMessage(heartbeat);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(processing).resolves.toBe(false);

    expect(agent.executeTurns).not.toHaveBeenCalled();
    expect(agent.inbox.peek()).toBe(heartbeat);
    expect(agent.inbox.busy).toBe(false);
    expect(heartbeat.metadata?.['cortexPrewarmDeferredAttempt']).toBe(1);
    agent.store.close();
  });
});
