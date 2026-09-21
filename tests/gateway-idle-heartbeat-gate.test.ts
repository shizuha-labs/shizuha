import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Warmups are retired by default (operator 2026-08-07); these tests exercise
// the preserved mechanism behind the escape hatch.
process.env.SHIZUHA_PREWARM_ENABLE = '1';

import {
  AgentProcess,
  formatIdleHeartbeatNudge,
  formatPulseQueueSnapshotLines,
  idleHeartbeatAgentPulseEmails,
  idleHeartbeatAdmissionAllowed,
  idleHeartbeatFirstBeatDue,
  idleHeartbeatHasReadyPulseRows,
  isReadyPulseItemForIdleHeartbeat,
  pulsePreflightShouldRetryUnauthorized,
  resolvePulseBaseUrl,
  resolvePulseToken,
  resolvePulseTokenFresh,
  shouldArmFirstWarmHeartbeat,
  shouldResetFruitlessHeartbeatSession,
  shouldTouchIdleActivityForSource,
  cronJobShouldIsolateFromEternalSession,
  trimIsolatedCronTranscript,
} from '../src/gateway/agent-process.js';
import { DEFAULT_IDLE_HEARTBEAT_MS, resolveIdleHeartbeatMs } from '../src/platform/lean-conversational.js';
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

  it('retries Pulse preflight only when 401 produced a different JWT', () => {
    expect(pulsePreflightShouldRetryUnauthorized(401, 'stale', 'fresh')).toBe(true);
    expect(pulsePreflightShouldRetryUnauthorized(401, 'same', 'same')).toBe(false);
    expect(pulsePreflightShouldRetryUnauthorized(401, 'stale', '')).toBe(false);
    expect(pulsePreflightShouldRetryUnauthorized(503, 'stale', 'fresh')).toBe(false);
  });

  it('prefers a fresh broker JWT over the stale file token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pulse-token-fresh-'));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, 'bearer');
    writeFileSync(tokenFile, 'expired-file-jwt\n');
    const token = await resolvePulseTokenFresh(
      { MCP_UPSTREAM_BEARER_FILE: tokenFile } as NodeJS.ProcessEnv,
      async () => ({ accessToken: 'broker-fresh-jwt', expiresAt: '' }),
    );
    expect(token).toBe('broker-fresh-jwt');
  });

  it('falls back to the file token when the broker is absent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pulse-token-file-'));
    tempDirs.push(dir);
    const tokenFile = path.join(dir, 'bearer');
    writeFileSync(tokenFile, 'file-jwt\n');
    const token = await resolvePulseTokenFresh(
      { MCP_UPSTREAM_BEARER_FILE: tokenFile } as NodeJS.ProcessEnv,
      async () => null,
    );
    expect(token).toBe('file-jwt');
  });

  it('rotates the eternal session after three fruitless ready needs_help beats', () => {
    expect(shouldResetFruitlessHeartbeatSession({
      outcome: 'needs_help',
      readyTaskCount: 5,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 3,
    })).toBe(true);
    expect(shouldResetFruitlessHeartbeatSession({
      outcome: 'needs_help',
      readyTaskCount: 5,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 2,
    })).toBe(false);
    expect(shouldResetFruitlessHeartbeatSession({
      outcome: 'all_blocked',
      readyTaskCount: 0,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 9,
    })).toBe(false);
    expect(shouldResetFruitlessHeartbeatSession({
      outcome: 'needs_help',
      readyTaskCount: 5,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 3,
      pulseGetMyTasksOnly: true,
    })).toBe(false);
  });

  it('does not treat interval cron watches as idle-activity or eternal-session work', () => {
    expect(shouldTouchIdleActivityForSource('user')).toBe(true);
    expect(shouldTouchIdleActivityForSource('heartbeat')).toBe(true);
    expect(shouldTouchIdleActivityForSource('cron')).toBe(false);
    expect(cronJobShouldIsolateFromEternalSession({ source: 'cron' })).toBe(true);
    expect(cronJobShouldIsolateFromEternalSession({
      source: 'cron',
      metadata: { selfInvocation: true },
    })).toBe(false);
    expect(cronJobShouldIsolateFromEternalSession({ source: 'heartbeat' })).toBe(false);
    expect(trimIsolatedCronTranscript(['keep', 'cron-user', 'cron-asst'], 1)).toEqual(['keep']);
    expect(trimIsolatedCronTranscript(['compacted'], 5)).toEqual(['compacted']);
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
  });

  it('honors workflow owner awareness without a status-specific ignore list', () => {
    for (const status of ['resolved_elsewhere', 'custom_waiting_for_awareness', '']) {
      expect(isReadyPulseItemForIdleHeartbeat({ status, owner_action_policy: 'awareness' })).toBe(false);
    }
    expect(isReadyPulseItemForIdleHeartbeat({ status: 'resolved_elsewhere' })).toBe(true);
    expect(isReadyPulseItemForIdleHeartbeat({
      status: 'custom_owner_work', owner_action_policy: 'actionable', is_active_item: false,
    })).toBe(true);
    for (const status of ['blocked', 'done']) {
      expect(isReadyPulseItemForIdleHeartbeat({ status, owner_action_policy: 'actionable' })).toBe(false);
    }
  });

  it('filters only the ready snapshot without removing awareness from the owner payload', () => {
    const payload = { results: [
      { item_key: 'PLS-1227', status: 'resolved_elsewhere', priority: 'urgent',
        title: 'Answered ask', owner_action_policy: 'awareness' },
      { item_key: 'WORK-1', status: 'custom_owner_work', priority: 'normal',
        title: 'Current work', owner_action_policy: 'actionable' },
    ] };
    const original = JSON.stringify(payload);
    expect(idleHeartbeatHasReadyPulseRows({ results: [payload.results[0]] })).toBe(false);
    expect(idleHeartbeatHasReadyPulseRows(payload)).toBe(true);
    expect(formatPulseQueueSnapshotLines(payload, 1)).toEqual([
      '- WORK-1 custom_owner_work normal — Current work',
    ]);
    expect(JSON.stringify(payload)).toBe(original);
  });

  it('does not claim not-yet-due recurring tasks as ready work (PLAT-7611)', () => {
    const future = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    // Recurring + future due: the preflight must NOT claim READY WORK.
    expect(isReadyPulseItemForIdleHeartbeat({
      status: 'todo', is_recurring: true, due_date: future,
    })).toBe(false);
    // Recurring + due (or overdue): ready, as before.
    expect(isReadyPulseItemForIdleHeartbeat({
      status: 'todo', is_recurring: true, due_date: past,
    })).toBe(true);
    expect(isReadyPulseItemForIdleHeartbeat({
      status: 'todo', is_recurring: true, due_date: null,
    })).toBe(true);
    // Non-recurring rows keep the status-only behavior — a future due date
    // on one-shot work does not suppress it.
    expect(isReadyPulseItemForIdleHeartbeat({
      status: 'todo', is_recurring: false, due_date: future,
    })).toBe(true);
    expect(isReadyPulseItemForIdleHeartbeat({ status: 'todo' })).toBe(true);
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

  it('does not let the idle floor veto a due first beat on a quiet work seat', () => {
    const now = 8_000;
    expect(idleHeartbeatAdmissionAllowed({
      running: true,
      busy: false,
      pendingHeartbeat: false,
      now,
      nextDueAt: now,
      lastActivityAt: now,
      minIdleMs: 90_000,
    })).toBe(false);
    expect(idleHeartbeatFirstBeatDue({
      firstHeartbeatPending: true,
      running: true,
      now,
      nextDueAt: now,
      talkedSinceBoot: false,
      busy: false,
      pendingHeartbeat: false,
    })).toBe(true);
    expect(idleHeartbeatFirstBeatDue({
      firstHeartbeatPending: true,
      running: true,
      now,
      nextDueAt: now,
      talkedSinceBoot: true,
      busy: false,
      pendingHeartbeat: false,
    })).toBe(false);
    expect(shouldArmFirstWarmHeartbeat(8_000)).toBe(true);
  });

  it('arms the first-warm timer for any firstHeartbeat under 60s, not only lean seats', () => {
    expect(shouldArmFirstWarmHeartbeat(8_000)).toBe(true);
    expect(shouldArmFirstWarmHeartbeat(59_999)).toBe(true);
    expect(shouldArmFirstWarmHeartbeat(60_000)).toBe(false);
    expect(shouldArmFirstWarmHeartbeat(900_000)).toBe(false);
    expect(shouldArmFirstWarmHeartbeat(0)).toBe(false);
  });

  it('does not dump the Pulse snapshot into the heartbeat nudge', () => {
    const lines = formatPulseQueueSnapshotLines({
      results: [
        { item_key: 'SCLI-563', status: 'todo', priority: 'urgent', title: 'empty selector' },
        { item_key: 'BKS-180', status: 'blocked', priority: 'urgent', title: 'ignored' },
        { item_key: 'PLS-979', status: 'open', priority: 'urgent', title: 'deploy smoke' },
      ],
    });
    expect(lines).toEqual([
      '- SCLI-563 todo urgent — empty selector',
      '- PLS-979 open urgent — deploy smoke',
    ]);
    const nudge = formatIdleHeartbeatNudge({
      ready: true,
      reason: 'ready_task',
      snapshotLines: lines,
    });
    expect(nudge).not.toContain('READY WORK exists');
    expect(nudge).not.toContain('Runtime-confirmed queue:');
    expect(nudge).not.toContain('SCLI-563');
    expect(nudge).toMatch(/stop with no text/i);
    expect(formatIdleHeartbeatNudge({ ready: false })).toBe(nudge);
  });
});

describe('resolveIdleHeartbeatMs', () => {
  it('honors the seat-configured cadence (operator directive 2026-09-15)', () => {
    expect(resolveIdleHeartbeatMs('90000')).toBe(90_000);
    expect(resolveIdleHeartbeatMs('60000')).toBe(60_000);
    expect(resolveIdleHeartbeatMs(undefined)).toBe(DEFAULT_IDLE_HEARTBEAT_MS);
    expect(resolveIdleHeartbeatMs('not-a-number')).toBe(DEFAULT_IDLE_HEARTBEAT_MS);
  });

  it('keeps a 15m/30m cadence', () => {
    expect(resolveIdleHeartbeatMs('900000')).toBe(900_000);
    expect(resolveIdleHeartbeatMs('1800000')).toBe(1_800_000);
  });
});
