import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import { StateStore } from '../../src/state/store.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { estimateOverheadTokens, needsCompaction } from '../../src/prompt/context.js';
import type { Message } from '../../src/agent/types.js';
import * as compaction from '../../src/state/compaction.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

vi.mock('../../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/platform/pulse-self-availability.js', () => ({ markPulseSelfAvailability: vi.fn(async () => {}) }));
const agents = new Map<any, string>();
afterEach(async () => {
  for (const [agent, directory] of agents) { await agent.stop(); rmSync(directory, { recursive: true, force: true }); }
  agents.clear(); vi.restoreAllMocks();
});

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gateway-wire-budget-'));
  const agent: any = new AgentProcess({ channels: [], model: 'GLM-5.3-Flash', cwd: directory, permissionMode: 'autonomous', agentId: path.basename(directory) });
  agents.set(agent, directory);
  const provider = new MockProvider();
  const registry = new ToolRegistry();
  const channel = { id: 'test', type: 'http', start: vi.fn(), stop: vi.fn(), sendEvent: vi.fn(async () => {}), sendComplete: vi.fn() };
  Object.assign(agent, { provider, toolRegistry: registry, toolDefs: [], permissions: new PermissionEngine('autonomous'),
    emitter: new AgentEventEmitter(), store: new StateStore(path.join(directory, 'state.db')),
    maxContextTokens: 32768, maxOutputTokens: 4096, systemPrompt: 'Keep verified receipts.',
    prewarmPrefixCache: vi.fn(async () => false), prewarmManagedGrokFallbackPrefix: vi.fn(async () => {}), flushPreCompactionMemory: vi.fn(async () => {}),
  });
  agent.registerChannel(channel); agent.loadEternalSession(); agent.bindStoreWirePrefixInvalidation();
  const source: Message[] = [
    { id: 'capture', role: 'assistant', content: [{ type: 'tool_use', id: 'screenshot', name: 'capture', input: {} }], timestamp: 1 },
    { id: 'receipt', role: 'user', content: [{ type: 'tool_result', toolUseId: 'screenshot', content: 'Verified screenshot receipt',
      image: { base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'.repeat(4000), mediaType: 'image/png' } }], timestamp: 2 },
  ];
  const seed = () => { agent.messages = structuredClone(source); agent.store.replaceMessages(agent.sessionId, source); agent.lastReportedPromptTokens = 0; agent.lastReportedRawEstimateTokens = 0; };
  const run = (id: string) => agent.processMessage({ id, channelId: 'test', channelType: 'http', threadId: id,
    userId: 'test', content: 'Report the verified receipt.', source: 'user', timestamp: Date.now() });
  return { agent, provider, channel, source, seed, run };
}

describe('gateway wire-budget compaction trigger', () => {
  it('uses the exact wire assertion to trigger semantic compaction before the provider on two re-arms', async () => {
    const current = harness();
    const semantic = needsCompaction(current.source, 32768, 'GLM-5.3-Flash', estimateOverheadTokens(current.agent.systemPrompt, [], 'GLM-5.3-Flash'), 4096, 0, 0);
    const wire = (AgentProcess as any).inspectContextBudget(current.source, 'GLM-5.3-Flash', 32768, current.agent.systemPrompt, [], 4096, 0);
    expect(semantic).toBe(false);
    expect(wire.exceeded).toBe(true);
    const compact = vi.spyOn(compaction, 'compactMessagesRequired').mockImplementation(async (messages) => ({
      messages: [{ role: 'assistant', content: 'Verified receipts are preserved in the accepted summary.', timestamp: 1 }, messages.at(-1)!],
      compacted: true,
    }));
    for (const cycle of [1, 2]) {
      current.seed();
      current.provider.queueResponse(ResponseBuilder.textOnly('The verified receipt is unchanged.'));
      await current.run(`input-${cycle}`);
      expect(compact).toHaveBeenCalledTimes(cycle);
      expect(current.provider.callCount).toBe(cycle);
      expect(JSON.stringify(current.provider.capturedMessages[cycle - 1])).toContain('accepted summary');
      expect(current.agent.maxContextTokens).toBe(32768);
      expect(current.agent.maxOutputTokens).toBe(4096);
    }
  });

  it('retains the source and refuses the provider if required semantic compaction fails', async () => {
    const current = harness(); current.seed();
    vi.spyOn(compaction, 'compactMessagesRequired').mockRejectedValue(new Error('semantic qualification failed'));
    await current.run('failed-summary');
    expect(current.provider.callCount).toBe(0);
    expect(current.agent.messages.slice(0, current.source.length)).toEqual(current.source);
    expect(current.agent.store.loadSession(current.agent.sessionId).messages.slice(0, current.source.length)).toEqual(current.source);
  });
});
