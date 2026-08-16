import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentSession,
  resolveTuiPreflightCeilingTokens,
  resolveTuiPreflightGuardTokens,
} from '../../src/tui/session.js';
import type { AgentEvent } from '../../src/events/types.js';
import * as turnModule from '../../src/agent/turn.js';
import { estimateTokens } from '../../src/prompt/context.js';

describe('AgentSession', () => {
  let session: AgentSession;

  beforeEach(() => {
    session = new AgentSession();
  });

  afterEach(async () => {
    await session.destroy();
  });

  describe('resolveTuiPreflightGuardTokens', () => {
    it('scales guard tokens from the active context window', () => {
      expect(resolveTuiPreflightGuardTokens(8_192, {} as NodeJS.ProcessEnv)).toBe(1_024);
      expect(resolveTuiPreflightGuardTokens(32_768, {} as NodeJS.ProcessEnv)).toBe(4_096);
      expect(resolveTuiPreflightGuardTokens(262_144, {} as NodeJS.ProcessEnv)).toBe(32_768);
      expect(resolveTuiPreflightGuardTokens(1_000_000, {} as NodeJS.ProcessEnv)).toBe(65_536);
    });

    it('allows an operator override for emergency tuning', () => {
      expect(resolveTuiPreflightGuardTokens(262_144, {
        SHIZUHA_TUI_PREFLIGHT_GUARD_TOKENS: '49152',
      } as NodeJS.ProcessEnv)).toBe(49_152);
    });
  });

  describe('resolveTuiPreflightCeilingTokens', () => {
    it('keeps large interactive sessions under a fractional latency ceiling', () => {
      // 0.70 × announced window (not a fixed 128K) so 512K backends can use more.
      expect(resolveTuiPreflightCeilingTokens(262_144, 1_024, 32_768, {} as NodeJS.ProcessEnv))
        .toBe(Math.floor(262_144 * 0.70));
      expect(resolveTuiPreflightCeilingTokens(524_288, 1_024, 32_768, {} as NodeJS.ProcessEnv))
        .toBe(Math.floor(524_288 * 0.70));
    });

    it('allows an explicit interactive target override up to the safe context ceiling', () => {
      expect(resolveTuiPreflightCeilingTokens(262_144, 1_024, 32_768, {
        SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS: '180000',
      } as NodeJS.ProcessEnv)).toBe(180_000);
    });
  });

  describe('init', () => {
    it('initializes with default config', async () => {
      await session.init(process.cwd());
      expect(session.initialized).toBe(true);
      expect(session.model).toBeTruthy();
      expect(session.mode).toBeTruthy();
      expect(session.cwd).toBe(process.cwd());
    });

    it('sets model and mode from arguments', async () => {
      // Use a model that falls back to ollama (always available)
      await session.init(process.cwd(), 'test-local-model', 'autonomous');
      expect(session.model).toBe('test-local-model');
      expect(session.mode).toBe('autonomous');
    });

    it('sets initError when provider not configured instead of throwing', async () => {
      // Use a model prefix that maps to Google (unlikely to have GOOGLE_API_KEY)
      await session.init(process.cwd(), 'gemini-nonexistent');
      if (!process.env['GOOGLE_API_KEY']) {
        expect(session.initError).toBeTruthy();
        expect(session.initError).toContain('not configured');
        expect(session.initialized).toBe(true);
      }
    });

    it('provides list of available providers', async () => {
      await session.init(process.cwd());
      const providers = session.availableProviders();
      expect(providers).toContain('ollama'); // always available
    });

    it('treats real API prompt usage as authoritative over a cold provider estimate', async () => {
      await session.init(process.cwd(), 'DeepSeek-V4-Flash');
      const internals = session as unknown as {
        messages: Array<{ role: 'user'; content: string; timestamp: number }>;
        _lastApiInputTokens: number;
        _lastProviderPromptEstimate: number;
        _lastReportedRawPromptTokens: number;
        _systemOverheadTokens: number;
      };
      internals.messages = [{ role: 'user', content: 'provider truth baseline', timestamp: 1 }];
      internals._systemOverheadTokens = 0;
      internals._lastReportedRawPromptTokens = estimateTokens(internals.messages, 'DeepSeek-V4-Flash');
      internals._lastApiInputTokens = 326_049;
      internals._lastProviderPromptEstimate = 479_865;

      expect(session.estimatedContextTokens).toBe(326_049);
    });
  });

  describe('newSession', () => {
    it('resets session state', async () => {
      await session.init(process.cwd(), 'test-local-model');
      session.newSession();
      expect(session.currentSessionId).toBeNull();
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
      expect(session.turnCount).toBe(0);
    });

    it('emits session_new event', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const handler = vi.fn();
      session.on('session_new', handler);
      session.newSession();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('setModel', () => {
    it('switches model to ollama local model', async () => {
      await session.init(process.cwd(), 'test-local-model');
      session.setModel('another-local-model');
      expect(session.model).toBe('another-local-model');
    });

    it('emits error for misconfigured provider', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const events: AgentEvent[] = [];
      session.on('agent_event', (e: AgentEvent) => events.push(e));

      // Try to set a model that requires missing Google API key
      if (!process.env['GOOGLE_API_KEY']) {
        session.setModel('gemini-nonexistent');
        expect(events.some((e) => e.type === 'error')).toBe(true);
      }
    });
  });

  describe('setMode', () => {
    it('updates mode', async () => {
      await session.init(process.cwd(), 'test-local-model', 'supervised');
      session.setMode('autonomous');
      expect(session.mode).toBe('autonomous');
    });
  });

  describe('listSessions', () => {
    it('returns array (may be empty)', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const sessions = session.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('returns empty array before init', () => {
      const sessions = session.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('interrupt', () => {
    it('does not throw when no active turn', async () => {
      await session.init(process.cwd(), 'test-local-model');
      expect(() => session.interrupt()).not.toThrow();
    });
  });

  describe('queued input', () => {
    it('dequeues pending inputs for editing', () => {
      session.queueInput('first queued prompt');
      session.queueInput('second queued prompt');

      const queued = session.dequeuePendingInput();

      expect(queued.map((item) => item.prompt)).toEqual(['first queued prompt', 'second queued prompt']);
      expect(session.pendingInputCount).toBe(0);
      expect(session.dequeuePendingInput()).toEqual([]);
    });
  });

  describe('renameSession (SCLI-390)', () => {
    it('returns false when no durable session exists yet', async () => {
      await session.init(process.cwd(), 'test-local-model');
      // Fresh TUI: no turns → no sessionId → rename must not claim success.
      expect(session.renameSession('SCLI178_FALSE_SUCCESS_CONTROL')).toBe(false);
    });

    it('returns true and persists the name once a session exists', async () => {
      await session.init(process.cwd(), 'test-local-model');
      // Materialize a session the same way submitPrompt does.
      const created = (session as unknown as {
        store: { createSession: (model: string, cwd: string) => { id: string; name?: string } };
      }).store.createSession(session.model, session.cwd);
      (session as unknown as { sessionId: string }).sessionId = created.id;

      expect(session.renameSession('SCLI390_ACTIVE_RENAME')).toBe(true);
      const listed = session.listSessions();
      const row = listed.find((s) => s.id === created.id);
      expect(row?.name).toBe('SCLI390_ACTIVE_RENAME');
    });
  });

  describe('destroy', () => {
    it('does not throw', async () => {
      await session.init(process.cwd(), 'test-local-model');
      await expect(session.destroy()).resolves.not.toThrow();
    });

    it('does not throw before init', async () => {
      await expect(session.destroy()).resolves.not.toThrow();
    });
  });

  describe('submitPrompt', () => {
    it('throws when not initialized', async () => {
      await expect(session.submitPrompt('hello')).rejects.toThrow('not initialized');
    });

    it('keeps the agent turn alive when post-turn compaction exhausts transient 503 retries', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const events: AgentEvent[] = [];
      session.on('agent_event', (event: AgentEvent) => events.push(event));

      const messages = (session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
      messages.push({ role: 'user', content: 'inspect CTX-607' });

      const compact = vi.fn().mockRejectedValue(Object.assign(
        new Error('vLLM error 503 after 2 retries: {"error":{"code":"compaction_serialized"}}'),
        { status: 503, retryAfterMs: 45_000 },
      ));
      const runCompaction = (session as unknown as {
        runCompactionWithHeartbeat: (
          fn: typeof compact,
          provider: unknown,
          maxContextTokens: number,
          options: undefined,
          phase: 'post-turn',
        ) => Promise<{ messages: unknown[]; compacted: boolean }>;
      }).runCompactionWithHeartbeat.bind(session);

      const result = await runCompaction(compact, {}, 524_288, undefined, 'post-turn');

      expect(result.compacted).toBe(false);
      expect(result.messages).toBe(messages);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'provider_status',
        code: 'compaction_post-turn_transient_skip',
      }));
      expect(events.some((event) => event.type === 'complete')).toBe(false);
    });

    it('keeps the model gate closed across a transient compaction failure until semantic success', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const internal = session as unknown as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        ensureProvider: () => unknown;
        runCompactionWithHeartbeat: () => Promise<{ messages: unknown[]; compacted: boolean }>;
        enforceRequiredCompaction: (
          maxContextTokens: number,
          options: undefined,
          phase: 'pre-turn',
          isRequired: () => boolean,
          forceOnce: boolean,
        ) => Promise<{ compacted: boolean; attempts: number }>;
      };
      internal.messages.push(...Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `message-${index} ${'context '.repeat(200)}`,
      })));
      const original = [...internal.messages];
      const compacted = [
        { role: 'user' as const, content: '[Conversation Summary]\nsemantic summary' },
        { role: 'assistant' as const, content: 'Continuing from the summary.' },
        original.at(-1)!,
      ];
      let required = true;
      const ensureProviderSpy = vi.spyOn(internal, 'ensureProvider').mockReturnValue({});
      const maintenanceSpy = vi.spyOn(internal, 'runCompactionWithHeartbeat')
        .mockResolvedValueOnce({ messages: original, compacted: false })
        .mockImplementationOnce(async () => {
          required = false;
          return { messages: compacted, compacted: true };
        });

      const result = await internal.enforceRequiredCompaction(
        524_288,
        undefined,
        'pre-turn',
        () => required,
        true,
      );

      expect(result).toEqual({ compacted: true, attempts: 2 });
      expect(maintenanceSpy).toHaveBeenCalledTimes(2);
      expect(internal.messages).toEqual(compacted);
      expect(internal.messages.at(-1)).toBe(original.at(-1));
      ensureProviderSpy.mockRestore();
      maintenanceSpy.mockRestore();
    });

    it('still fails loud when compaction hits a permanent provider error', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const compact = vi.fn().mockRejectedValue(Object.assign(
        new Error('vLLM error 401: credentials were not provided'),
        { status: 401 },
      ));
      const runCompaction = (session as unknown as {
        runCompactionWithHeartbeat: (
          fn: typeof compact,
          provider: unknown,
          maxContextTokens: number,
          options: undefined,
          phase: 'post-turn',
        ) => Promise<{ messages: unknown[]; compacted: boolean }>;
      }).runCompactionWithHeartbeat.bind(session);

      await expect(runCompaction(compact, {}, 524_288, undefined, 'post-turn'))
        .rejects.toThrow('vLLM error 401');
    });

    it('emits error event when provider not available', async () => {
      // Use a model that requires Google API key (unlikely to be set)
      await session.init(process.cwd(), 'gemini-nonexistent');
      if (!process.env['GOOGLE_API_KEY']) {
        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));
        await session.submitPrompt('hello');
        const errorEvent = events.find((e) => e.type === 'error');
        expect(errorEvent).toBeTruthy();
        if (errorEvent && errorEvent.type === 'error') {
          expect(errorEvent.error).toContain('Cannot submit');
        }
        // Should also emit complete
        expect(events.some((e) => e.type === 'complete')).toBe(true);
      }
    });

    it('emits complete after executeTurn stream failure (prevents stuck UI processing)', async () => {
      await session.init(process.cwd(), 'test-local-model');

      const ensureProviderSpy = vi.spyOn(
        session as unknown as { ensureProvider: () => unknown },
        'ensureProvider',
      ).mockReturnValue({});

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn').mockImplementation((async () => {
        // Simulate stream-level failure after some async work.
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new Error('stream disconnected before completion');
      }) as typeof turnModule.executeTurn);

      try {
        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));

        await session.submitPrompt('hello');

        const errorEvent = events.find((e) => e.type === 'error');
        expect(errorEvent).toBeTruthy();
        if (errorEvent && errorEvent.type === 'error') {
          expect(errorEvent.error).toContain('stream disconnected before completion');
        }
        expect(events.some((e) => e.type === 'complete')).toBe(true);
      } finally {
        executeTurnSpy.mockRestore();
        ensureProviderSpy.mockRestore();
      }
    });

    it('persists an interrupt checkpoint when a turn fails before completion', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-error-checkpoint-'));
      process.env['HOME'] = tempHome;

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn').mockImplementation((async () => {
        throw new Error('mock transport failure');
      }) as typeof turnModule.executeTurn);

      let resumed: AgentSession | null = null;
      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      try {
        await session.init(process.cwd(), 'test-local-model');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        await session.submitPrompt('checkpoint-on-error');
        const interruptedSessionId = session.currentSessionId;
        expect(interruptedSessionId).toBeTruthy();

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model');
        let resumedSession: {
          interruptCheckpoint?: {
            createdAt: number;
            promptExcerpt: string;
            note: string;
          };
        } | null = null;
        resumed.on('session_resumed', (payload) => {
          resumedSession = payload as typeof resumedSession;
        });

        const ok = await resumed.resumeSession(interruptedSessionId!);
        expect(ok).toBe(true);
        expect(resumedSession?.interruptCheckpoint).toBeTruthy();
        expect(resumedSession!.interruptCheckpoint!.promptExcerpt).toContain('checkpoint-on-error');
        expect(resumedSession!.interruptCheckpoint!.note).toContain('error before completion');
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (resumed) {
          await resumed.destroy();
        }
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('continues after an empty post-tool assistant response instead of ending blank', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-empty-response-'));
      process.env['HOME'] = tempHome;

      let resumed: AgentSession | null = null;
      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check Pulse.' },
              {
                type: 'tool_use',
                id: 'pulse-call-1',
                name: 'mcp__shizuha-pulse__pulse_list_tasks',
                input: {},
              },
            ],
            timestamp: Date.now(),
          },
          toolCalls: [
            { id: 'pulse-call-1', name: 'mcp__shizuha-pulse__pulse_list_tasks', input: {} },
          ],
          toolResults: [
            { toolUseId: 'pulse-call-1', content: 'Found 8 task(s) assigned to Hritik.', isError: false },
          ],
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'tool_use',
        })) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 12,
          outputTokens: 0,
          stopReason: 'end_turn',
        })) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [{ type: 'text', text: 'You have 8 pending Pulse tasks.' }],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 14,
          outputTokens: 7,
          stopReason: 'end_turn',
        })) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'test-local-model');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));

        await session.submitPrompt('show my pending pulse tasks');

        expect(executeTurnSpy).toHaveBeenCalledTimes(3);
        expect(events.some((e) => e.type === 'complete')).toBe(true);

        const savedSessionId = session.currentSessionId;
        expect(savedSessionId).toBeTruthy();

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model');
        let resumedSession: {
          messages: Array<{ role: string; content: unknown }>;
        } | null = null;
        resumed.on('session_resumed', (payload) => {
          resumedSession = payload as typeof resumedSession;
        });

        const ok = await resumed.resumeSession(savedSessionId!);
        expect(ok).toBe(true);
        expect(resumedSession).toBeTruthy();
        expect(
          resumedSession!.messages.some(
            (m) => m.role === 'user'
              && typeof m.content === 'string'
              && m.content.includes('If a tool result is available'),
          ),
        ).toBe(false);

        const lastAssistant = [...resumedSession!.messages].reverse().find((m) => m.role === 'assistant');
        expect(lastAssistant?.content).toEqual([{ type: 'text', text: 'You have 8 pending Pulse tasks.' }]);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (resumed) {
          await resumed.destroy();
        }
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('processes a queued message at the next turn boundary during a multi-turn query (2026-08-08)', async () => {
      // Operator 2026-08-08: typing while the agent is mid-query must not wait
      // for the WHOLE multi-turn agentic loop to finish before it is processed.
      // The queued message must become the very next user turn (after a single
      // tool round), not after every turn of the previous query completes.
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-midqueue-'));
      process.env['HOME'] = tempHome;

      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      // executeTurn call order for a mid-query queue:
      //   call 1: tool_use (agent is mid-query doing a tool round) AND queues a
      //           user message (simulating typing while it works). The queued
      //           message must be drained at this turn boundary.
      //   call 2: end_turn answering the QUEUED message (the very next turn).
      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementationOnce((async (messages: Array<{ role: string; content: unknown }>) => {
          // Mid-tool-round: queue a message the user "typed while the agent worked".
          session.queueInput('check the DB too');
          return {
            assistantMessage: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Checking the first thing.' }, {
                type: 'tool_use',
                id: 'tool-1',
                name: 'bash',
                input: { command: 'echo first' },
              }],
              timestamp: Date.now(),
            },
            toolCalls: [{ id: 'tool-1', name: 'bash', input: { command: 'echo first' } }],
            toolResults: [{ toolUseId: 'tool-1', content: 'first', isError: false }],
            inputTokens: 10,
            outputTokens: 5,
            stopReason: 'tool_use',
            rawPromptTokens: 10,
            providerPromptEstimate: 10,
          };
        }) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async (messages: Array<{ role: string; content: unknown }>) => {
          // This is the NEXT turn after the tool round — it must be processing
          // the queued message, not continuing the original query.
          const lastUser = [...messages].reverse().find((m) => m.role === 'user');
          const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
          expect(lastUserText).toContain('check the DB too');
          return {
            assistantMessage: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Checked the DB as you asked.' }],
              timestamp: Date.now(),
            },
            toolCalls: [],
            toolResults: [],
            inputTokens: 12,
            outputTokens: 6,
            stopReason: 'end_turn',
            rawPromptTokens: 12,
            providerPromptEstimate: 12,
          };
        }) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'test-local-model');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));

        await session.submitPrompt('do the first thing');

        // The queued message must have been processed as its own turn, not
        // dropped or deferred until the whole query finished.
        expect(executeTurnSpy).toHaveBeenCalledTimes(2);
        expect(events.some((e) => e.type === 'complete')).toBe(true);
        expect(session.pendingInputCount).toBe(0);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('compacts inside a long tool turn before the next provider call', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-midturn-compact-'));
      process.env['HOME'] = tempHome;
      let ensureProviderSpy: ReturnType<typeof vi.spyOn> | null = null;
      const requestKinds: Array<string | undefined> = [];
      let toolRound = 0;

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementation((async (...args: Parameters<typeof turnModule.executeTurn>) => {
          const messages = args[0];
          const continuity = args[19];
          requestKinds.push(continuity?.requestKind);
          const hasSummary = messages.some(
            (message) => typeof message.content === 'string'
              && message.content.startsWith('[Conversation Summary]'),
          );
          if (hasSummary) {
            return {
              assistantMessage: { role: 'assistant', content: 'Finished after compaction.' },
              toolCalls: [],
              toolResults: [],
              inputTokens: 0,
              outputTokens: 6,
              stopReason: 'end_turn',
            };
          }

          toolRound++;
          if (toolRound > 20) throw new Error('mid-turn compaction never fired');
          const id = `tool-${toolRound}`;
          return {
            assistantMessage: {
              role: 'assistant',
              content: [{ type: 'tool_use', id, name: 'bash', input: { command: `round ${toolRound}` } }],
            },
            toolCalls: [{ id, name: 'bash', input: { command: `round ${toolRound}` } }],
            toolResults: [{
              toolUseId: id,
              content: `round ${toolRound}\n${'bounded production tool output '.repeat(1_500)}`,
              isError: false,
            }],
            inputTokens: 0,
            outputTokens: 5,
            stopReason: 'tool_use',
          };
        }) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'test-local-model');
        const provider = {
          name: 'test-vllm',
          supportsTools: true,
          supportsNativeWebSearch: false,
          maxContextWindow: 131_072,
          contextWindowFor: () => 131_072,
          // LLM-based compaction (operator 2026-08-08): pre-turn/post-turn
          // compaction uses the summarizing compaction, not the local fallback.
          chat: async function* () {
            yield { type: 'text', text: 'Test compaction summary of the tool turn. '.repeat(80) };
            yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
            yield { type: 'done' };
          },
        };
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => typeof provider },
          'ensureProvider',
        ).mockReturnValue(provider);
        const events: AgentEvent[] = [];
        session.on('agent_event', (event: AgentEvent) => events.push(event));

        await session.submitPrompt('inspect enough bounded tool output to cross the threshold');

        expect(toolRound).toBeLessThanOrEqual(20);
        expect(requestKinds).toContain('post_compaction');
        expect(events).toContainEqual(expect.objectContaining({
          type: 'provider_status',
          code: 'compaction_post-turn_complete',
        }));
        expect(events.some(
          (event) => event.type === 'error'
            && event.error.includes('dropped'),
        )).toBe(false);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('continues after progress-only narration without a tool call', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-progress-only-'));
      process.env['HOME'] = tempHome;

      let resumed: AgentSession | null = null;
      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will check Pulse first.' },
              {
                type: 'tool_use',
                id: 'pulse-root',
                name: 'bash',
                input: { command: 'curl -s http://pulse/api/' },
              },
            ],
            timestamp: Date.now(),
          },
          toolCalls: [
            { id: 'pulse-root', name: 'bash', input: { command: 'curl -s http://pulse/api/' } },
          ],
          toolResults: [
            { toolUseId: 'pulse-root', content: 'Root API is available at /shizuha-pulse/api/.', isError: false },
          ],
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'tool_use',
        })) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Good, the API is working. Let me search for tasks related to v4 and coding models.' }],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 12,
          outputTokens: 10,
          stopReason: 'end_turn',
        })) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Searching Pulse now.' },
              {
                type: 'tool_use',
                id: 'pulse-search',
                name: 'bash',
                input: { command: 'curl -s http://pulse/api/tasks/?q=v4' },
              },
            ],
            timestamp: Date.now(),
          },
          toolCalls: [
            { id: 'pulse-search', name: 'bash', input: { command: 'curl -s http://pulse/api/tasks/?q=v4' } },
          ],
          toolResults: [
            { toolUseId: 'pulse-search', content: 'Found PLAT-999: Deploy best coding model on v4.', isError: false },
          ],
          inputTokens: 14,
          outputTokens: 8,
          stopReason: 'tool_use',
        })) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Found PLAT-999: Deploy best coding model on v4.' }],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 16,
          outputTokens: 7,
          stopReason: 'end_turn',
        })) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'test-local-model', 'autonomous');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        await session.submitPrompt('find the v4 coding model task');

        expect(executeTurnSpy).toHaveBeenCalledTimes(4);
        const savedSessionId = session.currentSessionId;
        expect(savedSessionId).toBeTruthy();

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model', 'autonomous');
        let resumedSession: {
          messages: Array<{ role: string; content: unknown }>;
        } | null = null;
        resumed.on('session_resumed', (payload) => {
          resumedSession = payload as typeof resumedSession;
        });

        const ok = await resumed.resumeSession(savedSessionId!);
        expect(ok).toBe(true);
        expect(resumedSession).toBeTruthy();
        expect(
          resumedSession!.messages.some(
            (m) => m.role === 'user'
              && typeof m.content === 'string'
              && m.content.includes('only a progress update'),
          ),
        ).toBe(true);

        const lastAssistant = [...resumedSession!.messages].reverse().find((m) => m.role === 'assistant');
        expect(lastAssistant?.content).toEqual([{ type: 'text', text: 'Found PLAT-999: Deploy best coding model on v4.' }]);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (resumed) {
          await resumed.destroy();
        }
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('SCLI-388: ends idle with diagnosis after bounded first-token stall retries', async () => {
      const previousHome = process.env['HOME'];
      const previousMax = process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-first-chunk-terminal-'));
      process.env['HOME'] = tempHome;
      process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'] = '1';

      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      const stallError = Object.assign(
        new Error('vLLM no first chunk: no events for 90s'),
        { code: 'ETIMEDOUT', retryable: true },
      );
      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementation((async () => {
          throw stallError;
        }) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'test-local-model', 'autonomous');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));

        await session.submitPrompt('ping a dead model');

        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
        expect(events.some((e) => e.type === 'provider_status'
          && (e as { code?: string }).code === 'stall_timeout'
          && e.message.includes('/model'))).toBe(true);
        expect(events.some((e) => e.type === 'error'
          && e.error.includes('Provider/model timeout'))).toBe(true);
        expect(events.some((e) => e.type === 'complete')).toBe(true);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (previousMax === undefined) delete process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'];
        else process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'] = previousMax;
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('retries a retryable vLLM no-first-chunk stall instead of ending idle', async () => {
      const previousHome = process.env['HOME'];
      const previousMax = process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-first-chunk-stall-'));
      process.env['HOME'] = tempHome;
      // Allow one retry so the success path still exercises recovery.
      process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'] = '2';

      let resumed: AgentSession | null = null;
      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      const stallError = Object.assign(
        new Error('vLLM no first chunk: no events for 90s'),
        { code: 'ETIMEDOUT', retryable: true },
      );
      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementationOnce((async () => {
          throw stallError;
        }) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The agents are healthy after retry.' }],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 20,
          outputTokens: 8,
          stopReason: 'end_turn',
        })) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'test-local-model', 'autonomous');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));

        await session.submitPrompt('check if the agents are working well');

        expect(executeTurnSpy).toHaveBeenCalledTimes(2);
        expect(events.some((e) => e.type === 'error'
          && e.error.includes('Provider stream/first-token stall'))).toBe(true);
        expect(events.some((e) => e.type === 'complete')).toBe(true);

        const savedSessionId = session.currentSessionId;
        expect(savedSessionId).toBeTruthy();

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model', 'autonomous');
        let resumedSession: {
          messages: Array<{ role: string; content: unknown }>;
          interruptCheckpoint?: { reason?: string } | null;
        } | null = null;
        resumed.on('session_resumed', (payload) => {
          resumedSession = payload as typeof resumedSession;
        });

        const ok = await resumed.resumeSession(savedSessionId!);
        expect(ok).toBe(true);
        expect(resumedSession).toBeTruthy();
        expect(resumedSession!.interruptCheckpoint).toBeFalsy();

        const lastAssistant = [...resumedSession!.messages].reverse().find((m) => m.role === 'assistant');
        expect(lastAssistant?.content).toEqual([{ type: 'text', text: 'The agents are healthy after retry.' }]);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (resumed) {
          await resumed.destroy();
        }
        if (previousMax === undefined) delete process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'];
        else process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'] = previousMax;
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('persists reasoning-only max_tokens output from DeepSeek without auto-continuing', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-reasoning-only-'));
      process.env['HOME'] = tempHome;

      let resumed: AgentSession | null = null;
      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn')
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [{ type: 'reasoning', id: 'r1', rawContent: 'hidden old task content' }],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'max_tokens',
        })) as typeof turnModule.executeTurn)
        .mockImplementationOnce((async () => ({
          assistantMessage: {
            role: 'assistant',
            content: [{ type: 'reasoning', id: 'r2', rawContent: '# Reading Tracker Web App' }],
            timestamp: Date.now(),
          },
          toolCalls: [],
          toolResults: [],
          inputTokens: 12,
          outputTokens: 5,
          stopReason: 'end_turn',
        })) as typeof turnModule.executeTurn);

      try {
        await session.init(process.cwd(), 'DeepSeek-V4-Flash');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        const events: AgentEvent[] = [];
        session.on('agent_event', (e: AgentEvent) => events.push(e));

        await session.submitPrompt('who are you?');

        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
        expect(events.some((e) => e.type === 'error' && /reasoning-only/.test(e.error))).toBe(false);

        const savedSessionId = session.currentSessionId;
        expect(savedSessionId).toBeTruthy();

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'DeepSeek-V4-Flash');
        let resumedSession: {
          messages: Array<{ role: string; content: unknown }>;
        } | null = null;
        resumed.on('session_resumed', (payload) => {
          resumedSession = payload as typeof resumedSession;
        });

        const ok = await resumed.resumeSession(savedSessionId!);
        expect(ok).toBe(true);
        expect(resumedSession).toBeTruthy();
        expect(resumedSession!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
        expect(
          resumedSession!.messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('response was cut off'),
          ),
        ).toBe(false);
        expect(
          resumedSession!.messages.some(
            (m) => JSON.stringify(m.content).includes('hidden old task content'),
          ),
        ).toBe(true);
      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (resumed) await resumed.destroy();
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });
  });

  describe('resumeSession', () => {
    it('removes legacy repeated planning garbage from the active working set', () => {
      const repeated = Array.from(
        { length: 14 },
        (_, index) => `Let me ${index % 2 === 0 ? 'run the command' : 'check now'}.`,
      ).join('\n\n');
      const sanitize = (session as unknown as {
        sanitizeRecoveredTranscript: (
          messages: Array<{ role: string; content: string }>,
          model: string,
        ) => { messages: Array<{ role: string; content: string }>; removed: number };
      }).sanitizeRecoveredTranscript.bind(session);

      const result = sanitize([
        { role: 'user', content: 'finish the task' },
        { role: 'assistant', content: repeated },
      ], 'DeepSeek-V4-Flash');

      expect(result.removed).toBe(1);
      expect(result.messages).toEqual([{ role: 'user', content: 'finish the task' }]);
    });

    it('does not remove a planning-text assistant message that owns a tool call', () => {
      const repeated = Array.from(
        { length: 14 },
        (_, index) => `Let me ${index % 2 === 0 ? 'run the command' : 'check now'}.`,
      ).join('\n\n');
      const toolOwner = {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: repeated },
          { type: 'tool_use' as const, id: 'tool-1', name: 'bash', input: { command: 'true' } },
        ],
      };
      const sanitize = (session as unknown as {
        sanitizeRecoveredTranscript: (
          messages: Array<typeof toolOwner>,
          model: string,
        ) => { messages: Array<typeof toolOwner>; removed: number };
      }).sanitizeRecoveredTranscript.bind(session);

      const result = sanitize([toolOwner], 'DeepSeek-V4-Flash');

      expect(result.removed).toBe(0);
      expect(result.messages).toEqual([toolOwner]);
    });

    it('returns false for nonexistent session', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const result = await session.resumeSession('nonexistent-id');
      expect(result).toBe(false);
    });

    it('preserves resumed working context when only the responsive budget is exceeded', async () => {
      const previousHome = process.env['HOME'];
      const previousTarget = process.env['SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-trim-'));
      process.env['HOME'] = tempHome;
      process.env['SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS'] = '1000';

      let resumed: AgentSession | null = null;

      try {
        await session.init(process.cwd(), 'test-local-model');
        const store = (session as unknown as {
          store: {
            createSessionWithId: (id: string, model: string, cwd: string) => { id: string };
            replaceMessages: (id: string, messages: Array<{ role: string; content: string; timestamp: number }>) => void;
            loadSession: (id: string) => { messages: Array<{ role: string; content: string }> } | null;
          };
        }).store;

        const saved = store.createSessionWithId('resume-trim-preserves-store', 'test-local-model', process.cwd());
        const largeText = 'large persisted resume message '.repeat(250);
        const originalMessages = Array.from({ length: 24 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `${index}: ${largeText}`,
          timestamp: Date.now() + index,
        }));
        store.replaceMessages(saved.id, originalMessages);

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model');

        let payload: {
          messages: Array<{ role: string; content: unknown }>;
          resumeTrimmedDropped?: number;
          resumeTrim?: {
            beforeMessages: number;
            afterMessages: number;
            responsiveBudgetExceeded: boolean;
            hardBudgetExceeded: boolean;
          };
        } | null = null;
        resumed.on('session_resumed', (eventPayload) => {
          payload = eventPayload as typeof payload;
        });

        const ok = await resumed.resumeSession(saved.id);

        expect(ok).toBe(true);
        expect(payload).toBeTruthy();
        expect(payload!.resumeTrimmedDropped).toBe(0);
        expect(payload!.resumeTrim?.beforeMessages).toBe(originalMessages.length);
        expect(payload!.resumeTrim?.afterMessages).toBe(originalMessages.length);
        expect(payload!.resumeTrim?.responsiveBudgetExceeded).toBe(true);
        expect(payload!.resumeTrim?.hardBudgetExceeded).toBe(false);
        expect(payload!.messages.length).toBe(originalMessages.length);
        expect(store.loadSession(saved.id)?.messages).toHaveLength(originalMessages.length);
      } finally {
        if (resumed) {
          await resumed.destroy();
        }
        if (previousTarget == null) {
          delete process.env['SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS'];
        } else {
          process.env['SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS'] = previousTarget;
        }
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('discovers the served window and compacts an over-threshold resume before use', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-discovery-'));
      process.env['HOME'] = tempHome;
      let resumed: AgentSession | null = null;

      try {
        await session.init(process.cwd(), 'test-local-model');
        const store = (session as unknown as {
          store: {
            createSessionWithId: (id: string, model: string, cwd: string) => { id: string };
            replaceMessages: (id: string, messages: Array<{ role: string; content: string; timestamp: number }>) => void;
            loadSession: (id: string) => { messages: Array<{ role: string; content: string }> } | null;
          };
        }).store;
        const saved = store.createSessionWithId('resume-discovers-window-first', 'test-local-model', process.cwd());
        const largeText = 'long context that fits 380928 but not the generic provider floor '.repeat(105);
        const originalMessages = Array.from({ length: 160 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `${index}: ${largeText}`,
          timestamp: Date.now() + index,
        }));
        store.replaceMessages(saved.id, originalMessages);

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model');
        const provider = {
          name: 'test-vllm',
          supportsTools: true,
          maxContextWindow: 131_072,
          contextWindowFor() {
            return this.maxContextWindow;
          },
          getServedModel: vi.fn(async function (this: { maxContextWindow: number }) {
            this.maxContextWindow = 380_928;
            return 'test-local-model';
          }),
          // LLM-based compaction (operator 2026-08-08): resume must use the
          // summarizing compaction, not the lossy local extractive fallback.
          chat: async function* () {
            yield { type: 'text', text: 'Test compaction summary of the resumed conversation. '.repeat(80) };
            yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
            yield { type: 'done' };
          },
        };
        (resumed as unknown as { provider: typeof provider }).provider = provider;

        let payload: {
          messages: Array<{ role: string; content: unknown }>;
          resumeTrimmedDropped?: number;
          resumeTrim?: {
            maxContextTokens: number;
            hardBudgetExceeded: boolean;
            contextWindowDiscoveryDeferred?: boolean;
          };
          resumeCompaction?: {
            compacted: boolean;
            method: 'provider_semantic';
            beforeMessages: number;
            afterMessages: number;
            beforeTokens: number;
            afterTokens: number;
            thresholdTokens: number;
          };
        } | null = null;
        resumed.on('session_resumed', (eventPayload) => {
          payload = eventPayload as typeof payload;
        });

        const ok = await resumed.resumeSession(saved.id);

        expect(ok).toBe(true);
        expect(provider.getServedModel).toHaveBeenCalledWith(
          'test-local-model',
          { forceRefresh: true },
        );
        expect(payload!.resumeTrimmedDropped).toBe(0);
        expect(payload!.resumeTrim?.maxContextTokens).toBe(380_928);
        expect(payload!.resumeTrim?.hardBudgetExceeded).toBe(false);
        expect(payload!.resumeCompaction).toMatchObject({
          compacted: true,
          method: 'provider_semantic',
          beforeMessages: originalMessages.length,
          afterMessages: payload!.messages.length,
          thresholdTokens: 285_696,
        });
        expect(payload!.resumeCompaction!.beforeTokens).toBeGreaterThan(285_696);
        expect(payload!.resumeCompaction!.afterTokens).toBeLessThan(285_696);
        expect(payload!.messages.length).toBeLessThan(originalMessages.length);
        expect(store.loadSession(saved.id)?.messages).toHaveLength(payload!.messages.length);
        expect(String(payload!.messages[0]?.content)).toContain('[Conversation Summary]');
      } finally {
        if (resumed) await resumed.destroy();
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('fences a late resume compaction so it cannot overwrite newer session state', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-fence-'));
      process.env['HOME'] = tempHome;
      let resumed: AgentSession | null = null;

      try {
        const model = 'test-local-model';
        await session.init(process.cwd(), model);
        const store = (session as unknown as {
          store: {
            createSessionWithId: (id: string, model: string, cwd: string) => { id: string };
            replaceMessages: (id: string, messages: Array<{ role: string; content: string; timestamp: number }>) => void;
            loadSession: (id: string) => { messages: Array<{ role: string; content: string }> } | null;
          };
        }).store;
        const saved = store.createSessionWithId('resume-late-compaction-fenced', model, process.cwd());
        const largeText = 'a stale resume must never replace a newer active turn '.repeat(150);
        const originalMessages = Array.from({ length: 160 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `${index}: ${largeText}`,
          timestamp: Date.now() + index,
        }));
        store.replaceMessages(saved.id, originalMessages);

        let markChatStarted!: () => void;
        const chatStarted = new Promise<void>((resolve) => { markChatStarted = resolve; });
        let releaseChat!: () => void;
        const chatRelease = new Promise<void>((resolve) => { releaseChat = resolve; });

        resumed = new AgentSession();
        await resumed.init(process.cwd(), model);
        const provider = {
          name: 'test-vllm',
          supportsTools: true,
          maxContextWindow: 131_072,
          contextWindowFor() {
            return this.maxContextWindow;
          },
          getServedModel: vi.fn(async function (this: { maxContextWindow: number }) {
            this.maxContextWindow = 380_928;
            return model;
          }),
          // Deliberately ignore the abort signal and complete late, matching
          // the live shizuha1 race. The post-await generation fence must still
          // reject this result before it touches memory or SQLite.
          chat: async function* () {
            markChatStarted();
            await chatRelease;
            yield { type: 'text', text: 'Late stale summary. '.repeat(100) };
            yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
            yield { type: 'done' };
          },
        };
        (resumed as unknown as { provider: typeof provider }).provider = provider;

        const events: AgentEvent[] = [];
        resumed.on('agent_event', (event: AgentEvent) => events.push(event));
        const resumePromise = resumed.resumeSession(saved.id);
        // Observe rejection immediately without leaving a temporarily
        // unhandled promise while the deliberately stuck provider is held.
        const resumeOutcome = resumePromise.then(
          (value) => ({ value, error: null as Error | null }),
          (error: Error) => ({ value: null as boolean | null, error }),
        );
        await chatStarted;

        await resumed.submitPrompt('must not append during resume maintenance');
        expect(events).toContainEqual(expect.objectContaining({
          type: 'error',
          error: expect.stringContaining('resume is still reconciling'),
        }));
        expect(store.loadSession(saved.id)?.messages).toHaveLength(originalMessages.length);

        resumed.newSession();
        releaseChat();
        const outcome = await resumeOutcome;
        expect(outcome.value).toBeNull();
        expect(outcome.error?.message).toMatch(/resume (?:interrupted|superseded)/i);
        expect(resumed.messages).toHaveLength(0);
        expect(events.some((event) => (
          event.type === 'provider_status' && event.code === 'compaction_resume_complete'
        ))).toBe(false);
        expect(store.loadSession(saved.id)?.messages).toHaveLength(originalMessages.length);
      } finally {
        if (resumed) await resumed.destroy();
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('preserves the working set when self-hosted context discovery is unavailable', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-discovery-fail-'));
      process.env['HOME'] = tempHome;
      let resumed: AgentSession | null = null;

      try {
        const model = 'cortex/GLM-5.2-NVFP4-AQLM-380K';
        await session.init(process.cwd(), model);
        const store = (session as unknown as {
          store: {
            createSessionWithId: (id: string, model: string, cwd: string) => { id: string };
            replaceMessages: (id: string, messages: Array<{ role: string; content: string; timestamp: number }>) => void;
            loadSession: (id: string) => { messages: Array<{ role: string; content: string }> } | null;
          };
        }).store;
        const saved = store.createSessionWithId('resume-defers-known-static-window', model, process.cwd());
        const largeText = 'unknown context window must not destroy persisted working messages '.repeat(105);
        const originalMessages = Array.from({ length: 160 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `${index}: ${largeText}`,
          timestamp: Date.now() + index,
        }));
        store.replaceMessages(saved.id, originalMessages);

        resumed = new AgentSession();
        await resumed.init(process.cwd(), model);
        const provider = {
          name: 'test-vllm',
          supportsTools: true,
          maxContextWindow: 131_072,
          contextWindowFor() {
            return this.maxContextWindow;
          },
          getServedModel: vi.fn(async () => undefined),
        };
        (resumed as unknown as { provider: typeof provider }).provider = provider;

        let payload: {
          messages: Array<{ role: string; content: unknown }>;
          resumeTrimmedDropped?: number;
          resumeTrim?: {
            contextWindowDiscoveryDeferred?: boolean;
          };
        } | null = null;
        resumed.on('session_resumed', (eventPayload) => {
          payload = eventPayload as typeof payload;
        });

        const ok = await resumed.resumeSession(saved.id);

        expect(ok).toBe(true);
        expect(provider.getServedModel).toHaveBeenCalledWith(model, { forceRefresh: true });
        expect(payload!.resumeTrimmedDropped).toBe(0);
        expect(payload!.resumeTrim?.contextWindowDiscoveryDeferred).toBe(true);
        expect(payload!.messages).toHaveLength(originalMessages.length);
        expect(store.loadSession(saved.id)?.messages).toHaveLength(originalMessages.length);
      } finally {
        if (resumed) await resumed.destroy();
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('restores provider-tokenizer truth before sizing a long resumed working set', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-anchor-'));
      process.env['HOME'] = tempHome;
      let resumed: AgentSession | null = null;

      try {
        await session.init(process.cwd(), 'test-local-model');
        const store = (session as unknown as {
          store: {
            createSessionWithId: (id: string, model: string, cwd: string) => { id: string };
            replaceMessages: (id: string, messages: Array<{ role: string; content: string; timestamp: number }>) => void;
            saveContextTokenAnchor: (
              id: string,
              anchor: {
                model: string;
                providerInputTokens: number;
                providerPromptEstimate: number;
                rawPromptTokens: number;
              },
              messages: Array<{ role: string; content: string; timestamp: number }>,
            ) => void;
            loadSession: (id: string) => { messages: Array<{ role: string; content: string }> } | null;
          };
        }).store;
        const saved = store.createSessionWithId('resume-restores-token-anchor', 'test-local-model', process.cwd());
        const largeText = 'cold estimation would falsely exceed the backend fit after process resume '.repeat(130);
        const originalMessages = Array.from({ length: 160 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `${index}: ${largeText}`,
          timestamp: Date.now() + index,
        }));
        store.replaceMessages(saved.id, originalMessages);
        store.saveContextTokenAnchor(saved.id, {
          model: 'test-local-model',
          providerInputTokens: 277_282,
          providerPromptEstimate: 0,
          rawPromptTokens: estimateTokens(originalMessages, 'test-local-model'),
        }, originalMessages);

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model');
        const provider = {
          name: 'test-vllm',
          supportsTools: true,
          maxContextWindow: 131_072,
          contextWindowFor() {
            return this.maxContextWindow;
          },
          getServedModel: vi.fn(async function (this: { maxContextWindow: number }) {
            this.maxContextWindow = 380_928;
            return 'test-local-model';
          }),
          // LLM-based compaction (operator 2026-08-08): resume must use the
          // summarizing compaction, not the lossy local extractive fallback.
          chat: async function* () {
            yield { type: 'text', text: 'Test compaction summary of the resumed conversation. '.repeat(80) };
            yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
            yield { type: 'done' };
          },
        };
        (resumed as unknown as { provider: typeof provider }).provider = provider;

        let payload: {
          messages: Array<{ role: string; content: unknown }>;
          resumeTrimmedDropped?: number;
          resumeTrim?: {
            beforeTokens: number;
            hardBudgetExceeded: boolean;
          };
        } | null = null;
        resumed.on('session_resumed', (eventPayload) => {
          payload = eventPayload as typeof payload;
        });

        const ok = await resumed.resumeSession(saved.id);

        expect(ok).toBe(true);
        expect(payload!.resumeTrimmedDropped).toBe(0);
        expect(payload!.resumeTrim?.beforeTokens).toBe(277_282);
        expect(payload!.resumeTrim?.hardBudgetExceeded).toBe(false);
        expect(payload!.messages).toHaveLength(originalMessages.length);
        expect(store.loadSession(saved.id)?.messages).toHaveLength(originalMessages.length);
      } finally {
        if (resumed) await resumed.destroy();
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('reuses tokenizer calibration across resume sanitation on consecutive process starts', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-calibration-'));
      process.env['HOME'] = tempHome;
      const resumedSessions: AgentSession[] = [];

      try {
        const model = 'DeepSeek-V4-Flash';
        await session.init(process.cwd(), model);
        const store = (session as unknown as {
          store: {
            createSessionWithId: (id: string, model: string, cwd: string) => { id: string };
            replaceMessages: (id: string, messages: Array<{ role: string; content: string; timestamp: number }>) => void;
            saveContextTokenAnchor: (
              id: string,
              anchor: {
                model: string;
                providerInputTokens: number;
                providerPromptEstimate: number;
                rawPromptTokens: number;
              },
              messages: Array<{ role: string; content: string; timestamp: number }>,
            ) => void;
          };
        }).store;
        const saved = store.createSessionWithId('resume-keeps-tokenizer-calibration', model, process.cwd());
        let repeatCount = 100;
        let workingMessages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];
        let rawTokens = 0;
        do {
          const largeText = 'sanitation must not erase provider tokenizer evidence '.repeat(repeatCount);
          workingMessages = Array.from({ length: 160 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
            content: `${index}: ${largeText}`,
            timestamp: 1_000 + index,
          }));
          rawTokens = estimateTokens(workingMessages, model);
          repeatCount += 10;
        } while (rawTokens < 295_000);
        expect(rawTokens).toBeLessThan(330_000);

        // This persisted recovery nudge is removed on resume, invalidating the
        // absolute message-prefix anchor exactly as in shizuha1. The tokenizer
        // ratio remains valid and must prevent the 1.45x cold fallback.
        const internalRecovery = {
          role: 'user' as const,
          content: 'Continue. If a tool result is available, answer the user directly from it.',
          timestamp: 900,
        };
        const anchoredMessages = [
          ...workingMessages.slice(0, 40),
          internalRecovery,
          ...workingMessages.slice(40),
        ];
        const anchoredRawTokens = estimateTokens(anchoredMessages, model);
        store.replaceMessages(saved.id, [
          ...anchoredMessages,
          { role: 'assistant', content: 'Previous turn completed.', timestamp: 2_000 },
        ]);
        store.saveContextTokenAnchor(saved.id, {
          model,
          providerInputTokens: Math.ceil(anchoredRawTokens * 1.073),
          providerPromptEstimate: Math.ceil(anchoredRawTokens * 1.45),
          rawPromptTokens: anchoredRawTokens,
        }, anchoredMessages);

        const compactionCalls = vi.fn();
        for (let attempt = 0; attempt < 2; attempt++) {
          const resumed = new AgentSession();
          resumedSessions.push(resumed);
          await resumed.init(process.cwd(), model);
          const provider = {
            name: 'test-vllm',
            supportsTools: true,
            maxContextWindow: 131_072,
            contextWindowFor() {
              return this.maxContextWindow;
            },
            getServedModel: vi.fn(async function (this: { maxContextWindow: number }) {
              this.maxContextWindow = 524_288;
              return model;
            }),
            chat: async function* () {
              compactionCalls();
              throw new Error('phantom compaction must not run');
            },
          };
          (resumed as unknown as { provider: typeof provider }).provider = provider;

          let payload: {
            messages: Array<{ role: string; content: unknown }>;
            sanitizedRemoved?: number;
            resumeTrimmedDropped?: number;
            resumeCompaction?: { attempts?: number };
          } | null = null;
          resumed.on('session_resumed', (eventPayload) => {
            payload = eventPayload as typeof payload;
          });

          expect(await resumed.resumeSession(saved.id)).toBe(true);
          expect(payload!.resumeTrimmedDropped).toBe(0);
          expect(payload!.resumeCompaction?.attempts ?? 0).toBe(0);
          expect(payload!.messages).toHaveLength(workingMessages.length + 1);
          await resumed.destroy();
        }
        expect(compactionCalls).not.toHaveBeenCalled();
      } finally {
        for (const resumed of resumedSessions) await resumed.destroy();
        if (previousHome == null) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });

    it('retains last user prompt after interrupt so resumed sessions can continue', async () => {
      const previousHome = process.env['HOME'];
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-session-resume-'));
      process.env['HOME'] = tempHome;
      let signalReady: (() => void) | null = null;
      const startedExecuteTurn = new Promise<void>((resolve) => {
        signalReady = resolve;
      });

      const executeTurnSpy = vi.spyOn(turnModule, 'executeTurn').mockImplementation(((...args: unknown[]) => {
        const abortSignal = args[14] as AbortSignal | undefined;
        return new Promise((_, reject) => {
          signalReady?.();
          const onAbort = () => reject(new Error('AbortError: interrupted'));
          const timeout = setTimeout(() => reject(new Error('Mock executeTurn timeout')), 5000);
          if (!abortSignal) {
            clearTimeout(timeout);
            reject(new Error('Missing abort signal in executeTurn mock'));
            return;
          }
          if (abortSignal.aborted) {
            clearTimeout(timeout);
            onAbort();
            return;
          }
          abortSignal.addEventListener('abort', () => {
            clearTimeout(timeout);
            onAbort();
          }, { once: true });
        });
      }) as typeof turnModule.executeTurn);

      let resumedSession: {
        id: string;
        messages: Array<{ role: string; content: unknown }>;
        interruptCheckpoint?: {
          createdAt: number;
          promptExcerpt: string;
          note: string;
        };
      } | null = null;
      let resumed: AgentSession | null = null;
      let ensureProviderSpy:
        | ReturnType<typeof vi.spyOn<{
          ensureProvider: () => unknown;
        }, 'ensureProvider'>>
        | null = null;

      try {
        await session.init(process.cwd(), 'test-local-model');
        ensureProviderSpy = vi.spyOn(
          session as unknown as { ensureProvider: () => unknown },
          'ensureProvider',
        ).mockReturnValue({});

        const run = session.submitPrompt('resume-checkpoint');
        const waitStart = Date.now();
        while (!session.currentSessionId && Date.now() - waitStart < 2000) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const interruptedSessionId = session.currentSessionId;
        expect(interruptedSessionId).toBeTruthy();
        await startedExecuteTurn;

        session.interrupt();
        await run;

        resumed = new AgentSession();
        await resumed.init(process.cwd(), 'test-local-model');
        resumed.on('session_resumed', (payload) => {
          resumedSession = payload as typeof resumedSession;
        });

        const ok = await resumed.resumeSession(interruptedSessionId!);
        expect(ok).toBe(true);
        expect(resumedSession).toBeTruthy();
        expect(
          resumedSession!.messages.some(
            (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('resume-checkpoint'),
          ),
        ).toBe(true);
        expect(resumedSession!.interruptCheckpoint).toBeTruthy();
        expect(resumedSession!.interruptCheckpoint!.promptExcerpt).toContain('resume-checkpoint');
        expect(resumedSession!.interruptCheckpoint!.note).toContain('interrupted');

      } finally {
        ensureProviderSpy?.mockRestore();
        executeTurnSpy.mockRestore();
        if (resumed) {
          await resumed.destroy();
        }
        if (previousHome == null) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = previousHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    });
  });
});
