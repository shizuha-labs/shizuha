import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeTurn } from '../../src/agent/turn.js';
import { StateStore, type ToolAttemptIdentity } from '../../src/state/store.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolContext, ToolResult } from '../../src/tools/types.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';
import type { HookEngine } from '../../src/hooks/engine.js';
import type { ToolRetryConfig } from '../../src/agent/tool-retry.js';

let directory: string;
let store: StateStore;
let identity: ToolAttemptIdentity;
let context: ToolContext;
let provider: MockProvider;
let registry: ToolRegistry;
let handler: ReturnType<typeof vi.fn>;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'tool-journal-'));
  store = new StateStore(path.join(directory, 'state.db'));
  store.createSessionWithId('session', 'model', directory);
  identity = { sessionId: 'session', generation: 'turn', ownerId: 'owner', inboundMessageId: 'inbound', executionId: 'thread', sessionEpoch: 0 };
  context = { sessionId: 'session', cwd: directory, executionJournal: {
    generation: 'turn',
    begin: (toolId, name, input, invocation) => store.beginToolAttempt(identity, toolId, name, input, invocation),
    complete: (toolId, invocation, result) => store.completeToolAttempt(identity, toolId, invocation, result),
    interrupt: (toolId, invocation, result) => store.completeToolAttempt(identity, toolId, invocation, result, true),
  } };
  provider = new MockProvider();
  registry = new ToolRegistry();
  handler = vi.fn(async () => ({ toolUseId: '', content: 'actual result' }));
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }); });
function register(readOnly = false) {
  registry.register({ name: 'action', description: 'Fixture', parameters: z.object({ value: z.string() }), readOnly,
    riskLevel: 'low', execute: handler as any });
  provider.queueResponse(ResponseBuilder.withToolCalls('', [{ id: 'call', name: 'action', input: { value: 'exact input' } }]));
}
function run(signal?: AbortSignal, hooks?: HookEngine, retry?: ToolRetryConfig) {
  return executeTurn([{ role: 'user', content: 'Do the work' }], provider, 'model', 'system', registry.definitions(),
    registry, new PermissionEngine('autonomous'), new AgentEventEmitter(), context, 16384, 0,
    undefined, hooks, undefined, signal, undefined, undefined, undefined, retry);
}

describe('actual handler write-ahead checkpoint', () => {
  it.each([false, true])('prevents execution when beginning the durable attempt fails (readOnly=%s)', async (readOnly) => {
    register(readOnly);
    vi.spyOn(store, 'beginToolAttempt').mockImplementation(() => { throw new Error('disk unavailable'); });
    await expect(run()).rejects.toMatchObject({ code: 'TOOL_CHECKPOINT_FAILED' });
    expect(handler).not.toHaveBeenCalled();
    expect(provider.callCount).toBe(1);
  });

  it.each([false, true])('commits exact identity/input before execution and completion before returning (readOnly=%s)', async (readOnly) => {
    register(readOnly);
    handler.mockImplementation(async () => {
      const attempt = (store as any).db.prepare('SELECT * FROM session_tool_attempts').get();
      const turn = (store as any).db.prepare('SELECT * FROM session_tool_turns').get();
      expect(attempt).toMatchObject({ tool_call_id: 'call', state: 'running', input_json: '{"value":"exact input"}' });
      expect(turn).toMatchObject({ owner_id: 'owner', inbound_message_id: 'inbound', execution_id: 'thread', session_epoch: 0 });
      return { toolUseId: '', content: 'actual result' };
    });
    const result = await run();
    expect(result.toolResults[0]!.content).toBe('actual result');
    const saved = (store as any).db.prepare('SELECT * FROM session_tool_attempts').get();
    expect(saved.state).toBe('completed');
    expect(JSON.parse(saved.result_json)).toMatchObject({ toolUseId: 'call', content: 'actual result' });
  });

  it('does not return success or retry when saving completion fails', async () => {
    register();
    vi.spyOn(store, 'completeToolAttempt').mockImplementation(() => { throw new Error('disk unavailable'); });
    await expect(run()).rejects.toMatchObject({ code: 'TOOL_CHECKPOINT_FAILED' });
    expect(handler).toHaveBeenCalledTimes(1);
    const recovered = store.recoverToolTurns('session', 'successor', 0);
    expect(JSON.stringify(recovered)).toContain('Outcome is unknown');
    expect(JSON.stringify(recovered)).not.toContain('actual result');
  });

  it('does not claim an aborted uncooperative handler finished or accept its late result', async () => {
    register();
    const abort = new AbortController();
    let finish: (result: ToolResult) => void = () => {};
    handler.mockImplementation(() => new Promise<ToolResult>((resolve) => {
      finish = resolve;
      queueMicrotask(() => abort.abort());
    }));
    const result = await run(abort.signal);
    expect(result.toolResults[0]).toMatchObject({ isError: true, metadata: { executionOutcome: 'unknown', interrupted: true } });
    expect((store as any).db.prepare('SELECT state FROM session_tool_attempts').get().state).toBe('interrupted');
    finish({ toolUseId: 'call', content: 'late result' });
    await new Promise((resolve) => setImmediate(resolve));
    const saved = (store as any).db.prepare('SELECT * FROM session_tool_attempts').get();
    expect(saved.state).toBe('interrupted');
    expect(saved.result_json).not.toContain('late result');
  });

  it('records every existing transient retry and retains prior side-effect uncertainty on recovery', async () => {
    register();
    handler.mockRejectedValueOnce(new Error('ECONNRESET after possible write'));
    const result = await run(undefined, undefined, { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.toolResults[0]!.content).toBe('actual result');
    const rows = (store as any).db.prepare('SELECT * FROM session_tool_attempts ORDER BY invocation').all();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].result_json)).toMatchObject({ isError: true, content: expect.stringContaining('possible write') });
    expect(JSON.parse(rows[1].result_json)).toMatchObject({ content: 'actual result' });
    expect(JSON.stringify(store.recoverToolTurns('session', 'successor', 0))).toContain('earlier attempts may also have produced side effects');
  });

  it('keeps the actual result through the existing post-hook string environment contract', async () => {
    register();
    handler.mockResolvedValue({ toolUseId: '', content: 'actual result', metadata: { receipt: 'unchanged' } });
    const hooks = {
      hasHooks: (event: string) => event === 'PostToolUse',
      runHooks: vi.fn(async (_event: string, environment: Record<string, string>) => {
        expect(environment['TOOL_RESULT']).toBe('actual result');
        environment['TOOL_RESULT'] = 'not a replacement result';
        return [{ stdout: 'not a replacement result', stderr: '', exitCode: 0, blocked: false }];
      }),
    } as unknown as HookEngine;
    const result = await run(undefined, hooks);
    const saved = JSON.parse((store as any).db.prepare('SELECT result_json FROM session_tool_attempts').get().result_json);
    expect(hooks.runHooks).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({ toolUseId: 'call', content: result.toolResults[0]!.content, metadata: result.toolResults[0]!.metadata });
    expect(saved.content).toBe('actual result');
  });
});
