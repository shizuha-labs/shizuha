import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentProcess, shouldResetFruitlessHeartbeatSession } from '../../src/gateway/agent-process.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';
import type { Message } from '../../src/agent/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { StateStore } from '../../src/state/store.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { setDeferredTools, setOnToolResolved, toolSearchTool } from '../../src/tools/builtin/tool-search.js';
import {
  clearHeartbeatQueueDrainOutcomesForTests,
  formatHeartbeatQueueDrainOutcomeLogLine,
  getHeartbeatQueueDrainOutcome,
  ingestHeartbeatQueueDrainOutcomeLogLine,
  recordHeartbeatQueueDrainOutcome,
} from '../../src/shared/heartbeat-outcome.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ALERTS = 'mcp__shizuha-pulse__pulse_get_my_alerts';
const TASKS = 'mcp__shizuha-pulse__pulse_get_my_tasks';
const WORK = 'mcp__shizuha-pulse__pulse_get_my_work';
const COMBINED_EMPTY = [
  'Your Pulse work (alerts + tasks, one snapshot). You choose what to advance.',
  '',
  '## Alerts',
  'No active alerts assigned to test@shizuha.com.',
  '',
  '## Tasks',
  'No tasks assigned to test@shizuha.com.',
].join('\n');
const COMBINED_READY = [
  'Your Pulse work (alerts + tasks, one snapshot). You choose what to advance.',
  '',
  '## Alerts',
  'No active alerts assigned to test@shizuha.com.',
  '',
  '## Tasks',
  '- **PLAT-1**: ready work',
  '  Status: open | Priority: high',
].join('\n');
const FAILED_TEXT = "I'll check for any pending tasks or alerts first.\n\nLet me check the current state of things — any pending tasks, alerts, or work items that need attention.";
const FAILED_REASONING = 'Let me check the current state — I should look at my task queue and any pending work. Let me check for alerts and tasks.';
const REASONING_ONLY = "Let me understand the situation. I'm receiving what appears to be an alert about a system issue. Let me check what's going on — this looks like it could be a system alert or incident that needs attention.\n\nLet me start by checking for any active alerts and understanding the current state.";
const agents: Array<{ agent: any; cwd: string }> = [];

beforeEach(() => {
  clearHeartbeatQueueDrainOutcomesForTests();
  vi.stubEnv('SHIZUHA_TALK_SUPPRESS_TOOLS', '0');
  vi.stubEnv('SHIZUHA_PREWARM_ENABLE', '0');
  vi.stubEnv('SHIZUHA_IDLE_HEARTBEAT_DISABLED', '0');
  vi.stubEnv('SHIZUHA_HEARTBEAT_MAX_OUTPUT_TOKENS', '');
});

afterEach(async () => {
  for (const { agent, cwd } of agents.splice(0)) {
    await agent.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearHeartbeatQueueDrainOutcomesForTests();
});

function harness(permissionMode = 'autonomous', resumeCwd?: string) {
  const cwd = resumeCwd ?? mkdtempSync(path.join(tmpdir(), 'gateway-tool-turn-'));
  // Exercise processMessage -> executeTurns -> executeTurnWithFallback ->
  // executeTurn and the real SQLite/wire-prefix persistence. Only external
  // provider and tool handlers are scripted; no recovery helpers are mocked.
  const agent = new AgentProcess({
    channels: [], model: 'GLM-5.3-Flash', cwd,
    permissionMode: permissionMode as 'autonomous' | 'plan', agentId: path.basename(cwd),
  }) as any;
  agents.push({ agent, cwd });
  const provider = new MockProvider();
  provider.name = 'cortex';
  const calls: string[] = [];
  const alertResults: Array<{ content: string; isError?: boolean }> = [];
  const workResults: Array<{ content: string; isError?: boolean }> = [];
  const registry = new ToolRegistry();
  for (const name of [WORK, ALERTS, TASKS, 'unexpected_read', 'unexpected_write']) {
    registry.register({
      name, description: name, parameters: z.object({}),
      readOnly: name !== 'unexpected_write', riskLevel: 'low',
      async execute() {
        calls.push(name);
        if (name === WORK) return { toolUseId: '', ...(workResults.shift() ?? { content: COMBINED_EMPTY }) };
        if (name === ALERTS) return { toolUseId: '', ...(alertResults.shift() ?? { content: 'No alerts.' }) };
        return { toolUseId: '', content: 'No tasks found.' };
      },
    });
  }
  const events: AgentEvent[] = [];
  const telemetry: Array<Record<string, any>> = [];
  const spans = { startSpan: vi.fn(() => 'test-span'), endSpan: vi.fn() };
  const channel: Channel = {
    id: 'test', type: 'http', start: vi.fn(), stop: vi.fn(),
    sendEvent: async (_threadId, event) => { events.push(event); },
    sendComplete: vi.fn(),
    sendTelemetry: (payload) => { telemetry.push(payload); },
  };
  Object.assign(agent, {
    provider, toolRegistry: registry, toolDefs: registry.definitions(),
    permissions: new PermissionEngine(permissionMode as 'autonomous' | 'plan'),
    emitter: new AgentEventEmitter(),
    spanTracker: spans,
    store: new StateStore(path.join(cwd, 'state.db')),
    maxContextTokens: 128_000, maxOutputTokens: 16_384,
    systemPrompt: 'Use the provided tools for assigned work.',
  });
  agent.registerChannel(channel);
  agent.loadEternalSession();
  const useful: Message[] = [
    { role: 'user', content: 'Keep the verified deployment receipt for task ABC-7.', timestamp: Date.now() },
    { role: 'assistant', content: 'ABC-7 deployed successfully, receipt build-42.', timestamp: Date.now() },
  ];
  if (!resumeCwd) {
    for (const message of useful) {
      agent.messages.push(message);
      agent.store.appendMessage(agent.sessionId, message);
    }
  }
  const run = async (
    id: string,
    source: InboundMessage['source'] = 'heartbeat',
    _opts?: { prefetchError?: boolean; prefetchContent?: string },
  ) => {
    // Prefetch removed 2026-09-14. The model calls Pulse or stops.
    await agent.processMessage({
    id, channelId: channel.id, channelType: channel.type, threadId: id,
    userId: 'system', content: 'Check the assigned work.', source, timestamp: Date.now(),
    });
    if (provider.callCount === 0) throw new Error(JSON.stringify(agent.recentErrors));
  };
  const history = () => agent.store.loadSession(agent.sessionId)!.messages as Message[];
  return { agent, provider, calls, alertResults, workResults, events, telemetry, spans, run, history, useful, cwd, agentId: path.basename(cwd) };
}

function tool(name: string, id = name) {
  return ResponseBuilder.withToolCalls('', [{ id, name, input: {} }]);
}

function failedNarration() {
  // Match the observed Cortex finish_reason=stop, no native calls, visible
  // narration and reasoning. Parser-discarded names cannot be guessed here.
  return [
    { type: 'reasoning_text' as const, text: FAILED_REASONING },
    ...ResponseBuilder.textOnly(FAILED_TEXT).map((chunk) => chunk.type === 'stop_reason'
      ? { ...chunk, reason: 'stop' as const } : chunk),
  ];
}

function reasoningOnly() {
  return [
    { type: 'reasoning_text' as const, text: REASONING_ONLY },
    { type: 'usage' as const, inputTokens: 100, outputTokens: 80 },
    { type: 'stop_reason' as const, reason: 'stop' as const },
    { type: 'done' as const },
  ];
}

const jsonText = (text: string) => JSON.stringify(text).slice(1, -1);

describe('gateway rejected tool-turn recovery', () => {
  it.each([
    ['reasoning-only', reasoningOnly],
    ['progress-only', failedNarration],
  ])('stops %s without a lecture or second provider call', async (_kind, response) => {
    const current = harness();
    current.provider.queueResponse(response());
    await current.run('one-shot-stop', 'user');
    expect(current.provider.callCount).toBe(1);
    expect(current.agent.getInbox().depth).toBe(0);
    expect(current.agent.getChannels()[0].sendComplete).toHaveBeenCalledWith('one-shot-stop');
    const history = JSON.stringify(current.history());
    expect(history).not.toContain('The turn is incomplete: narration did not perform the work.');
    expect(history).toContain('receipt build-42');
    expect(current.events.filter(event => event.type === 'error')).toEqual([]);
  });

  it('finishes a valid text-only response without replay when a runtime drain is armed', async () => {
    const current = harness();
    const originalChat = current.provider.chat.bind(current.provider);
    vi.spyOn(current.provider, 'chat').mockImplementation((messages, options) => {
      current.agent.armRuntimeRollDrain({ requestId: 'final-response', targetImage: 'runtime:next', leaseMs: 60_000 });
      return originalChat(messages, options);
    });
    current.provider.queueResponse(ResponseBuilder.textOnly('The verified deployment receipt is build-42.'));
    await current.run('completed-before-roll', 'user');
    expect(current.provider.callCount).toBe(1);
    expect(current.agent.getInbox().depth).toBe(0);
    expect(current.agent.getChannels()[0].sendComplete).toHaveBeenCalledWith('completed-before-roll');
  });

  it('delivers keyword-discovered arguments through the real next turn without rewriting the tool head', async () => {
    const current = harness();
    const taskName = 'mcp__shizuha-pulse__pulse_get_task';
    const taskInputs: unknown[] = [];
    current.agent.toolRegistry.register({
      name: taskName, description: 'Get a task by task_id.',
      parameters: z.object({ task_id: z.string() }), readOnly: true, riskLevel: 'low',
      async execute(input: unknown) {
        taskInputs.push(input);
        return { toolUseId: '', content: 'PLAT-8241 has a verified deployment receipt.' };
      },
    });
    current.agent.toolRegistry.register(toolSearchTool);
    const definition = current.agent.toolRegistry.definitions().find((entry: { name: string }) => entry.name === taskName)!;
    setDeferredTools(new Map([[taskName, definition]]), new Map([[taskName, {
      description: definition.description, inputSchema: definition.inputSchema,
    }]]));
    const activated = vi.fn();
    setOnToolResolved(activated);
    current.agent.toolDefs = current.agent.toolRegistry.definitions().filter((entry: { name: string }) => !entry.name.startsWith('mcp__'));
    const originalHead = JSON.stringify(current.agent.toolDefs);
    current.provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'discover', name: 'ToolSearch', input: { query: 'pulse_get_task', max_results: 1 } }]),
      ResponseBuilder.withToolCalls('', [{ id: 'inspect-task', name: taskName, input: { task_id: 'PLAT-8241' } }]),
      ResponseBuilder.textOnly('PLAT-8241 has a verified deployment receipt.'),
    );
    await current.run('schema-to-task', 'user');
    expect(activated).toHaveBeenCalledWith(definition);
    expect(JSON.stringify(current.provider.capturedMessages[1])).toContain('task_id');
    expect(JSON.stringify(current.provider.capturedMessages[1])).toContain('inputSchema');
    expect(taskInputs).toEqual([{ task_id: 'PLAT-8241' }]);
    expect(JSON.stringify(current.agent.toolDefs)).toBe(originalHead);
    const providerHead = JSON.stringify(current.provider.capturedOptions[0]!.tools);
    expect(current.provider.capturedOptions.every(options => JSON.stringify(options.tools) === providerHead)).toBe(true);
    expect(current.events.filter(event => event.type === 'error')).toEqual([]);
  });

  it('does not Cortex-force pulse_get_my_work on a heartbeat', async () => {
    const h = harness();
    h.provider.queueResponse(ResponseBuilder.textOnly('The queue is empty.'));
    await h.run('first', 'heartbeat');
    expect(h.provider.capturedOptions.map((o) => o.toolChoice)).toEqual([undefined]);
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(h.history())).toContain('The queue is empty.');
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('stops after the model calls Pulse then narrates — no inject, no retry', async () => {
    const h = harness();
    h.provider.queueResponse(tool(WORK), failedNarration());
    await h.run('after-alerts');
    expect(h.provider.capturedOptions.map((o) => o.toolChoice)).toEqual([undefined, undefined]);
    expect(h.calls).toEqual([WORK]);
    expect(h.provider.callCount).toBe(2);
    expect(JSON.stringify(h.history())).not.toContain('The turn is incomplete');
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('does not fence or prefetch pulse_get_my_work before the model turn', async () => {
    const h = harness();
    h.provider.queueResponse(ResponseBuilder.textOnly('The queue is empty.'));
    await h.run('no-prefetch');
    expect(h.calls).toEqual([]);
    expect(h.provider.capturedOptions.map((o) => o.toolChoice)).toEqual([undefined]);
    expect(JSON.stringify(h.history())).not.toContain('Combined inbox is already in this turn');
    expect(JSON.stringify(h.history())).toContain('The queue is empty.');
  });

  it('does not inject pulse_get_my_work when a heartbeat narrates without a queue snapshot', async () => {
    const h = harness();
    h.provider.queueResponse(
      ResponseBuilder.textOnly("I'm ready to help. What would you like me to do?"),
    );
    await h.run('alerts-then-narration');
    expect(h.calls).toEqual([]);
    expect(h.provider.callCount).toBe(1);
    expect(JSON.stringify(h.history())).not.toContain(COMBINED_EMPTY.split('\n')[0]);
  });

  it('does not lecture after progress-only narration', async () => {
    const h = harness();
    h.provider.queueResponse(failedNarration());
    await h.run('two-phases');
    expect(h.provider.callCount).toBe(1);
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(h.history())).not.toContain('The turn is incomplete');
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('stops on reasoning-only after a real Pulse call without treating private reasoning as the answer', async () => {
    const h = harness();
    h.provider.queueResponse(tool(WORK), reasoningOnly());
    await h.run('reasoning-only');
    expect(h.provider.callCount).toBe(2);
    expect(h.calls).toEqual([WORK]);
    expect(JSON.stringify(h.history())).not.toContain(jsonText(REASONING_ONLY));
  });

  it('resumes the durable accepted history and exact wire prefix after a process restart', async () => {
    const first = harness();
    first.provider.queueResponse(failedNarration());
    await first.run('before-restart');
    const accepted = first.history();
    const wire = first.agent.providerWirePrefix;
    await first.agent.stop();
    agents.splice(agents.findIndex(({ agent }) => agent === first.agent), 1);
    clearHeartbeatQueueDrainOutcomesForTests();
    const next = harness('autonomous', first.cwd);
    expect(next.history()).toEqual(accepted);
    expect(next.agent.providerWirePrefix).toEqual(wire);
    next.provider.queueResponse(tool(WORK), ResponseBuilder.textOnly('The queue is empty.'));
    await next.run('after-restart');
    expect(next.provider.capturedOptions.map((o) => o.toolChoice)).toEqual([undefined, undefined]);
    expect(next.provider.capturedMessages[0]!.slice(0, wire.messages.length)).toEqual(wire.messages);
    expect(JSON.stringify(next.provider.capturedMessages)).toContain('receipt build-42');
    expect(JSON.stringify(next.history())).not.toContain(jsonText(FAILED_REASONING));
    expect(next.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it.each(['unexpected_read', 'unexpected_write', 'mcp__invented__alerts'])(
    'rejects the whole constrained batch before any side effect when it includes %s', async (unexpected) => {
      const h = harness();
      const batch = ResponseBuilder.withToolCalls('', [
        { id: 'valid-first', name: WORK, input: {} },
        { id: 'unexpected-second', name: unexpected, input: {} },
      ]);
      h.provider.queueResponse(batch, batch, batch, ResponseBuilder.textOnly('The queue is empty.'));
      await h.run('mismatch');
      // Heartbeats do not Cortex-force WORK. Mixed batches are the model's
      // own tool list.
      expect(h.provider.capturedOptions.every((o) => o.toolChoice === undefined)).toBe(true);
      expect(h.provider.capturedOptions.every((o) => o.toolChoice === undefined)).toBe(true);
      expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
      expect(h.spans.endSpan).toHaveBeenCalled();
    },
  );

  it('does not advance the required phase until the tool produces a successful receipt', async () => {
    const h = harness();
    h.workResults.push({ content: 'Permission denied', isError: true }, { content: COMBINED_EMPTY });
    h.provider.queueResponse(tool(WORK, 'denied'), tool(WORK, 'allowed'), ResponseBuilder.textOnly('The queue is empty.'));
    await h.run('receipt');
    expect(h.provider.capturedOptions.every((o) => o.toolChoice === undefined)).toBe(true);
    expect(h.calls[0]).toBe(WORK);
  });

  it.each(['progress_only', 'reasoning_only'] as const)(
    'stops %s on the first no-tool turn and does not inject a successor', async (_reason) => {
      const h = harness();
      for (let i = 0; i < 2; i++) recordHeartbeatQueueDrainOutcome(h.agentId, { readyTaskCount: 5 });
      h.provider.queueResponse(tool(WORK, 'prior-work'));
      h.provider.queueResponse(_reason === 'reasoning_only' ? reasoningOnly() : failedNarration());

      await h.run('exhausted', 'heartbeat');
      expect(h.provider.callCount).toBe(2);
      expect(h.calls).toEqual([WORK]);
      expect(JSON.stringify(h.history())).not.toContain('The turn is incomplete');
      expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
      expect(h.history().slice(0, 2)).toEqual(h.useful);
      const generation = h.agent.sessionGeneration;
      const replace = vi.spyOn(h.agent.store, 'replaceMessages');

      vi.useFakeTimers();
      h.agent.running = true;
      h.agent.firstHeartbeatPending = false;
      h.agent.nextHeartbeatDueAt = 0;
      h.agent.lastActivityAt = 0;
      h.agent.hasReadyPulseWorkForIdleHeartbeat = vi.fn().mockResolvedValue({ ready: true });
      h.agent.startIdleHeartbeat();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.agent.inbox.depth).toBe(1);
      expect(replace).not.toHaveBeenCalled();
      expect(h.agent.sessionGeneration).toBe(generation);
      clearInterval(h.agent.idleHeartbeatTimer);
      h.agent.idleHeartbeatTimer = null;
      vi.useRealTimers();

      const next = await h.agent.inbox.next();
      const nextCallIndex = h.provider.callCount;
      h.provider.queueResponse(ResponseBuilder.textOnly('The queue is empty.'));
      await h.agent.processMessage(next);
      expect(h.provider.capturedOptions.slice(nextCallIndex).map((o) => o.toolChoice)).toEqual([undefined]);
      expect(JSON.stringify(h.provider.capturedMessages.at(-1))).toContain('receipt build-42');
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it('rejects a 16,384-token capped narration/repeated-reasoning turn after valid alerts without replay or session reset', async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) recordHeartbeatQueueDrainOutcome(h.agentId, { readyTaskCount: 5 });
    const repeatedReasoning = 'Check. '.repeat(4096);
    h.provider.queueResponse(tool(WORK), [
      { type: 'reasoning_text', text: repeatedReasoning },
      ...ResponseBuilder.truncated(FAILED_TEXT, { input: 100, output: 16_384 }),
    ]);
    await h.run('capped-narration', 'heartbeat');
    expect(h.provider.callCount).toBe(2); // Capped streams remain terminal, not replayed.
    expect(h.calls).toEqual([WORK]);
    expect(h.agent.store.loadSession(h.agent.sessionId).totalOutputTokens).toBe(16_484);
    for (const rejected of [FAILED_TEXT, repeatedReasoning]) expect(JSON.stringify(h.history())).not.toContain(jsonText(rejected));
    const outcome = getHeartbeatQueueDrainOutcome(h.agentId)!;
    expect(outcome.incompleteReason).toBe('progress_only');
    expect(shouldResetFruitlessHeartbeatSession(outcome)).toBe(false);
    expect(h.telemetry.at(-1)?.heartbeat).toMatchObject({ incomplete_reason: 'progress_only' });
    expect(h.events.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ error: expect.stringContaining('output-token limit') }),
    ]);
  });

  it('classifies an empty 0-tool heartbeat with ready work as reasoning_only (Nova rotator)', async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) recordHeartbeatQueueDrainOutcome(h.agentId, { readyTaskCount: 5 });
    h.provider.queueResponse(...Array.from({ length: 3 }, () => ResponseBuilder.empty()));
    await h.run('empty-ready', 'heartbeat');
    const outcome = getHeartbeatQueueDrainOutcome(h.agentId)!;
    expect(outcome.outcome).toBe('needs_help');
    expect(h.calls).toEqual([]);
  });

  it('accepts silent 0-tool heartbeat when the snapshot has no ready work', async () => {
    const h = harness();
    h.provider.queueResponse(ResponseBuilder.empty());
    await h.run('empty-idle');
    const outcome = getHeartbeatQueueDrainOutcome(h.agentId)!;
    expect(outcome.incompleteReason).toBeUndefined();
    expect(outcome.outcome).toBe('not_observed');
    expect(h.provider.callCount).toBe(1);
    expect(JSON.stringify(h.history())).not.toContain('The turn is incomplete');
  });

  it('preserves legitimate truncated human answer content', async () => {
    const h = harness();
    const partial = 'The circuit uses a series resistor to limit current. Its resistance is calculated from';
    h.provider.queueResponse(ResponseBuilder.truncated(partial));
    await h.run('partial-answer', 'user');
    expect(h.provider.callCount).toBe(1);
    expect(JSON.stringify(h.history())).toContain(jsonText(partial));
    expect(h.events.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ error: expect.stringContaining('output-token limit') }),
    ]);
  });

  it.each(['capped-before-final', 'capped-after-final', 'normal'])('keeps a %s degenerate-generation verdict out of working history and the fruitless reset path', async (mode) => {
    const h = harness();
    const repeated = Array.from({ length: 36 }, (_, i) => `Let me ${i % 2 === 0 ? 'edit the test' : 'apply the change'} now.`).join('\n\n');
    const capped = mode !== 'normal';
    h.provider.queueResponse(tool(WORK), ...Array.from({ length: 3 }, () => {
      const stop = { type: 'stop_reason' as const, reason: capped ? 'max_tokens' as const : 'stop' as const };
      const final = { type: 'final_text' as const, text: repeated };
      return [
        { type: 'usage' as const, inputTokens: 100, outputTokens: capped ? 16_384 : 500 },
        ...(mode === 'capped-after-final' ? [final, stop] : [stop, final]),
        { type: 'done' as const },
      ];
    }));
    await h.run('degenerate');
    expect(h.provider.callCount).toBe(2);
    expect(JSON.stringify(h.history())).not.toContain('Generation stopped by SCLI');
    expect(JSON.stringify(h.history())).not.toContain(jsonText(repeated));
    const outcome = getHeartbeatQueueDrainOutcome(h.agentId)!;
    expect(outcome.incompleteReason).toBe('degenerate_generation');
    expect(shouldResetFruitlessHeartbeatSession({ ...outcome, outcome: 'needs_help', readyTaskCount: 5, consecutiveReadyNoProgressHeartbeats: 3 })).toBe(false);
    expect(h.telemetry.at(-1)?.heartbeat).toMatchObject({ incomplete_reason: 'degenerate_generation' });
    expect(h.spans.endSpan).toHaveBeenCalledWith('test-span', expect.objectContaining({ incompleteReason: 'degenerate_generation' }), 'error');
  });

  it('preserves the talk-seat reasoning fallback', async () => {
    const h = harness();
    vi.stubEnv('SHIZUHA_TALK_SUPPRESS_TOOLS', '1');
    h.provider.queueResponse(reasoningOnly());
    await h.run('spoken-reasoning');
    expect(h.provider.callCount).toBe(1);
    expect(JSON.stringify(h.history())).toContain(jsonText(REASONING_ONLY));
    expect(h.events.some((e) => e.type === 'content' && e.text === REASONING_ONLY)).toBe(true);
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it.each(['ordinary', 'plan', 'talk'])('preserves valid no-tool %s responses', async (mode) => {
    const h = harness(mode === 'plan' ? 'plan' : 'autonomous');
    if (mode === 'talk') vi.stubEnv('SHIZUHA_TALK_SUPPRESS_TOOLS', '1');
    const text = mode === 'ordinary' ? 'The answer is 42.' : FAILED_TEXT;
    h.provider.queueResponse(ResponseBuilder.textOnly(text));
    await h.run('valid', mode === 'ordinary' ? 'user' : 'heartbeat');
    expect(h.provider.callCount).toBe(1);
    expect(h.provider.capturedOptions[0]?.toolChoice).toBe(mode === 'talk' ? 'none' : undefined);
    expect(JSON.stringify(h.history())).toContain(jsonText(text));
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
  });
});
