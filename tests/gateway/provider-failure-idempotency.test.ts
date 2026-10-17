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
const { messagesToChat, assembleWireChatMessages } = await import('../../src/agent/turn.js');

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
    const telemetry: Array<Record<string, any>> = [];
    const channel: Channel = {
      id: 'connect',
      type: 'connect',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn(async (_threadId, event) => { events.push(event as unknown as Record<string, unknown>); }),
      sendComplete: vi.fn(),
      sendTelemetry: (payload) => { telemetry.push(payload); },
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
    expect(telemetry.at(-1)?.activity).toMatchObject({ phase: 'idle', state: 'idle' });
    expect(telemetry.at(-1)?.health.recent_errors).toContain('provider unavailable');
    const persistedFailure = first.store.loadSession(first.sessionId)!.messages.find(m =>
      m.role === 'assistant' && String(m.content).includes('🔴 ANDON'))!;
    expect((persistedFailure as any).operationalEvent).toMatchObject({
      kind: 'framework_terminal_failure', code: 'provider_failure',
    });
    expect(messagesToChat([persistedFailure])).toEqual([]);
    expect(assembleWireChatMessages([persistedFailure], {
      sourceCount: 1, messages: [{ role: 'assistant', content: String(persistedFailure.content) }],
    })).toEqual({ chatMessages: [], usedWirePrefix: false });
    expect(first.store.loadTranscriptMessages(first.sessionId).some(m =>
      (m as any).operationalEvent?.id === (persistedFailure as any).operationalEvent.id)).toBe(true);
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
  it('keeps framework failures in durable history while real healthy wire and compaction exclude them', async () => {
    const http = await import('node:http');
    const { VLlmProvider } = await import('../../src/provider/vllm.js');
    const { compactMessages } = await import('../../src/state/compaction.js');
    const posted: any[] = [];
    let fail = true;
    let summary = false;
    const summaryText = '<summary>' + 'Implemented the original task in app.ts, verified tests and retained the pending review. '.repeat(60) + '</summary>';
    const server = http.createServer(async (request, response) => {
      if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [] })); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      posted.push(JSON.parse(body));
      if (fail) {
        // This regression needs a terminal failure; typed temporary503s now retain input.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'invalid_request_error', message: 'fixture rejected request' } }));
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: summary ? summaryText : 'healthy response' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const cwd = mkdtempSync(path.join(tmpdir(), 'operational-wire-')); tempDirs.push(cwd);
    const db = path.join(cwd, 'state.db');
    const config = { channels: [], model: 'test', cwd, permissionMode: 'autonomous' as const, agentId: 'operational-wire' };
    const channel: any = { id: 'test', type: 'http', start: vi.fn(), stop: vi.fn(), sendEvent: vi.fn(async () => {}), sendComplete: vi.fn() };
    const message = (id: string): InboundMessage => ({ id, channelId: 'test', channelType: 'http', threadId: id,
      userId: 'operator', content: 'Continue the implementation in app.ts and run tests.', timestamp: Date.now(), source: 'user' });
    const provider = new VLlmProvider(`http://127.0.0.1:${(server.address() as any).port}`, 128000, 'fixture', 'cortex');
    const runWire = (agent: any) => async () => {
      for await (const _ of provider.chat(assembleWireChatMessages(agent.messages, agent.providerWirePrefix).chatMessages, { model: 'test', maxTokens: 100 })) { /* consume real HTTP */ }
    };
    let agent: any;
    try {
      agent = new AgentProcess(config); agent.registerChannel(channel); agent.store = new StateStore(db); agent.loadEternalSession();
      agent.executeTurns = runWire(agent);
      await agent.processMessage(message('failed'));
      const terminal = agent.messages.find((m: any) => m.role === 'assistant' && String(m.content).includes('provider/runtime unavailable'));
      expect(terminal).toBeDefined();
      expect(channel.sendEvent).toHaveBeenCalledWith('failed', expect.objectContaining({ type: 'error', terminal: true }));
      agent.store.saveWirePrefix(agent.sessionId, agent.messages.length, JSON.stringify(messagesToChat(agent.messages.map((m: any) => ({ ...m, operationalEvent: undefined })))));
      agent.store.close();
      fail = false;
      agent = new AgentProcess(config); agent.registerChannel(channel); agent.store = new StateStore(db); agent.loadEternalSession(); agent.executeTurns = runWire(agent);
      // A real model-authored paraphrase remains model context: no text heuristic.
      const paraphrase = { role: 'assistant' as const, content: 'ANDON: my model-authored explanation remains evidence.', timestamp: Date.now() };
      agent.messages.push(paraphrase); agent.store.appendMessage(agent.sessionId, paraphrase);
      await agent.processMessage(message('healthy'));
      expect(posted.at(-1).messages.some((m: any) => m.content === terminal.content)).toBe(false);
      expect(posted.at(-1).messages.some((m: any) => m.content === paraphrase.content)).toBe(true);
      summary = true;
      await compactMessages([...agent.messages, { role: 'assistant', content: 'Implemented app.ts and verified the pending review. '.repeat(2000) }, { role: 'user', content: 'recent task' }], provider, 'test', 128000, { force: true });
      expect(JSON.stringify(posted.at(-1))).not.toContain(terminal.content);
      expect(JSON.stringify(posted.at(-1))).toContain(paraphrase.content);
      const archived = agent.store.loadTranscriptMessages(agent.sessionId);
      expect(archived.find((m: any) => m.operationalEvent?.id === terminal.operationalEvent.id)?.content).toBe(terminal.content);
      fail = true;
      await agent.processMessage(message('failed-again'));
      expect(agent.store.loadTranscriptMessages(agent.sessionId).filter((m: any) => m.operationalEvent)).toHaveLength(2);
    } finally {
      agent?.store.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('preserves wrong-role, malformed, and unknown provenance as conversation content', async () => {
    const { modelConversationMessages } = await import('../../src/agent/message-provenance.js');
    const valid = { kind: 'framework_terminal_failure', id: 'event', code: 'provider_failure' };
    const rows: any[] = [
      { role: 'user', content: 'user evidence', operationalEvent: valid },
      ...[null, {}, { ...valid, id: '' }, { ...valid, id: 42 },
        { ...valid, kind: 'unknown' }, { ...valid, code: 'unknown' }]
        .map((operationalEvent, i) => ({ role: 'assistant', content: `ordinary evidence ${i}`, operationalEvent })),
    ];
    expect(modelConversationMessages(rows)).toBe(rows);
    expect(messagesToChat(rows).map(message => message.content)).toEqual(rows.map(message => message.content));
    const cwd = mkdtempSync(path.join(tmpdir(), 'operational-invalid-')); tempDirs.push(cwd);
    const file = path.join(cwd, 'state.db');
    const store = new StateStore(file);
    const session = store.createSession('test', cwd);
    store.appendMessage(session.id, { role: 'assistant', content: 'corrupt metadata preserves text', timestamp: 1 });
    const { default: Database } = await import('better-sqlite3');
    const writer = new Database(file);
    writer.prepare('UPDATE messages SET operational_event=? WHERE session_id=?').run('{invalid', session.id);
    writer.close();
    const loaded = store.loadSession(session.id)!.messages;
    expect(messagesToChat(loaded)[0]?.content).toBe('corrupt metadata preserves text');
    expect(loaded[0]?.operationalEvent).toBeUndefined();
    store.close();
  });

  it('adds provenance without inventing it for historical or concurrent legacy writers', async () => {
    const { default: Database } = await import('better-sqlite3');
    const cwd = mkdtempSync(path.join(tmpdir(), 'operational-legacy-')); tempDirs.push(cwd);
    const file = path.join(cwd, 'state.db');
    let store = new StateStore(file);
    const session = store.createSession('test', cwd);
    const legacyText = '🔴 ANDON: provider/runtime unavailable after bounded fallback attempts. Stopping this turn terminally; not retrying, redispatching, or sending repeated generic fallback messages.';
    store.appendMessage(session.id, { role: 'assistant', content: legacyText, timestamp: 10 });
    store.close();
    const old = new Database(file);
    old.exec('DROP TRIGGER archive_active_message_insert; ALTER TABLE messages DROP COLUMN operational_event; ALTER TABLE session_message_transcript DROP COLUMN operational_event;');
    old.close();
    store = new StateStore(file);
    const legacy = new Database(file);
    // The original pre-upgrade INSERT runs on a distinct live connection.
    legacy.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)')
      .run(session.id, 'assistant', legacyText, 11);
    legacy.close();
    const rows = store.loadSession(session.id)!.messages;
    expect(rows).toHaveLength(2);
    expect(rows.every(message => message.operationalEvent === undefined)).toBe(true);
    expect(messagesToChat(rows)).toHaveLength(2);
    expect(store.loadTranscriptMessages(session.id).every(message => message.operationalEvent === undefined)).toBe(true);
    const typed: any = { role: 'assistant', content: legacyText, timestamp: 12,
      operationalEvent: { kind: 'framework_terminal_failure', id: 'typed-event', code: 'provider_failure' } };
    store.appendMessage(session.id, typed);
    store.replaceMessages(session.id, [typed]);
    expect(store.loadSession(session.id)!.messages[0]?.operationalEvent).toEqual(typed.operationalEvent);
    expect(store.loadTranscriptMessages(session.id).some(message => message.operationalEvent?.id === 'typed-event')).toBe(true);
    const fork = store.forkSession(session.id)!;
    expect(fork.messages[0]?.operationalEvent).toEqual(typed.operationalEvent);
    store.close();
  });

  it('releases admission before publishing idle and never overwrites a queued next turn', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'gateway-completion-order-'));
    tempDirs.push(cwd);
    const telemetry: Array<Record<string, any>> = [];
    const agent: any = new AgentProcess({ channels: [], model: 'test', cwd,
      permissionMode: 'autonomous', agentId: 'completion-order-test' });
    agent.store = new StateStore(path.join(cwd, 'state.db'));
    agent.loadEternalSession();
    agent.registerChannel({ id: 'test', type: 'http', start: vi.fn(), stop: vi.fn(),
      sendEvent: vi.fn(async () => {}), sendComplete: vi.fn(),
      sendTelemetry: (payload: Record<string, any>) => { telemetry.push(payload); },
    });
    const message = (id: string): InboundMessage => ({ id, channelId: 'test', channelType: 'http',
      threadId: id, userId: 'operator', content: 'continue', source: 'user', timestamp: Date.now() });
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    agent.executeTurns = vi.fn()
      .mockRejectedValueOnce(new Error('provider_pool_dry'))
      .mockImplementationOnce(async () => {
        agent.emitTelemetry();
        agent.telemetryFlusher.soon();
        await blocked;
      });
    agent.inbox.push(message('first'));
    agent.inbox.push(message('next'));
    agent.inboxMessageAdmitted = true;
    await agent.processAdmittedInboxMessage(await agent.inbox.next());
    expect(agent.inboxMessageAdmitted).toBe(false);
    expect(telemetry.at(-1)?.activity).toMatchObject({ state: 'idle', phase: 'idle', queue_depth: 1 });
    agent.inboxMessageAdmitted = true;
    const next = agent.processAdmittedInboxMessage(await agent.inbox.next());
    await vi.waitFor(() => expect(agent.executeTurns).toHaveBeenCalledTimes(2));
    expect(telemetry.at(-1)?.activity.state).toBe('working');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(telemetry.at(-1)?.activity.state).toBe('working');
    finish();
    await next;
    expect(telemetry.at(-1)?.activity).toMatchObject({ state: 'idle', phase: 'idle' });
    agent.telemetryFlusher.stop();
    agent.store.close();
  });

});
