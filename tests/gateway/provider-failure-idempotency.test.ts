import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';
import { StateStore } from '../../src/state/store.js';

const sendConnectDm = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/platform/connect-dm.js', () => ({ sendConnectDm }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { AgentProcess } = await import('../../src/gateway/agent-process.js');

type Harness = AgentProcess & {
  sessionId: string;
  store: StateStore;
  messages: Array<{ role: string; content: unknown; executionId?: string }>;
  executeTurns: ReturnType<typeof vi.fn>;
  processMessage(msg: InboundMessage): Promise<void>;
  loadEternalSession(): void;
};

const tempDirs: string[] = [];
afterEach(() => {
  sendConnectDm.mockClear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('provider failure terminal outcome idempotency (PLAT-4616)', () => {
  it('rehydrates one durable terminal in a fresh process, then permits healthy recovery', async () => {
    const events: Array<Record<string, unknown>> = [];
    const channel: Channel = {
      id: 'connect',
      type: 'connect',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn(async (_threadId, event) => { events.push(event as unknown as Record<string, unknown>); }),
      sendComplete: vi.fn(),
    };
    const cwd = mkdtempSync(path.join(tmpdir(), 'plat-4616-restart-'));
    tempDirs.push(cwd);
    const dbPath = path.join(cwd, '.shizuha-state.db');
    const config = { channels: [], model: 'test', cwd, permissionMode: 'autonomous' as const, agentId: 'zen-restart-test' };
    const message = (id: string): InboundMessage => ({
      id, channelId: 'connect', channelType: 'connect', threadId: 'thread-1',
      userId: 'zen', userName: 'zen', content: 'continue', timestamp: Date.now(), source: 'user',
    });

    const first = new AgentProcess(config) as unknown as Harness;
    first.registerChannel(channel);
    first.store = new StateStore(dbPath);
    first.loadEternalSession();
    first.executeTurns = vi.fn().mockRejectedValueOnce(new Error('provider unavailable'));
    await first.processMessage(message('first'));
    first.store.close();

    // Production restart boundary: a fresh process and fresh StateStore reload the
    // serialized session before the next top-level failure is handled.
    const restarted = new AgentProcess(config) as unknown as Harness;
    restarted.registerChannel(channel);
    restarted.store = new StateStore(dbPath);
    restarted.loadEternalSession();
    restarted.executeTurns = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(undefined);
    await restarted.processMessage(message('second'));
    await restarted.processMessage(message('healthy'));

    const stored = restarted.store.loadSession(restarted.sessionId);
    const terminals = stored?.messages.filter(
      (m) => m.role === 'assistant' && String(m.content).includes('🔴 ANDON'),
    ) ?? [];
    expect(terminals).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error' && event.terminal === true)).toHaveLength(1);
    expect(sendConnectDm).toHaveBeenCalledTimes(1);
    expect(first.executeTurns).toHaveBeenCalledTimes(1);
    expect(restarted.executeTurns).toHaveBeenCalledTimes(2);
    restarted.store.close();
  });
});
