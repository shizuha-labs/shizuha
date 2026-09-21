import path from 'node:path';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import { StateStore } from '../../src/state/store.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { AuditLogger } from '../../src/security/audit.js';
import { MockProvider, ResponseBuilder } from './mock-provider.js';
import { z } from 'zod';

const directory = process.argv[2]!;
const cycle = Number(process.argv[3]);
const nonzeroEpoch = process.argv[4] === 'epoch';
const heartbeat = process.argv[4] === 'heartbeat';
const agent: any = new AgentProcess({ channels: [], model: 'GLM-5.3-Flash', cwd: directory,
  permissionMode: 'autonomous', agentId: 'durable-crash-test' });
const provider = new MockProvider();
const registry = new ToolRegistry();
const calls: string[] = [];
const auditEvents: Array<Record<string, unknown>> = [];
const snapshot = () => ({
  cycle, calls, providerCalls: provider.callCount,
  sessionEpoch: agent.sessionGeneration,
  request: provider.capturedMessages[0],
  history: agent.store.loadSession(agent.sessionId).messages,
  attempts: agent.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_tool_attempts'").get()
    ? agent.store.db.prepare('SELECT * FROM session_tool_attempts ORDER BY rowid').all() : [],
  auditEvents,
  inboundCompleted: agent.store.inboundProcessingCompleted(agent.sessionId, 'accepted-inbound'),
});
registry.register({ name: 'write', description: 'Inert receipt fixture', parameters: z.object({ step: z.string() }), readOnly: false, riskLevel: 'low',
  async execute(input: { step: string }) {
    calls.push(input.step);
    if (input.step.startsWith('done')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { toolUseId: '', content: `actual receipt ${input.step}` };
    }
    process.send?.({ event: 'pending', ...snapshot() });
    return new Promise(() => {});
  },
});
if (heartbeat) registry.register({ name: 'mcp__shizuha-pulse__pulse_get_my_work', description: 'Inert heartbeat fixture', parameters: z.object({}), readOnly: true, riskLevel: 'low',
  async execute() {
    calls.push('heartbeat');
    process.send?.({ event: 'pending', ...snapshot() });
    return new Promise(() => {});
  },
});
Object.assign(agent, { provider, toolRegistry: registry, toolDefs: registry.definitions(),
  permissions: new PermissionEngine('autonomous'), emitter: new AgentEventEmitter(),
  store: new StateStore(path.join(directory, 'state.db')), auditLogger: new AuditLogger(directory),
  maxContextTokens: 128000, maxOutputTokens: 16384, systemPrompt: 'Use tools for assigned work.' });
const before = agent.auditLogger.logBefore.bind(agent.auditLogger);
const after = agent.auditLogger.logAfter.bind(agent.auditLogger);
agent.auditLogger.logBefore = (...args: any[]) => { auditEvents.push({ phase: 'before', calls: [...calls] }); return before(...args); };
agent.auditLogger.logAfter = (...args: any[]) => { auditEvents.push({ phase: 'after', calls: [...calls], durationMs: args[4] }); return after(...args); };
agent.registerChannel({ id: 'test', type: 'connect', start: async () => {}, stop: async () => {},
  sendEvent: async () => {}, sendComplete: async () => {}, ackProcessed: async () => true });
agent.loadEternalSession();
if (nonzeroEpoch && cycle === 1) {
  agent.store.beginExpensiveTurnRecovery(agent.sessionId, 'prior-recovery', 0, 0, [], { preserved: 0, coalesced: 0, dropped: 0, deferred: 0, replayed: 0 });
  agent.store.commitExpensiveTurnSuccessor(agent.sessionId, 'prior-recovery', [], 'fixture');
  agent.store.recordExpensiveTurnRecoveryAttempt(agent.sessionId, 'prior-recovery', 'queue_empty', 'verified');
  agent.loadEternalSession();
}
if (cycle === 4) {
  const finalize = agent.store.finalizeToolTurn.bind(agent.store);
  agent.store.finalizeToolTurn = (...args: any[]) => {
    const messages = finalize(...args);
    process.send?.({ event: 'committed', memory: [...agent.messages], ...snapshot() });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return messages;
  };
}
if (cycle === 6) agent.auditLogger.logBefore = () => { throw new Error('audit unavailable'); };
if (!heartbeat && (cycle <= 2 || cycle === 6)) provider.queueResponse(ResponseBuilder.withToolCalls('', [
  { id: `done-${cycle}`, name: 'write', input: { step: `done-${cycle}` } },
  { id: `pending-${cycle}`, name: 'write', input: { step: `pending-${cycle}` } },
]));
else provider.queueResponse(ResponseBuilder.textOnly(heartbeat ? 'The tool outcome is unknown; current state must be inspected.' : 'The saved receipts are retained; interrupted side effects require inspection.'));
await agent.processInboxMessage({ id: 'accepted-inbound', channelId: 'test', channelType: 'connect', threadId: 'thread',
  userId: 'test', content: 'Advance assigned work.', source: heartbeat ? 'heartbeat' : 'user', timestamp: 1000 });
process.send?.({ event: 'completed', ...snapshot() });
await agent.stop();
process.disconnect?.();
