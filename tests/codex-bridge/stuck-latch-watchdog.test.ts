import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexBridge,
  getTurnStallReason,
  isLatchStuck,
  parseIntervalMs,
  shouldScheduleHeartbeatDrainFollowup,
} from '../../src/codex-bridge/index.js';
import { isCurrentBridgeChild, runSerializedStuckRecovery } from '../../src/shared/stuck-latch-recovery.js';
import {
  clearHeartbeatQueueDrainOutcomesForTests,
  getHeartbeatQueueDrainOutcome,
  recordHeartbeatQueueDrainOutcome,
} from '../../src/daemon/heartbeat-outcome.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearHeartbeatQueueDrainOutcomesForTests();
});

describe('shouldScheduleHeartbeatDrainFollowup', () => {
  it('gives the first ready queue stall one immediate clean-thread retry', () => {
    expect(shouldScheduleHeartbeatDrainFollowup({
      outcome: 'ready_no_progress',
      readyTaskCount: 12,
    })).toBe(true);
  });

  it('continues after progress while ready work remains', () => {
    expect(shouldScheduleHeartbeatDrainFollowup({
      outcome: 'worked_task',
      readyTaskCount: 3,
    })).toBe(true);
    expect(shouldScheduleHeartbeatDrainFollowup({
      outcome: 'forwarded',
      readyTaskCount: 2,
    })).toBe(true);
  });

  it('stops after the second-strike needs_help outcome and on an empty queue', () => {
    expect(shouldScheduleHeartbeatDrainFollowup({
      outcome: 'needs_help',
      readyTaskCount: 12,
    })).toBe(false);
    expect(shouldScheduleHeartbeatDrainFollowup({
      outcome: 'ready_no_progress',
      readyTaskCount: 0,
    })).toBe(false);
  });
});

// PLAT-4179: the stuck-latch watchdog force-clears a leaked busy latch so a wedged
// turn (app-server request hung) can't park the agent. The bug was cadence, not this
// predicate — but the predicate is the load-bearing SAFETY gate: it must NEVER report
// a live turn (busy < threshold) as stuck, or the frequent watchdog timer would abort
// real work fleet-wide. These lock that gate.

const THRESHOLD = 45 * 60 * 1000; // 45m
const NOW = 1_000_000_000_000;

describe('isLatchStuck (PLAT-4179)', () => {
  it('is false when no turn is active (no latch to clear)', () => {
    expect(isLatchStuck(null, NOW - 10 * THRESHOLD, THRESHOLD, NOW)).toBe(false);
  });

  it('is false for a live turn younger than the threshold (never abort real work)', () => {
    expect(isLatchStuck('t', NOW - (THRESHOLD - 1), THRESHOLD, NOW)).toBe(false);
    expect(isLatchStuck('t', NOW - 60_000, THRESHOLD, NOW)).toBe(false); // 1m in
  });

  it('is true at/after the threshold (presumed-dead turn → clear)', () => {
    expect(isLatchStuck('t', NOW - THRESHOLD, THRESHOLD, NOW)).toBe(true); // boundary
    expect(isLatchStuck('t', NOW - 82 * 60 * 1000, THRESHOLD, NOW)).toBe(true); // the 82m repro
  });

  it('keeps an old latch alive while its child continues making progress', () => {
    expect(isLatchStuck(
      't',
      NOW - 82 * 60 * 1000,
      THRESHOLD,
      NOW,
      NOW - 1_000,
    )).toBe(false);
  });

  it('recovers an old latch after progress itself exceeds the threshold', () => {
    expect(isLatchStuck(
      't',
      NOW - 82 * 60 * 1000,
      THRESHOLD,
      NOW,
      NOW - THRESHOLD,
    )).toBe(true);
  });

  it('FAILS SAFE for an active latch with unknown start age — never instant-clear (rei P1-2)', () => {
    // Several bridge start paths set activeThreadId without stamping the start time;
    // treating that as stuck would abort a healthy turn. Must be false (not cleared).
    expect(isLatchStuck('t', null, THRESHOLD, NOW)).toBe(false);
  });

  it('respects a custom threshold (env-overridable heartbeatStuckMs)', () => {
    const short = 20 * 60 * 1000; // e.g. claude-bridge default
    expect(isLatchStuck('t', NOW - 19 * 60 * 1000, short, NOW)).toBe(false);
    expect(isLatchStuck('t', NOW - 21 * 60 * 1000, short, NOW)).toBe(true);
  });
});

describe('getTurnStallReason', () => {
  const base = {
    activeThreadId: 'turn-1',
    activeThreadStartedAt: NOW - 120_000,
    firstModelEventAt: null,
    lastProgressAt: null,
    firstEventTimeoutMs: 120_000,
    progressTimeoutMs: 15 * 60_000,
    hardAgeTimeoutMs: THRESHOLD,
    now: NOW,
  };

  it('recovers at the first-model-event deadline instead of waiting 45 minutes', () => {
    expect(getTurnStallReason(base)).toBe('first_model_event_timeout');
  });

  it('keeps a started turn alive while progress is recent', () => {
    expect(getTurnStallReason({
      ...base,
      firstModelEventAt: NOW - 60_000,
      lastProgressAt: NOW - 1_000,
    })).toBeNull();
  });

  it('recovers a started turn after the no-progress deadline', () => {
    expect(getTurnStallReason({
      ...base,
      activeThreadStartedAt: NOW - 20 * 60_000,
      firstModelEventAt: NOW - 19 * 60_000,
      lastProgressAt: NOW - 15 * 60_000,
    })).toBe('progress_timeout');
  });

  it('does not hard-kill a turn older than 45 minutes while progress is recent', () => {
    expect(getTurnStallReason({
      ...base,
      activeThreadStartedAt: NOW - 82 * 60_000,
      firstModelEventAt: NOW - 81 * 60_000,
      lastProgressAt: NOW - 1_000,
    })).toBeNull();
  });

  it('keeps hard age only as a fail-safe for malformed progress timestamps', () => {
    expect(getTurnStallReason({
      ...base,
      activeThreadStartedAt: NOW - 82 * 60_000,
      firstModelEventAt: Number.NaN,
      lastProgressAt: Number.NaN,
    })).toBe('hard_age_timeout');
  });
});

describe('resolveIdleHeartbeatMs (codex heartbeat cadence honors the fleet knob)', () => {
  it('honors SHIZUHA_IDLE_HEARTBEAT_MS from the pod env (the 1h-hardcode starvation regression)', async () => {
    const { resolveIdleHeartbeatMs } = await import('../../src/codex-bridge/index.js');
    // The fleet renders 900000 (15m) into every agent pod; the bridge must use it.
    expect(resolveIdleHeartbeatMs({ SHIZUHA_IDLE_HEARTBEAT_MS: '900000' } as NodeJS.ProcessEnv)).toBe(900_000);
    // Any tuned value is honored too — nothing pins back to 1h.
    expect(resolveIdleHeartbeatMs({ SHIZUHA_IDLE_HEARTBEAT_MS: '300000' } as NodeJS.ProcessEnv)).toBe(300_000);
  });

  it('defaults to 30m (not 1h) when unset, and falls back for junk/below-floor values', async () => {
    const { resolveIdleHeartbeatMs } = await import('../../src/codex-bridge/index.js');
    expect(resolveIdleHeartbeatMs({} as NodeJS.ProcessEnv)).toBe(30 * 60 * 1000);
    for (const bad of ['0', '-5', 'NaN', '', '999']) {
      expect(resolveIdleHeartbeatMs({ SHIZUHA_IDLE_HEARTBEAT_MS: bad } as NodeJS.ProcessEnv)).toBe(30 * 60 * 1000);
    }
  });
});

describe('CodexBridge heartbeat boundary arbitration', () => {
  function schedulerFixture() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-heartbeat-arbiter-'));
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.serverReady = true;
    return { bridge, cwd };
  }

  it('turns a regular heartbeat fired while busy into a pending checkpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.activeThreadId = 'working-turn';
      bridge.activeThreadStartedAt = Date.now();
      bridge.activeTurnIsHeartbeat = false;

      await bridge.fireHeartbeat();

      expect(bridge.pendingHeartbeatCheckpoint).toMatchObject({
        observationRetry: false,
        resetThread: false,
        dueAt: Date.now(),
        reason: 'regular heartbeat fired while busy',
      });
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('coalesces repeated regular ticks without clearing retry or fresh-thread semantics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.activeThreadId = 'working-turn';
      bridge.activeThreadStartedAt = Date.now();
      bridge.activeTurnIsHeartbeat = false;
      bridge.pendingHeartbeatCheckpoint = {
        observationRetry: true,
        resetThread: true,
        dueAt: Date.now() + 1_000,
        reason: 'mandatory Pulse observation retry',
      };

      await bridge.fireHeartbeat();
      await bridge.fireHeartbeat();

      expect(bridge.pendingHeartbeatCheckpoint).toMatchObject({
        observationRetry: true,
        resetThread: true,
        dueAt: Date.now() + 1_000,
        reason: 'mandatory Pulse observation retry; regular heartbeat fired while busy',
      });
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('records an empty queue and spends zero model tokens when Pulse preflight says skip', async () => {
    vi.stubEnv('AGENT_ID', 'codex-empty-queue');
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.runPulseHeartbeatPreflight = vi.fn(async () => ({
        kind: 'skip',
        reason: 'Pulse alerts, active queue, and backlog pull lane are empty',
        readyTaskCount: 0,
        blockedTaskCount: 0,
        futureDueCount: 0,
      }));
      bridge.executeMessage = vi.fn(async () => undefined);
      bridge.retireCodexThread = vi.fn();
      bridge.emitTelemetry = vi.fn();

      await bridge.fireHeartbeat();

      expect(bridge.runPulseHeartbeatPreflight).toHaveBeenCalledOnce();
      expect(bridge.executeMessage).not.toHaveBeenCalled();
      expect(bridge.retireCodexThread).not.toHaveBeenCalled();
      expect(bridge.activeThreadId).toBeNull();
      expect(bridge.emitTelemetry).toHaveBeenCalledOnce();
      expect(getHeartbeatQueueDrainOutcome('codex-empty-queue')).toMatchObject({
        outcome: 'queue_empty',
        readyTaskCount: 0,
        blockedTaskCount: 0,
        futureDueCount: 0,
        pulseGetMyAlertsObserved: true,
        pulseAlertTaskOrderValid: true,
      });
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('runs one provider-recovery probe after a real rate-limit marker ages while Pulse is empty', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-recovery-heartbeat-'));
    const marker = path.join(cwd, 'provider-unavailable');
    // Only explicit outage reasons stick; empty-turn markers are cleared on boot.
    fs.writeFileSync(marker, 'rate_limit: usage limit reached');
    vi.stubEnv('SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER', marker);
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.serverReady = true;
    try {
      bridge.runPulseHeartbeatPreflight = vi.fn(async () => ({
        kind: 'skip',
        reason: 'Pulse alerts, active queue, and backlog pull lane are empty',
        readyTaskCount: 0,
        blockedTaskCount: 0,
        futureDueCount: 0,
      }));
      bridge.executeMessage = vi.fn(async () => undefined);
      bridge.retireCodexThread = vi.fn();
      bridge.emitTelemetry = vi.fn();

      await bridge.fireHeartbeat();
      expect(bridge.executeMessage).not.toHaveBeenCalled();
      expect(bridge.emitTelemetry).toHaveBeenCalledOnce();

      const old = new Date(Date.now() - (16 * 60 * 1000));
      fs.utimesSync(marker, old, old);
      await bridge.fireHeartbeat();

      expect(bridge.runPulseHeartbeatPreflight).toHaveBeenCalledTimes(2);
      expect(bridge.executeMessage).toHaveBeenCalledOnce();
      expect(bridge.retireCodexThread).toHaveBeenCalledWith('autonomous heartbeat boundary');
      expect(bridge.providerRecoveryProbeAttempted).toBe(true);
      expect(bridge.activeThreadId).not.toBeNull();
      expect(bridge.emitTelemetry).toHaveBeenCalledOnce();
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails open to the existing Codex heartbeat when preflight cannot prove idleness', async () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.resolvePlatformBase = vi.fn(() => 'https://shizuha.example');
      bridge.resolvePlatformJwt = vi.fn(async () => {
        throw new Error('upstream token timeout');
      });
      bridge.executeMessage = vi.fn(async () => undefined);
      bridge.retireCodexThread = vi.fn();

      await bridge.fireHeartbeat();

      expect(bridge.resolvePlatformJwt).toHaveBeenCalledOnce();
      expect(bridge.executeMessage).toHaveBeenCalledOnce();
      expect(bridge.retireCodexThread).toHaveBeenCalledWith('autonomous heartbeat boundary');
      expect(bridge.activeThreadId).not.toBeNull();
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses one bounded Pulse request when the dedicated preflight route is available', async () => {
    vi.stubEnv('AGENT_EMAIL', 'empty-agent@shizuha.com');
    const { bridge, cwd } = schedulerFixture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      decision: 'skip',
      reason: 'queue_empty',
      alert_count: 0,
      ready_task_count: 0,
      backlog_count: 0,
      blocked_task_count: 0,
      future_due_count: 0,
      counts_are_presence_markers: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      bridge.resolvePlatformBase = vi.fn(() => 'https://shizuha.example');
      bridge.resolvePlatformJwt = vi.fn(async () => 'test-token');

      await expect(bridge.runPulseHeartbeatPreflight()).resolves.toMatchObject({
        kind: 'skip',
        readyTaskCount: 0,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(url.pathname).toBe('/pulse/api/items/heartbeat-preflight/');
      expect(url.searchParams.get('assignee_email')).toBe('empty-agent@shizuha.com');
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refreshes a rejected platform JWT once before failing open to a model heartbeat', async () => {
    vi.stubEnv('AGENT_EMAIL', 'blocked-agent@shizuha.com');
    const { bridge, cwd } = schedulerFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        decision: 'skip',
        reason: 'all_blocked',
        alert_count: 0,
        ready_task_count: 0,
        backlog_count: 0,
        blocked_task_count: 1,
        future_due_count: 0,
        counts_are_presence_markers: true,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      bridge.resolvePlatformBase = vi.fn(() => 'https://shizuha.example');
      bridge.resolvePlatformJwt = vi.fn()
        .mockResolvedValueOnce('expired-token')
        .mockResolvedValueOnce('fresh-token');

      await expect(bridge.runPulseHeartbeatPreflight()).resolves.toMatchObject({
        kind: 'skip',
        blockedTaskCount: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
        authorization: 'Bearer expired-token',
      });
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
        authorization: 'Bearer fresh-token',
      });
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not reuse a cached platform JWT inside the refresh window', async () => {
    const { bridge, cwd } = schedulerFixture();
    const jwt = (expiresAtMs: number) => [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString('base64url'),
      'test-signature',
    ].join('.');
    const cachedNearExpiry = jwt(Date.now() + 3 * 60_000);
    const fresh = jwt(Date.now() + 24 * 60 * 60_000);
    vi.stubEnv('HOME', cwd);
    vi.stubEnv('SHIZUHA_PLATFORM_URL', 'https://shizuha.example');
    vi.stubEnv('AGENT_ACCESS_TOKEN', fresh);
    bridge.platformJwtToken = cachedNearExpiry;
    try {
      await expect(bridge.resolvePlatformJwt()).resolves.toBe(fresh);
      expect(bridge.platformJwtToken).toBe(fresh);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('retries one transient bounded-preflight timeout before spending model tokens', async () => {
    vi.stubEnv('AGENT_EMAIL', 'empty-agent@shizuha.com');
    const { bridge, cwd } = schedulerFixture();
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        decision: 'skip',
        reason: 'queue_empty',
        alert_count: 0,
        ready_task_count: 0,
        backlog_count: 0,
        blocked_task_count: 0,
        future_due_count: 0,
        counts_are_presence_markers: true,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      bridge.resolvePlatformBase = vi.fn(() => 'https://shizuha.example');
      bridge.resolvePlatformJwt = vi.fn(async () => 'test-token');

      await expect(bridge.runPulseHeartbeatPreflight()).resolves.toMatchObject({
        kind: 'skip',
        readyTaskCount: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses the legacy ordered reads only for a rolling-deploy 404', async () => {
    vi.stubEnv('AGENT_EMAIL', 'empty-agent@shizuha.com');
    const { bridge, cwd } = schedulerFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockImplementation(async () => new Response(JSON.stringify({
          count: 0,
          results: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      bridge.resolvePlatformBase = vi.fn(() => 'https://shizuha.example');
      bridge.resolvePlatformJwt = vi.fn(async () => 'test-token');

      await expect(bridge.runPulseHeartbeatPreflight()).resolves.toMatchObject({
        kind: 'skip',
        readyTaskCount: 0,
      });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
      expect(urls[0]?.pathname).toBe('/pulse/api/items/heartbeat-preflight/');
      expect(urls.slice(1).every((url) => url.pathname === '/pulse/api/items/')).toBe(true);
      expect(urls[1]?.searchParams.get('mode')).toBe('alert');
      expect(urls[2]?.searchParams.get('is_active')).toBe('true');
      expect(urls[3]?.searchParams.get('status')).toBe('backlog');
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses one immediate fresh-thread rescue instead of a redundant warm retry', () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.codexThreadId = 'warm-thread';

      expect(bridge.prepareHeartbeatObservationRetry()).toBe(true);
      expect(bridge.codexThreadId).toBeNull();
      expect(bridge.heartbeatObservationRetryCount).toBe(1);

      bridge.codexThreadId = 'already-retried-thread';
      expect(bridge.prepareHeartbeatObservationRetry()).toBe(false);
      expect(bridge.codexThreadId).toBe('already-retried-thread');
      expect(bridge.heartbeatObservationRetryCount).toBe(1);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('converts a 150-notice Connect flood into one checkpoint and zero model-turn payloads', () => {
    vi.useFakeTimers();
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.activeThreadId = 'working-turn';
      bridge.activeThreadStartedAt = Date.now();
      bridge.activeTurnIsHeartbeat = false;
      bridge.processQueue = vi.fn();

      for (let i = 0; i < 150; i += 1) {
        expect(bridge.convertRoutineConnectMessageToHeartbeat({
          clientId: `connect:review-${i}`,
          content: `[system] [Review Seat Starvation] TASK-${i} needs review`,
        })).toBe(true);
      }

      expect(bridge.messageQueue).toEqual([]);
      expect(bridge.pendingHeartbeatCheckpoint).toMatchObject({
        observationRetry: false,
        resetThread: false,
        reason: 'routine Connect scheduling wake',
      });
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('coalesces routine Connect wakes into an already-active heartbeat', () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.activeThreadId = 'heartbeat-turn';
      bridge.activeThreadStartedAt = Date.now();
      bridge.activeTurnIsHeartbeat = true;

      for (let i = 0; i < 150; i += 1) {
        bridge.convertRoutineConnectMessageToHeartbeat({
          clientId: `connect:task-${i}`,
          content: `[system] [Task Update] TASK-${i} changed`,
        });
      }

      expect(bridge.messageQueue).toEqual([]);
      expect(bridge.pendingHeartbeatCheckpoint).toBeNull();
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it('runs a pending Pulse checkpoint before routine Connect task notifications', async () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.messageQueue = [
        { clientId: 'connect:task-1', content: '[system] [Task Update] PLS-496 changed status' },
        { clientId: 'connect:task-2', content: '[system] [Task Assigned] PLAT-4732 requires review' },
      ];
      bridge.pendingHeartbeatCheckpoint = {
        observationRetry: false,
        resetThread: true,
        dueAt: Date.now(),
        reason: 'bounded autonomous queue drain follow-up',
      };
      bridge.codexThreadId = 'previous-task-thread';
      bridge.fireHeartbeat = vi.fn(async () => undefined);
      bridge.startExecution = vi.fn(async () => undefined);

      await bridge.processQueue();

      expect(bridge.codexThreadId).toBeNull();
      expect(bridge.fireHeartbeat).toHaveBeenCalledOnce();
      expect(bridge.fireHeartbeat).toHaveBeenCalledWith(false);
      expect(bridge.startExecution).not.toHaveBeenCalled();
      expect(bridge.messageQueue).toHaveLength(2);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps explicit system control alerts ahead of a pending checkpoint', async () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.messageQueue = [
        { clientId: 'connect:task', content: '[system] [Task Update] routine scheduling hint' },
        { clientId: 'connect:alert', content: '[system] [CRITICAL ALERT] Origin unavailable' },
        { clientId: 'connect:hritik', content: '[hritik] Investigate the outage' },
      ];
      bridge.pendingHeartbeatCheckpoint = {
        observationRetry: false,
        resetThread: false,
        dueAt: Date.now(),
        reason: 'regular heartbeat fired while busy',
      };
      bridge.fireHeartbeat = vi.fn(async () => undefined);
      bridge.startExecution = vi.fn(async () => undefined);

      await bridge.processQueue();

      expect(bridge.startExecution).toHaveBeenCalledOnce();
      expect(bridge.startExecution).toHaveBeenCalledWith(
        'connect:alert',
        '[system] [CRITICAL ALERT] Origin unavailable',
        undefined,
        undefined,
      );
      expect(bridge.fireHeartbeat).not.toHaveBeenCalled();
      expect(bridge.pendingHeartbeatCheckpoint).not.toBeNull();
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('runs a pending canonical checkpoint before ordinary queued DMs', async () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.messageQueue = [
        { clientId: 'connect:hritik', content: '[hritik] status update when free' },
        { clientId: 'connect:revi', content: '[revi] receipt for the prior item' },
      ];
      bridge.pendingHeartbeatCheckpoint = {
        observationRetry: false,
        resetThread: false,
        dueAt: Date.now(),
        reason: 'routine Connect scheduling wake',
      };
      bridge.fireHeartbeat = vi.fn(async () => undefined);
      bridge.startExecution = vi.fn(async () => undefined);

      await bridge.processQueue();

      expect(bridge.fireHeartbeat).toHaveBeenCalledOnce();
      expect(bridge.startExecution).not.toHaveBeenCalled();
      expect(bridge.messageQueue).toHaveLength(2);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('starts a selected heartbeat once, then preserves the queued DM for the next boundary', async () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.messageQueue = [
        { clientId: 'connect:zen-probe', content: '[kai] PLAT-4945 healthy response probe' },
      ];
      bridge.pendingHeartbeatCheckpoint = {
        observationRetry: false,
        resetThread: false,
        dueAt: Date.now(),
        reason: 'routine Connect scheduling wake',
      };
      bridge.executeMessage = vi.fn(async () => undefined);
      bridge.startExecution = vi.fn(async () => undefined);

      // Production order: the safe-boundary arbiter selects the due checkpoint
      // while an ordinary direct DM is already queued. The selected heartbeat
      // must start rather than synchronously re-pending and re-entering itself.
      await bridge.processQueue();

      expect(bridge.executeMessage).toHaveBeenCalledOnce();
      expect(bridge.pendingHeartbeatCheckpoint).toBeNull();
      expect(bridge.messageQueue).toHaveLength(1);
      expect(bridge.startExecution).not.toHaveBeenCalled();

      // Simulate the heartbeat's terminal boundary. The preserved DM is the
      // next top-level attempt and must be delivered exactly once.
      bridge.activeThreadId = null;
      await bridge.processQueue();

      expect(bridge.startExecution).toHaveBeenCalledOnce();
      expect(bridge.startExecution).toHaveBeenCalledWith(
        'connect:zen-probe',
        '[kai] PLAT-4945 healthy response probe',
        undefined,
        undefined,
      );
      expect(bridge.messageQueue).toEqual([]);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('drains already-admitted direct work, then latches ready without starting a successor heartbeat', async () => {
    const { bridge, cwd } = schedulerFixture();
    try {
      bridge.activeThreadId = 'current-turn';
      bridge.messageQueue = [
        { clientId: 'connect:human', content: '[human] preserve this admitted message' },
      ];
      bridge.pendingHeartbeatCheckpoint = {
        observationRetry: false,
        resetThread: true,
        dueAt: Date.now(),
        reason: 'bounded autonomous queue drain follow-up',
      };
      bridge.connectClient = { stop: vi.fn(), start: vi.fn() };
      bridge.startExecution = vi.fn(async () => undefined);
      bridge.fireHeartbeat = vi.fn(async () => undefined);
      bridge.runtimeRollDrain.arm({
        requestId: 'roll-codex',
        targetImage: 'runtime:new',
        leaseMs: 60_000,
      });

      await bridge.processQueue();
      expect(bridge.startExecution).not.toHaveBeenCalled();

      bridge.activeThreadId = null;
      await bridge.processQueue();
      expect(bridge.startExecution).toHaveBeenCalledOnce();
      expect(bridge.messageQueue).toEqual([]);
      expect(bridge.runtimeRollDrain.ready).toBe(false);

      await bridge.processQueue();
      expect(bridge.runtimeRollDrain.ready).toBe(true);
      expect(bridge.connectClient.stop).toHaveBeenCalledOnce();
      expect(bridge.fireHeartbeat).not.toHaveBeenCalled();
      expect(bridge.pendingHeartbeatCheckpoint).not.toBeNull();
    } finally {
      bridge.runtimeRollDrain.dispose();
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CodexBridge app-server thread lifecycle', () => {
  function lifecycleFixture() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-lifecycle-'));
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    const child = new EventEmitter() as any;
    child.exitCode = null;
    child.stdin = { writable: true, write: vi.fn() };
    bridge.serverReady = true;
    bridge.serverProcess = child;
    bridge.codexThreadId = 'loaded-thread';
    return { bridge, child, cwd };
  }

  it('unsubscribes the loaded thread and waits for MCP cleanup before replacement', async () => {
    const { bridge, cwd } = lifecycleFixture();
    let finishUnsubscribe!: () => void;
    const unsubscribe = new Promise<Record<string, unknown>>((resolve) => {
      finishUnsubscribe = () => resolve({ status: 'unsubscribed' });
    });
    bridge.rpcRequest = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'thread/unsubscribe') return unsubscribe;
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'fresh-thread' } });
      throw new Error(`unexpected method: ${method}`);
    });

    try {
      bridge.retireCodexThread('test boundary');
      expect(bridge.codexThreadId).toBeNull();
      await vi.waitFor(() => expect(bridge.rpcRequest).toHaveBeenCalledWith(
        'thread/unsubscribe',
        { threadId: 'loaded-thread' },
      ));

      const replacement = bridge.createThread();
      await Promise.resolve();
      expect(bridge.rpcRequest).not.toHaveBeenCalledWith('thread/start', expect.anything());

      finishUnsubscribe();
      await expect(replacement).resolves.toBe('fresh-thread');
      expect(bridge.rpcRequest).toHaveBeenCalledWith('thread/start', expect.objectContaining({
        model: 'gpt-test',
      }));
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('skips an obsolete unsubscribe after app-server replacement', async () => {
    const { bridge, child, cwd } = lifecycleFixture();
    const rpcRequest = vi.fn();
    bridge.rpcRequest = rpcRequest;

    try {
      bridge.retireCodexThread('old process');
      bridge.serverProcess = new EventEmitter() as any;
      child.exitCode = 0;
      await bridge.codexThreadCleanupPromise;

      expect(rpcRequest).not.toHaveBeenCalled();
      expect(bridge.codexThreadId).toBeNull();
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('serializes the next thread behind autonomous app-server tree recycling', async () => {
    const { bridge, child, cwd } = lifecycleFixture();
    let finishRecycle!: () => void;
    const recycle = new Promise<void>((resolve) => {
      finishRecycle = resolve;
    });
    bridge.rpcRequest = vi.fn((method: string) => {
      if (method === 'thread/unsubscribe') return Promise.resolve({ status: 'unsubscribed' });
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'fresh-thread' } });
      throw new Error(`unexpected method: ${method}`);
    });
    bridge.recycleCodexAppServerAfterAutonomousThread = vi.fn(async () => recycle);

    try {
      bridge.retireCodexThread('autonomous heartbeat completed');
      await vi.waitFor(() => expect(
        bridge.recycleCodexAppServerAfterAutonomousThread,
      ).toHaveBeenCalledWith(child, 'autonomous heartbeat completed'));

      const replacement = bridge.createThread();
      await Promise.resolve();
      expect(bridge.rpcRequest).not.toHaveBeenCalledWith('thread/start', expect.anything());

      finishRecycle();
      await expect(replacement).resolves.toBe('fresh-thread');
      expect(bridge.rpcRequest).toHaveBeenCalledWith('thread/start', expect.objectContaining({
        model: 'gpt-test',
      }));
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reaps the full idle app-server process group before starting its replacement', async () => {
    const { bridge, child, cwd } = lifecycleFixture();
    bridge.pendingRequests.set('stale', { reject: vi.fn(), resolve: vi.fn() });
    bridge.signalCodexTree = vi.fn((_proc: unknown, signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        child.exitCode = 0;
        child.emit('exit', 0, 'SIGTERM');
      }
    });
    bridge.startAppServer = vi.fn(async () => {
      bridge.serverReady = true;
      bridge.serverProcess = new EventEmitter();
    });

    try {
      await bridge.recycleCodexAppServerAfterAutonomousThread(child, 'mandatory heartbeat observation retry');

      expect(bridge.signalCodexTree).toHaveBeenCalledWith(child, 'SIGTERM');
      expect(bridge.signalCodexTree).not.toHaveBeenCalledWith(child, 'SIGKILL');
      expect(bridge.pendingRequests.size).toBe(0);
      expect(bridge.startAppServer).toHaveBeenCalledOnce();
      expect(bridge.serverReady).toBe(true);
    } finally {
      bridge.store.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CodexBridge turn performance telemetry', () => {
  function telemetryFixture() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-telemetry-'));
    const bridge = new CodexBridge({ model: 'gpt-5.6-sol', cwd }) as any;
    bridge.connectClient = { sendTelemetry: vi.fn(), forwardBridgeEvent: vi.fn() };
    bridge.activeThreadId = 'execution-1';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeMessageId = 'message-1';
    return { bridge, cwd };
  }

  it('includes the latest queue-drain outcome in Connect telemetry', () => {
    const { bridge, cwd } = telemetryFixture();
    try {
      bridge.opts.agentId = 'codex-heartbeat-telemetry';
      recordHeartbeatQueueDrainOutcome('codex-heartbeat-telemetry', {
        readyTaskCount: 3,
        needsHelpAfter: 1,
        observedAt: '2026-07-16T22:40:00.000Z',
      });

      expect(bridge.buildTelemetry().heartbeat).toMatchObject({
        outcome: 'needs_help',
        needs_help: true,
        ready_task_count: 3,
        observed_at: '2026-07-16T22:40:00.000Z',
      });
    } finally {
      clearHeartbeatQueueDrainOutcomesForTests();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('measures duration from this turn, not from the previous completion or idle gap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T09:09:30.000Z'));
    const { bridge, cwd } = telemetryFixture();
    try {
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/started', params: {} });

      // Production repro: Jun waited 304s for the first model-originated event.
      vi.advanceTimersByTime(304_000);
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { id: 'reasoning-1', type: 'reasoning' } },
      });
      vi.advanceTimersByTime(1_000);
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', status: 'inProgress' } },
      });
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'item/commandExecution/outputDelta',
        params: { itemId: 'cmd-1', delta: 'all tests passed\n' },
      });
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0 } },
      });
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total: { inputTokens: 1_200, outputTokens: 240 } } },
      });
      vi.advanceTimersByTime(5_000);
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const telemetry = bridge.buildTelemetry();
      expect(telemetry.performance).toMatchObject({
        last_turn_duration_ms: 310_000,
        last_turn_ttft_ms: 304_000,
        last_turn_input_tokens: 1_200,
        last_turn_output_tokens: 240,
        last_turn_tool_calls: 1,
        last_turn_tool_failures: 0,
        last_turn_command_output_bytes: Buffer.byteLength('all tests passed\n'),
      });
      expect(telemetry.activity).toMatchObject({ state: 'idle', phase: 'idle' });
      expect(telemetry.usage.tokens_per_sec).toBe(0.8);
      expect(bridge.store.loadSession(bridge.sessionId)).toMatchObject({
        totalInputTokens: 1_200,
        totalOutputTokens: 240,
        turnCount: 1,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('separates cumulative billed input from bounded context occupancy and cache reuse', () => {
    const { bridge, cwd } = telemetryFixture();
    try {
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/started', params: {} });
      bridge.currentTurnHasOutput = true;
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            total: { inputTokens: 36_367_624, cachedInputTokens: 31_000_000, outputTokens: 62_000 },
            last: { inputTokens: 144_972, cachedInputTokens: 107_071, outputTokens: 390 },
            modelContextWindow: 400_000,
          },
        },
      });
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const telemetry = bridge.buildTelemetry();
      expect(telemetry.context).toEqual({
        used_tokens: 144_972,
        cached_input_tokens: 107_071,
        cache_pct: 73.9,
        max_tokens: 400_000,
        pct: 36.2,
      });
      expect(telemetry.performance).toMatchObject({
        last_turn_input_tokens: 144_972,
        last_turn_billed_input_tokens: 36_367_624,
        last_turn_cached_input_tokens: 107_071,
        last_turn_output_tokens: 62_000,
      });
      expect(bridge.store.loadSession(bridge.sessionId)).toMatchObject({
        totalInputTokens: 36_367_624,
        totalOutputTokens: 62_000,
        turnCount: 1,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('marks an active first-event timeout unhealthy and clears it on real model progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T10:00:00.000Z'));
    const { bridge, cwd } = telemetryFixture();
    try {
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/started', params: {} });
      vi.advanceTimersByTime(120_000);

      expect(bridge.buildTelemetry().health).toMatchObject({
        ok: false,
        turn_stalled: true,
        stall_reason: 'first_model_event_timeout',
      });

      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { id: 'reasoning-1', type: 'reasoning' } },
      });
      expect(bridge.buildTelemetry().health).toMatchObject({
        ok: true,
        turn_stalled: false,
        stall_reason: null,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('retries one ready queue stall on a clean thread, then stops at needs_help', () => {
    vi.useFakeTimers();
    clearHeartbeatQueueDrainOutcomesForTests();
    const { bridge, cwd } = telemetryFixture();
    try {
      bridge.codexThreadId = 'task-one-thread';
      bridge.serverReady = true;
      bridge.activeTurnIsHeartbeat = true;
      bridge.heartbeatToolCalls = [
        { name: 'mcp__shizuha_pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha_pulse__pulse_get_my_tasks' },
      ];
      bridge.heartbeatToolResults = [
        { content: 'No assigned alerts' },
        { content: 'Found 2 task(s)\nStatus: in_progress\nStatus: todo' },
      ];
      bridge.currentTurnHasOutput = true;
      bridge.fireHeartbeat = vi.fn();

      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });

      expect(bridge.fireHeartbeat).not.toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      expect(bridge.fireHeartbeat).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(bridge.codexThreadId).toBeNull();
      expect(bridge.fireHeartbeat).toHaveBeenCalledOnce();
      expect(bridge.fireHeartbeat).toHaveBeenCalledWith(false);

      bridge.fireHeartbeat.mockClear();
      bridge.codexThreadId = 'task-two-thread';
      bridge.activeThreadId = 'task-two-execution';
      bridge.activeThreadStartedAt = Date.now();
      bridge.activeTurnIsHeartbeat = true;
      bridge.heartbeatToolCalls = [
        { name: 'mcp__shizuha_pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha_pulse__pulse_get_my_tasks' },
      ];
      bridge.heartbeatToolResults = [
        { content: 'No assigned alerts' },
        { content: 'Found 2 task(s)\nStatus: in_progress\nStatus: todo' },
      ];
      bridge.currentTurnHasOutput = true;

      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      vi.advanceTimersByTime(1_000);

      expect(bridge.codexThreadId).toBeNull();
      expect(bridge.fireHeartbeat).not.toHaveBeenCalled();
    } finally {
      clearHeartbeatQueueDrainOutcomesForTests();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rescues an empty heartbeat with one fresh-thread observation and no warm retry', () => {
    vi.useFakeTimers();
    clearHeartbeatQueueDrainOutcomesForTests();
    const { bridge, cwd } = telemetryFixture();
    try {
      bridge.codexThreadId = 'warm-thread-that-returned-empty';
      bridge.serverReady = true;
      bridge.activeTurnIsHeartbeat = true;
      bridge.heartbeatToolCalls = [];
      bridge.heartbeatToolResults = [];
      bridge.fireHeartbeat = vi.fn();

      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      vi.advanceTimersByTime(1_000);
      expect(bridge.codexThreadId).toBeNull();
      expect(bridge.fireHeartbeat).toHaveBeenLastCalledWith(true);

      // If the single clean-thread rescue is also empty, leave the next attempt
      // to the ordinary cadence instead of burning a third full-context turn.
      bridge.fireHeartbeat.mockClear();
      bridge.activeThreadId = 'retry-execution';
      bridge.activeThreadStartedAt = Date.now();
      bridge.activeTurnIsHeartbeat = true;
      bridge.heartbeatToolCalls = [];
      bridge.heartbeatToolResults = [];
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      expect(bridge.codexThreadId).toBeNull();
      vi.advanceTimersByTime(1_000);
      expect(bridge.fireHeartbeat).not.toHaveBeenCalled();
      expect(bridge.heartbeatObservationRetryCount).toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('parseIntervalMs (PLAT-4179 rei P2)', () => {
  it('accepts a valid positive override at/above the floor', () => {
    expect(parseIntervalMs('30000', 60_000, 5_000)).toBe(30_000);
    expect(parseIntervalMs(5_000, 60_000, 5_000)).toBe(5_000); // boundary
  });

  it('falls back to the default for 0 / negative / NaN / below-floor / junk', () => {
    for (const bad of ['0', '-1', 'NaN', 'abc', '', 1, 4_999, undefined, null, Infinity]) {
      expect(parseIntervalMs(bad as unknown, 60_000, 5_000)).toBe(60_000);
    }
  });
});

describe.each(['codex app-server', 'claude child'])('%s serialized stuck recovery (PLAT-4179 rei P1)', () => {
  it('supersedes the dead child before releasing the latch and ignores its late completion', async () => {
    vi.useFakeTimers();
    let currentChild: 'old' | 'new' | null = 'old';
    let activeThread: 'old-turn' | 'new-turn' | null = 'old-turn';
    const acceptedEvents: string[] = [];
    const handleCompletion = (source: 'old' | 'new') => {
      if (isCurrentBridgeChild(source, currentChild)) acceptedEvents.push(source);
    };

    const recovery = runSerializedStuckRecovery({
      isStuck: () => activeThread === 'old-turn',
      fenceAndRestart: async () => {
        currentChild = null; // process-identity fence is installed synchronously
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        currentChild = 'new';
      },
      releaseLatch: () => { activeThread = null; },
      drainQueue: () => { activeThread = 'new-turn'; },
    });

    handleCompletion('old');
    expect(activeThread).toBe('old-turn'); // no queue release while restart is pending
    expect(acceptedEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await expect(recovery).resolves.toBe(true);
    expect(activeThread).toBe('new-turn');
    handleCompletion('old');
    handleCompletion('new');
    expect(acceptedEvents).toEqual(['new']);
  });
});

describe('CodexBridge stuck recovery lifecycle (PLAT-4179 review P1s)', () => {
  function bridgeFixture() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-4179-'));
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    const oldChild = new EventEmitter() as any;
    oldChild.exitCode = null;
    oldChild.pid = undefined;
    oldChild.stdin = { writable: true, write: vi.fn() };
    const newChild = new EventEmitter() as any;
    newChild.exitCode = null;
    newChild.stdin = { writable: true, write: vi.fn() };
    return { bridge, oldChild, newChild, cwd };
  }

  it('does not replace an over-age app-server while command output is still arriving', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));
    const { bridge, oldChild, cwd } = bridgeFixture();
    bridge.processQueue = vi.fn();
    bridge.startAppServer = vi.fn();
    bridge.serverReady = true;
    bridge.serverProcess = oldChild;
    bridge.activeThreadId = 'long-running-tests';
    bridge.activeThreadStartedAt = Date.now() - 82 * 60_000;
    bridge.activeTurnFirstModelEventAt = Date.now() - 81 * 60_000;
    bridge.activeTurnLastProgressAt = Date.now() - 20 * 60_000;
    bridge.heartbeatStuckMs = THRESHOLD;

    bridge.handleServerNotification({
      jsonrpc: '2.0',
      method: 'item/commandExecution/terminalInteraction',
      params: {},
    });
    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(false);

    expect(bridge.activeTurnLastProgressAt).toBe(Date.now());
    expect(bridge.startAppServer).not.toHaveBeenCalled();
    expect(bridge.processQueue).not.toHaveBeenCalled();
    expect(bridge.activeThreadId).toBe('long-running-tests');
    bridge.store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('holds latch and queue while an outstanding old-child RPC rejects and replacement is not ready', async () => {
    const { bridge, oldChild, newChild, cwd } = bridgeFixture();
    let replacementReady!: () => void;
    const ready = new Promise<void>((resolve) => { replacementReady = resolve; });
    const drain = vi.fn();
    const startReplacement = vi.fn(async () => {
      await ready;
      bridge.serverProcess = newChild;
      bridge.serverReady = true;
    });
    bridge.processQueue = drain;
    bridge.signalCodexTree = vi.fn();
    bridge.startAppServer = startReplacement;
    bridge.hasAuth = true;
    bridge.serverReady = true;
    bridge.serverProcess = oldChild;
    bridge.codexThreadId = 'codex-thread';
    bridge.activeThreadId = 'old-turn';
    bridge.activeThreadStartedAt = Date.now() - 2_000;
    bridge.heartbeatStuckMs = 1_000;

    const execution = bridge.executeMessage('wedged turn', 'old-turn');
    await vi.waitFor(() => expect(bridge.pendingRequests.size).toBe(1));

    const recovery = bridge.recoverStuckLatchIfDead();
    await execution; // rejected old RPC reached executeMessage's generation fence
    expect(bridge.activeThreadId).toBe('old-turn');
    expect(drain).not.toHaveBeenCalled();

    oldChild.exitCode = 0;
    oldChild.emit('exit', 0, null);
    await vi.waitFor(() => expect(startReplacement).toHaveBeenCalledTimes(1));
    expect(bridge.activeThreadId).toBe('old-turn');
    expect(drain).not.toHaveBeenCalled();

    replacementReady();
    await expect(recovery).resolves.toBe(true);
    expect(bridge.serverProcess).toBe(newChild);
    expect(bridge.activeThreadId).toBeNull();
    expect(drain).toHaveBeenCalledTimes(1);
    bridge.store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('replays one production-order alive-child/no-progress attempt, then fails loud without duplicate effects', async () => {
    const { bridge, oldChild, cwd } = bridgeFixture();
    const events: Array<Record<string, unknown>> = [];
    const replacementChildren: any[] = [];
    bridge.broadcastToThread = vi.fn((_threadId: string, event: Record<string, unknown>) => {
      events.push(event);
    });
    bridge.processQueue = vi.fn();
    bridge.signalCodexTree = vi.fn((child: any) => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    });
    bridge.startAppServer = vi.fn(async () => {
      const child = new EventEmitter() as any;
      child.exitCode = null;
      child.pid = undefined;
      child.stdin = { writable: true, write: vi.fn() };
      replacementChildren.push(child);
      bridge.serverProcess = child;
      bridge.serverReady = true;
    });
    bridge.hasAuth = true;
    bridge.serverReady = true;
    bridge.serverProcess = oldChild;
    bridge.codexThreadId = 'codex-thread-1';
    bridge.activeThreadId = 'top-level-turn';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeMessageId = 'message-1';

    const resolveOnlyPendingRpc = async (result: Record<string, unknown>) => {
      await vi.waitFor(() => expect(bridge.pendingRequests.size).toBe(1));
      const id = [...bridge.pendingRequests.keys()][0]!;
      bridge.handleServerMessage(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const emitNoProgressAttempt = () => {
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: {},
      });
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { id: 'user-message', type: 'userMessage' } },
      });
      bridge.activeThreadStartedAt = Date.now() - 121_000;
    };

    const originalExecution = bridge.executeMessage('bounded replay probe', 'top-level-turn');
    await resolveOnlyPendingRpc({ turn: { id: 'turn-1' } });
    emitNoProgressAttempt();

    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(true);
    await originalExecution;
    expect(bridge.activeThreadId).toBe('top-level-turn');
    expect(bridge.activeTurnNoProgressReplayCount).toBe(1);

    // Replay creates a fresh Codex thread, then sends the same top-level turn.
    await resolveOnlyPendingRpc({ thread: { id: 'codex-thread-2' } });
    await resolveOnlyPendingRpc({ turn: { id: 'turn-2' } });
    emitNoProgressAttempt();

    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(true);
    await vi.waitFor(() => expect(bridge.activeThreadId).toBeNull());

    expect(bridge.startAppServer).toHaveBeenCalledTimes(2);
    expect(replacementChildren).toHaveLength(2);
    expect(bridge.pendingRequests.size).toBe(0);
    expect(bridge.activeTurnNoProgressReplayCount).toBe(0);
    const session = bridge.store.loadSession(bridge.sessionId);
    expect(session.messages.filter((message: any) => message.role === 'user')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'content')).toEqual([]);
    expect(events.filter((event) => String(event.type).startsWith('tool_'))).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    bridge.store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('never replays a stalled turn after model/tool progress', async () => {
    const { bridge, cwd } = bridgeFixture();
    const events: Array<Record<string, unknown>> = [];
    bridge.broadcastToThread = vi.fn((_threadId: string, event: Record<string, unknown>) => {
      events.push(event);
    });
    bridge.processQueue = vi.fn();
    bridge.startAppServer = vi.fn(async () => {
      bridge.serverReady = true;
    });
    bridge.executeMessage = vi.fn();
    bridge.serverReady = true;
    bridge.serverProcess = null;
    bridge.activeThreadId = 'side-effecting-turn';
    bridge.activeThreadStartedAt = Date.now() - 20 * 60_000;
    bridge.activeTurnFirstModelEventAt = Date.now() - 19 * 60_000;
    bridge.activeTurnLastProgressAt = Date.now() - 16 * 60_000;
    bridge.activeTurnContent = 'do the work';
    bridge.activeTurnToolCalls = 1;
    bridge.codexActiveTurnStreamedState = true;

    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(true);

    expect(bridge.executeMessage).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      data: {
        message: expect.stringContaining('without replay to avoid duplicate side effects'),
      },
    });
    expect(bridge.activeThreadId).toBeNull();
    bridge.store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fences a first-event-stalled heartbeat and schedules one fresh canonical checkpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T05:00:00.000Z'));
    const { bridge, cwd } = bridgeFixture();
    bridge.processQueue = vi.fn();
    bridge.startAppServer = vi.fn(async () => {
      bridge.serverReady = true;
    });
    bridge.serverReady = true;
    bridge.serverProcess = null;
    bridge.activeThreadId = 'stalled-heartbeat';
    bridge.activeThreadStartedAt = Date.now() - 120_000;
    bridge.activeTurnFirstModelEventAt = null;
    bridge.activeTurnLastProgressAt = null;
    bridge.activeTurnIsHeartbeat = true;

    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(true);

    expect(bridge.startAppServer).toHaveBeenCalledOnce();
    expect(bridge.activeThreadId).toBeNull();
    expect(bridge.pendingHeartbeatCheckpoint).toMatchObject({
      reason: 'stalled heartbeat recovery (first_model_event_timeout)',
    });
    await expect(bridge.recoverStuckLatchIfDead()).resolves.toBe(false);
    expect(bridge.pendingHeartbeatCheckpoint.reason).toBe(
      'stalled heartbeat recovery (first_model_event_timeout)',
    );
    bridge.store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('drops late stderr from a superseded child before auth side effects', () => {
    const { bridge, oldChild, newChild, cwd } = bridgeFixture();
    const handleLine = vi.fn();
    bridge.handleCodexServerStderrLine = handleLine;
    bridge.serverProcess = newChild;

    bridge.handleServerStderrChunk(oldChild, Buffer.from('401 invalid bearer token\n'));
    expect(handleLine).not.toHaveBeenCalled();

    bridge.handleServerStderrChunk(newChild, Buffer.from('current child diagnostic\n'));
    expect(handleLine).toHaveBeenCalledOnce();
    expect(handleLine).toHaveBeenCalledWith('current child diagnostic');
    bridge.store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('stuck-latch recovery re-arms a stalled heartbeat (PLAT-4205 review, reika)', () => {
  // Master re-arms the heartbeat checkpoint in the releaseLatch teardown after
  // recovering a stuck HEARTBEAT turn. A conflict resolution on this branch
  // dropped that block and nothing covered it, so the loss was silent: the
  // agent would recover the latch and then go QUIET, never re-requesting the
  // heartbeat that stalled — the exact state this recovery path exists to
  // prevent.
  //
  // This is a STRUCTURAL guard, deliberately. The behavioural variant needs the
  // full RPC harness (executeMessage + pendingRequests resolution) that the
  // sibling recovery tests build, because recoverStuckLatchIfDead only settles
  // once a replacement app-server is ready. That harness tests the replay path,
  // not this teardown. What actually lost the behaviour was a MISSING CALL
  // SITE, and a call-site census is what caught it in review — so that is what
  // is pinned here.
  const source = fs.readFileSync(
    new URL('../../src/codex-bridge/index.ts', import.meta.url),
    'utf8',
  );

  it('keeps the re-arm inside the releaseLatch teardown', () => {
    // Bounded by the block's real delimiters rather than a character count --
    // a fixed window silently breaks the moment anyone adds a comment.
    const from = source.indexOf('releaseLatch: () => {');
    const to = source.indexOf('drainQueue:', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const teardown = source.slice(from, to);
    expect(teardown).toContain('if (stuckWasHeartbeat)');
    expect(teardown).toContain('stalled heartbeat recovery');
  });

  it('keeps the re-arm CONDITIONAL on the stalled turn having been a heartbeat', () => {
    // An unconditional re-arm would spam checkpoints after every stuck
    // non-heartbeat turn, so the guard must not be "simplified" away.
    const idx = source.indexOf('stalled heartbeat recovery');
    expect(idx).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, idx - 400), idx)).toContain('if (stuckWasHeartbeat)');
  });

  it('stuckWasHeartbeat is still read by the replay path (not dead cleanup)', () => {
    // Guards the rationalisation that would justify deleting the block again.
    expect((source.match(/stuckWasHeartbeat/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('this.activeTurnIsHeartbeat = stuckWasHeartbeat;');
  });
});
