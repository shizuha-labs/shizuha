import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import { Inbox } from '../../src/gateway/inbox.js';
import { ExpensiveTurnGuard } from '../../src/agent/expensive-turn-guard.js';
import { StateStore } from '../../src/state/store.js';
import { recordHeartbeatQueueDrainTurn } from '../../src/daemon/heartbeat-outcome.js';
import { MockProvider } from '../helpers/mock-provider.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * SCLI-415 Fixture A — a verified episode's replay must not re-trip the guard.
 *
 * Production order only: seed the deferred ledger, verify via the real
 * bootstrap path (`processInboxMessage` -> `finishExpensiveTurnRecoveryBootstrap`),
 * then drain through the inbox exactly as the runtime does. Driving the pump
 * directly would not reproduce the regression, which lived in the ordering.
 */

const AGENT_ID = 'ni-s415';

function channel(id = 'ch-1'): Channel {
  return {
    id,
    type: 'http',
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
    sendComplete: vi.fn(),
    onMessage: vi.fn(),
  } as unknown as Channel;
}

function inbound(id: string, source: InboundMessage['source'], content: string): InboundMessage {
  return {
    id,
    channelId: 'ch-1',
    channelType: 'http',
    threadId: `thread-${id}`,
    userId: source === 'user' ? 'human-1' : 'system',
    userName: source === 'user' ? 'Hritik' : 'system',
    content,
    timestamp: Date.now(),
    source,
  } as InboundMessage;
}

describe('SCLI-415 deferred drain — production-order fixtures A and B', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli415-'));
    store = new StateStore(path.join(dir, 'state.db'));
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function wiredAgent(sessionId: string): any {
    const provider = new MockProvider();
    const agent = new AgentProcess({
      channels: [],
      model: 'cortex/DeepSeek-V4-Flash',
      cwd: dir,
      permissionMode: 'autonomous',
      agentId: AGENT_ID,
      agentName: AGENT_ID,
    }) as any;
    agent.store = store;
    agent.sessionId = sessionId;
    agent.messages = [...(store.loadSession(sessionId)?.messages ?? [])];
    agent.systemPrompt = 'You are a test agent.';
    agent.toolDefs = [];
    agent.maxContextTokens = 32_000;
    agent.provider = provider;
    agent.providerReg = {
      resolve: () => provider,
      resolveWithModel: () => ({ provider, model: agent.model }),
      get: () => provider,
    };
    agent.modelFallbacks = [];
    agent.pinnedFallbackIndex = 0;
    agent.inbox = new Inbox();
    agent.channels = new Map([['ch-1', channel()]]);
    // Live production shape: minTurns=8 / window=120s (agent-ni env override),
    // shrunk in absolute terms so the derived spacing stays test-sized while
    // the RATIO that determines self-trip safety is unchanged.
    agent.expensiveTurnGuard = new ExpensiveTurnGuard({
      enabled: true,
      windowMs: 800,
      minTurns: 8,
      minPromptTokens: 1_000,
      minPromptOutputRatio: 10,
      baseBackoffMs: 5_000,
      maxBackoffMs: 10_000,
      notifyCooldownMs: 60_000,
    });
    agent.notifyExpensiveTurnGuard = vi.fn(async () => {});
    agent.notifyExpensiveTurnRecoveryOutcome = vi.fn(async () => {});
    agent.running = true;
    return agent;
  }

  it('drains >=11 mixed rows with exactly one ack each and no second guard episode', async () => {
    const sessionId = 'sess-a';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);

    const episodeId = 'ep-a';
    // 11 valid rows, alternating human/system, plus one structurally invalid row.
    const valid = Array.from({ length: 11 }, (_, i) => {
      const isHuman = i % 2 === 0;
      const msg = inbound(`m-${i}`, isHuman ? 'user' : 'heartbeat', `deferred body ${i}`);
      return {
        messageId: msg.id,
        messageClass: isHuman ? 'human' : 'heartbeat',
        payload: JSON.stringify(msg),
      };
    });
    const invalid = { messageId: 'm-bad', messageClass: 'human', payload: '{"id":"MISMATCH"}' };

    store.beginExpensiveTurnRecovery(
      sessionId, episodeId, 185, 120_000,
      [...valid, invalid] as never,
      { preserved: 12, coalesced: 0, dropped: 0, deferred: 12, replayed: 0 } as never,
    );
    store.commitExpensiveTurnSuccessor(
      sessionId, episodeId,
      [{ role: 'user', content: '[System Recovery Capsule]', timestamp: Date.now() }] as never,
      'clean_successor_created_timeout',
    );

    const agent = wiredAgent(sessionId);
    agent.executeTurns = vi.fn(async () => {
      recordHeartbeatQueueDrainTurn(AGENT_ID, {
        toolCalls: [
          { name: 'mcp__shizuha_pulse__pulse_get_my_alerts', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_get_my_tasks', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_add_comment', input: { task_id: 'SCLI-415' } },
        ],
        toolResults: [
          { content: 'No active assigned alerts.', isError: false },
          { content: 'Found 1 task(s) — 1 actionable\n- SCLI-415', isError: false },
          { content: 'Comment added', isError: false },
        ],
      });
    });

    // Production order: verify through the real bootstrap path.
    const bootstrap = inbound('bootstrap', 'heartbeat', '[Recovery] verify progress');
    (bootstrap as any).metadata = { expensiveTurnRecoveryEpisodeId: episodeId };
    await agent.processInboxMessage(bootstrap);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.state).toBe('verified');

    // Every replayed row is a high-prompt turn — the exact shape that tripped
    // SCLI-195 when the whole FIFO was released at once.
    agent.executeTurns = vi.fn(async () => {
      agent.expensiveTurnGuard.record({ now: Date.now(), inputTokens: 120_000, outputTokens: 400 });
    });

    const maxReleasingSeen: number[] = [];
    for (let i = 0; i < valid.length; i += 1) {
      const next = await agent.inbox.next();
      const ledger = store.countDeferredRecoveryMessagesByState(sessionId, episodeId);
      maxReleasingSeen.push(ledger.releasing);
      await agent.processInboxMessage(next);
    }

    // must-never #2: at most ONE row is ever `releasing` — the anti-ratchet.
    expect(Math.max(...maxReleasingSeen)).toBeLessThanOrEqual(1);

    const finalLedger = store.countDeferredRecoveryMessagesByState(sessionId, episodeId);
    expect(finalLedger.replayed).toBe(valid.length);       // exactly one ack each
    expect(finalLedger.releasing).toBe(0);                 // drain converged
    expect(finalLedger.deferred).toBe(1);                  // the invalid row, untouched

    // must-never #3: replay alone never satisfied the guard.
    expect(agent.expensiveTurnGuard.remainingPauseMs()).toBe(0);
    // Queue idles: nothing further was handed over.
    expect(agent.inbox.depth).toBe(0);

    await agent.stop();
  }, 20_000);

  /**
   * SCLI-415 Fixture A2 (reika P1 / ichi's cadence pin) — a replay row that
   * makes tool calls costs MORE THAN ONE guard sample.
   *
   * `record()` lives inside the per-turn loop (agent-process.ts:3535), so a row
   * with one tool call contributes 2 samples. A limiter denominated in ROWS
   * therefore delivers `turnsPerRow x (minTurns - 1)` samples per window and
   * replay self-trips mid-drain. ichi pinned this in advance: "a row-count-only
   * limiter is not a complete proof".
   *
   * This fixture FAILS against row-only spacing and passes once admission is
   * denominated in guard samples.
   */
  it('does not self-trip when replayed rows take multiple tool turns', async () => {
    const sessionId = 'sess-multi';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);

    const episodeId = 'ep-multi';
    const rows = Array.from({ length: 11 }, (_, i) => {
      const msg = inbound(`t-${i}`, i % 2 === 0 ? 'user' : 'heartbeat', `multi ${i}`);
      return {
        messageId: msg.id,
        messageClass: i % 2 === 0 ? 'human' : 'heartbeat',
        payload: JSON.stringify(msg),
      };
    });

    store.beginExpensiveTurnRecovery(
      sessionId, episodeId, 185, 120_000, rows as never,
      { preserved: 11, coalesced: 0, dropped: 0, deferred: 11, replayed: 0 } as never,
    );
    store.commitExpensiveTurnSuccessor(
      sessionId, episodeId,
      [{ role: 'user', content: '[System Recovery Capsule]', timestamp: Date.now() }] as never,
      'clean_successor_created_timeout',
    );

    const agent = wiredAgent(sessionId);
    agent.executeTurns = vi.fn(async () => {
      recordHeartbeatQueueDrainTurn(AGENT_ID, {
        toolCalls: [
          { name: 'mcp__shizuha_pulse__pulse_get_my_alerts', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_get_my_tasks', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_add_comment', input: { task_id: 'SCLI-415' } },
        ],
        toolResults: [
          { content: 'No active assigned alerts.', isError: false },
          { content: 'Found 1 task(s) — 1 actionable\n- SCLI-415', isError: false },
          { content: 'Comment added', isError: false },
        ],
      });
    });

    const bootstrap = inbound('bootstrap-multi', 'heartbeat', '[Recovery] verify progress');
    (bootstrap as any).metadata = { expensiveTurnRecoveryEpisodeId: episodeId };
    await agent.processInboxMessage(bootstrap);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.state).toBe('verified');

    // THE POINT: each replayed row is a tool-calling turn plus its follow-up,
    // i.e. TWO expensive guard samples — the ordinary shape for the heartbeat
    // and human messages that populate this feed.
    agent.executeTurns = vi.fn(async () => {
      agent.expensiveTurnGuard.record({ now: Date.now(), inputTokens: 120_000, outputTokens: 400 });
      agent.expensiveTurnGuard.record({ now: Date.now(), inputTokens: 140_000, outputTokens: 400 });
    });

    for (let i = 0; i < rows.length; i += 1) {
      const next = await agent.inbox.next();
      await agent.processInboxMessage(next);
      // Replay must never satisfy the guard on its own, at ANY point mid-drain.
      expect(agent.expensiveTurnGuard.remainingPauseMs()).toBe(0);
    }

    const ledger = store.countDeferredRecoveryMessagesByState(sessionId, episodeId);
    expect(ledger.replayed).toBe(rows.length);
    expect(ledger.releasing).toBe(0);
    expect(agent.expensiveTurnGuard.remainingPauseMs()).toBe(0);

    await agent.stop();
  }, 30_000);

  /**
   * SCLI-415 (reika residual P2) — replay must not push a window FOREGROUND
   * already filled over the trip point.
   *
   * The uncovered path: a process whose first replay row has never been
   * measured, dispatching into a window that foreground traffic has partly
   * consumed. With an optimistic reserve seed of 2 and budget 7, five live
   * foreground samples admit the row (5 + 2 = 7, not > 7), and a 3-turn row
   * reaches 8 and trips. A2 cannot see this because it starts from an EMPTY
   * window — the same structural blindness the old Fixture A had for the P1.
   *
   * This pre-seeds the window, so it FAILS against an optimistic seed.
   */
  it('does not trip when dispatching into a window foreground has already filled', async () => {
    const sessionId = 'sess-seeded';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);

    const episodeId = 'ep-seeded';
    const rows = Array.from({ length: 4 }, (_, i) => {
      const msg = inbound(`p-${i}`, 'heartbeat', `seeded ${i}`);
      return { messageId: msg.id, messageClass: 'heartbeat', payload: JSON.stringify(msg) };
    });

    store.beginExpensiveTurnRecovery(
      sessionId, episodeId, 185, 120_000, rows as never,
      { preserved: 4, coalesced: 0, dropped: 0, deferred: 4, replayed: 0 } as never,
    );
    store.commitExpensiveTurnSuccessor(
      sessionId, episodeId,
      [{ role: 'user', content: '[System Recovery Capsule]', timestamp: Date.now() }] as never,
      'clean_successor_created_timeout',
    );

    const agent = wiredAgent(sessionId);
    agent.executeTurns = vi.fn(async () => {
      recordHeartbeatQueueDrainTurn(AGENT_ID, {
        toolCalls: [{ name: 'mcp__shizuha_pulse__pulse_get_my_alerts', input: {} },
                    { name: 'mcp__shizuha_pulse__pulse_get_my_tasks', input: {} },
                    { name: 'mcp__shizuha_pulse__pulse_add_comment', input: { task_id: 'SCLI-415' } }],
        toolResults: [{ content: 'No active assigned alerts.', isError: false },
                      { content: 'Found 1 task(s) — 1 actionable\n- SCLI-415', isError: false },
                      { content: 'Comment added', isError: false }],
      });
    });

    // FOREGROUND fills most of the window BEFORE the feed is released — this is
    // the ordering that matters. Seeding after release would let the first row
    // be admitted into an empty window, which is a different (legitimate) path.
    // Budget is minTurns-1 = 7; five expensive samples are live.
    for (let i = 0; i < 5; i += 1) {
      // Sterile high-prefill plateau (no tools, tiny text) — productive tool
      // turns no longer count toward the expensive window.
      agent.expensiveTurnGuard.record({
        now: Date.now(), inputTokens: 120_000, outputTokens: 10, toolCallCount: 0,
      });
    }
    expect(agent.expensiveTurnGuard.expensiveSamplesInWindow()).toBe(5);
    expect(agent.expensiveTurnGuard.remainingPauseMs()).toBe(0);

    const bootstrap = inbound('bootstrap-seeded', 'heartbeat', '[Recovery] verify progress');
    (bootstrap as any).metadata = { expensiveTurnRecoveryEpisodeId: episodeId };
    await agent.processInboxMessage(bootstrap);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.state).toBe('verified');

    // Each replay row is the ordinary 3-turn shape: call, result, answer.
    agent.executeTurns = vi.fn(async () => {
      // Append-only growth + tools: must not self-trip during paced replay.
      for (const tokens of [120_000, 130_000, 140_000]) {
        agent.expensiveTurnGuard.record({
          now: Date.now(), inputTokens: tokens, outputTokens: 40, toolCallCount: 1,
        });
      }
    });

    for (let i = 0; i < rows.length; i += 1) {
      const next = await agent.inbox.next();
      await agent.processInboxMessage(next);
      // Replay must never push the shared window over the trip point.
      expect(agent.expensiveTurnGuard.remainingPauseMs()).toBe(0);
    }

    expect(store.countDeferredRecoveryMessagesByState(sessionId, episodeId).replayed).toBe(rows.length);
    await agent.stop();
  }, 40_000);

  /**
   * SCLI-415 (reika P2) — the teardown fix needs a gate, not an observation.
   *
   * A pump timer firing after stop() reaches a closed StateStore and throws
   * from a timer callback: an UNCAUGHT exception, i.e. a shutdown crash. Its
   * only prior proof was the absence of a vitest `Errors` line in a
   * neighbouring suite, so deleting the clearTimeout would have failed nothing.
   */
  it('cancels a pending replay timer on stop() so it cannot fire post-teardown', async () => {
    const sessionId = 'sess-stop';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    const episodeId = 'ep-stop';
    const rows = Array.from({ length: 3 }, (_, i) => {
      const msg = inbound(`s-${i}`, 'heartbeat', `row ${i}`);
      return { messageId: msg.id, messageClass: 'heartbeat', payload: JSON.stringify(msg) };
    });
    store.beginExpensiveTurnRecovery(
      sessionId, episodeId, 10, 1_000, rows as never,
      { preserved: 3, coalesced: 0, dropped: 0, deferred: 3, replayed: 0 } as never,
    );

    const agent = wiredAgent(sessionId);
    // Arm the pump directly on a verified episode, then force it to SCHEDULE
    // rather than dispatch by making the guard report a full window.
    agent.deferredReplayEpisodeId = episodeId;
    // Fill the sterile-expensive window to budget without tripping (minTurns=8 → 7 ok).
    for (let i = 0; i < 7; i += 1) {
      agent.expensiveTurnGuard.record({
        now: Date.now(), inputTokens: 120_000, outputTokens: 10, toolCallCount: 0,
      });
    }
    expect(agent.expensiveTurnGuard.remainingPauseMs()).toBe(0);
    agent.pumpDeferredReplay();
    expect(agent.deferredReplayTimer).not.toBeNull();

    await agent.stop();

    // The gate: the timer is cancelled and the episode cleared, so nothing can
    // reach the store after it closes.
    expect(agent.deferredReplayTimer).toBeNull();
    expect(agent.deferredReplayEpisodeId).toBeNull();

    // And the pump is inert afterwards even if something calls it again.
    store.close();
    expect(() => agent.pumpDeferredReplay()).not.toThrow();
  }, 20_000);

  /**
   * SCLI-415 Fixture B — a fence partway through the drain must not strand a
   * bulk `releasing` block in the successor generation.
   *
   * This is the ratcheting half of the live report: each fence reclassified a
   * still-`releasing` batch, so rows accumulated faster than they were
   * acknowledged (releasing=65 vs replayed=8) while backoff grew each cycle.
   */
  it('survives a fence mid-drain with no bulk releasing, preserving FIFO and one ack per row', async () => {
    const sessionId = 'sess-b';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);

    const episodeId = 'ep-b';
    const rows = Array.from({ length: 11 }, (_, i) => {
      const isHuman = i % 2 === 0;
      const msg = inbound(`b-${i}`, isHuman ? 'user' : 'heartbeat', `deferred body ${i}`);
      return { messageId: msg.id, messageClass: isHuman ? 'human' : 'heartbeat', payload: JSON.stringify(msg) };
    });

    store.beginExpensiveTurnRecovery(
      sessionId, episodeId, 185, 120_000, rows as never,
      { preserved: 11, coalesced: 0, dropped: 0, deferred: 11, replayed: 0 } as never,
    );
    store.commitExpensiveTurnSuccessor(
      sessionId, episodeId,
      [{ role: 'user', content: '[System Recovery Capsule]', timestamp: Date.now() }] as never,
      'clean_successor_created_timeout',
    );

    const agent = wiredAgent(sessionId);
    agent.executeTurns = vi.fn(async () => {
      recordHeartbeatQueueDrainTurn(AGENT_ID, {
        toolCalls: [
          { name: 'mcp__shizuha_pulse__pulse_get_my_alerts', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_get_my_tasks', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_add_comment', input: { task_id: 'SCLI-415' } },
        ],
        toolResults: [
          { content: 'No active assigned alerts.', isError: false },
          { content: 'Found 1 task(s) — 1 actionable\n- SCLI-415', isError: false },
          { content: 'Comment added', isError: false },
        ],
      });
    });

    const bootstrap = inbound('bootstrap-b', 'heartbeat', '[Recovery] verify progress');
    (bootstrap as any).metadata = { expensiveTurnRecoveryEpisodeId: episodeId };
    await agent.processInboxMessage(bootstrap);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.state).toBe('verified');

    const order: string[] = [];
    agent.executeTurns = vi.fn(async () => {});

    // Drain only PART of the feed, then interrupt.
    for (let i = 0; i < 4; i += 1) {
      const next = await agent.inbox.next();
      order.push(next.id);
      await agent.processInboxMessage(next);
    }

    // --- the fence: the process is torn down mid-drain ---
    // A real fence kills the process while the state DB FILE survives and the
    // successor reopens it, so tear down only the in-memory pump here. Calling
    // stop() would close the shared store and make the successor unable to read
    // the very ledger this fixture is asserting on.
    agent.running = false;
    if (agent.deferredReplayTimer) { clearTimeout(agent.deferredReplayTimer); agent.deferredReplayTimer = null; }
    agent.deferredReplayEpisodeId = null;
    agent.inbox.clear();

    const midLedger = store.countDeferredRecoveryMessagesByState(sessionId, episodeId);
    // The whole point: no bulk `releasing` block survives the interruption.
    expect(midLedger.releasing).toBeLessThanOrEqual(1);
    expect(midLedger.replayed).toBe(4);
    // Untouched rows are still plain `deferred`, i.e. cleanly re-drainable.
    expect(midLedger.deferred).toBe(11 - 4 - midLedger.releasing);

    // --- successor generation resumes and drains the remainder ---
    const successor = wiredAgent(sessionId);
    successor.executeTurns = vi.fn(async () => {});
    await successor.resumeExpensiveTurnRecoveryAtStartup();

    while (store.countDeferredRecoveryMessagesByState(sessionId, episodeId).replayed < rows.length) {
      const ledger = store.countDeferredRecoveryMessagesByState(sessionId, episodeId);
      expect(ledger.releasing).toBeLessThanOrEqual(1);   // still no ratchet
      const next = await successor.inbox.next();
      order.push(next.id);
      await successor.processInboxMessage(next);
    }

    const finalLedger = store.countDeferredRecoveryMessagesByState(sessionId, episodeId);
    expect(finalLedger.replayed).toBe(rows.length);   // exactly one ack per row
    expect(finalLedger.releasing).toBe(0);
    expect(finalLedger.deferred).toBe(0);

    // FIFO preserved ACROSS the fence, and no row replayed twice.
    expect(order).toEqual(rows.map((r) => r.messageId));
    expect(new Set(order).size).toBe(order.length);

    await successor.stop();
  }, 30_000);
});
