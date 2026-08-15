import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type DrainHarness = AgentProcess & {
  inbox: {
    busy: boolean;
    depth: number;
    push(message: InboundMessage): void;
    tryPush(message: InboundMessage): boolean;
    next(): Promise<InboundMessage>;
  };
  inboxMessageAdmitted: boolean;
  checkpointRuntimeRollAfterTurn(message: InboundMessage, continuing: boolean): boolean;
  markRuntimeRollReadyIfIdle(): boolean;
  processMessage(message: InboundMessage): Promise<void | false>;
  processInboxMessage(message: InboundMessage): Promise<void>;
  store: { markDeferredRecoveryMessageReplayed: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  sessionId: string;
};

function message(id: string): InboundMessage {
  return {
    id,
    channelId: 'connect',
    channelType: 'shizuha-ws',
    threadId: `thread-${id}`,
    userId: 'operator',
    content: 'continue current work',
    timestamp: Date.now(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Shizuha gateway runtime-roll drain', () => {
  it('fences every capable ingress before advertising protocol-v2 readiness', async () => {
    const agent = new AgentProcess({ channels: [], cwd: '/tmp', permissionMode: 'autonomous' }) as unknown as DrainHarness;
    const fence = vi.fn();
    const resume = vi.fn();
    const channel = {
      id: 'connect',
      type: 'connect',
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      sendEvent: vi.fn(async () => undefined),
      sendComplete: vi.fn(),
      fenceRuntimeRollIngress: fence,
      resumeRuntimeRollIngress: resume,
    } as Channel;
    agent.registerChannel(channel);

    expect(agent.armRuntimeRollDrain({
      requestId: 'roll-nagi-fenced',
      targetImage: 'runtime:fenced',
      leaseMs: 60_000,
    })).toMatchObject({
      protocol: 2,
      state: 'ready',
      acceptingTurns: false,
      busy: false,
      pendingAcceptedTurns: 0,
      ingressFenced: true,
      admissionVersion: 0,
    });
    expect(fence).toHaveBeenCalledOnce();
    expect(agent.inbox.tryPush(message('must-replay-upstream'))).toBe(false);
    expect(agent.runtimeRollDrainSnapshot()).toMatchObject({
      protocol: 2,
      ingressFenced: true,
      admissionVersion: 0,
    });

    await agent.stop();
  });

  it('yields continuous tool work at one persisted boundary and retains the exact admitted row', async () => {
    const agent = new AgentProcess({ channels: [], cwd: '/tmp', permissionMode: 'autonomous' }) as unknown as DrainHarness;
    const admitted = message('accepted-1');
    agent.inbox.busy = true;
    agent.inboxMessageAdmitted = true;

    expect(agent.armRuntimeRollDrain({
      requestId: 'roll-nagi-4c1d92',
      targetImage: 'runtime:4c1d92',
      leaseMs: 60_000,
    })).toMatchObject({ state: 'draining', busy: true, acceptingTurns: true });

    // Production order: one executeTurn finishes its tools, appends assistant +
    // tool-result rows, emits turn_complete, then checks the drain before the
    // next model turn. The exact row is retained instead of execution-completed.
    expect(agent.checkpointRuntimeRollAfterTurn(admitted, true)).toBe(true);
    expect(agent.runtimeRollDrainSnapshot()).toMatchObject({
      state: 'draining',
      pendingAcceptedTurns: 1,
    });

    // Ready is impossible until processMessage/processInboxMessage unwind the
    // admitted stack. This prevents a contradictory ready+busy controller proof.
    expect(agent.markRuntimeRollReadyIfIdle()).toBe(false);
    agent.inbox.busy = false;
    agent.inboxMessageAdmitted = false;
    expect(agent.markRuntimeRollReadyIfIdle()).toBe(true);
    expect(agent.runtimeRollDrainSnapshot()).toMatchObject({
      state: 'ready',
      busy: false,
      acceptingTurns: false,
      pendingAcceptedTurns: 1,
    });
    expect((await agent.inbox.next()).id).toBe('accepted-1');
    await agent.stop();
  });

  it('does not acknowledge a deferred exact row before replacement or replay succeeds', async () => {
    const agent = new AgentProcess({ channels: [], cwd: '/tmp', permissionMode: 'autonomous' }) as unknown as DrainHarness;
    const admitted = message('accepted-2');
    admitted.metadata = {
      expensiveTurnDeferredEpisodeId: 'episode-1',
      expensiveTurnDeferredMessageId: 'accepted-2',
    };
    const ack = vi.fn();
    agent.sessionId = 'session-1';
    agent.store = { markDeferredRecoveryMessageReplayed: ack, close: vi.fn() };
    agent.processMessage = vi.fn(async () => false);

    await agent.processInboxMessage(admitted);

    expect(agent.processMessage).toHaveBeenCalledWith(admitted);
    expect(ack).not.toHaveBeenCalled();
    await agent.stop();
  });
});
