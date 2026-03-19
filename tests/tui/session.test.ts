import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSession } from '../../src/tui/session.js';
import type { AgentEvent } from '../../src/events/types.js';
import * as turnModule from '../../src/agent/turn.js';

describe('AgentSession', () => {
  let session: AgentSession;

  beforeEach(() => {
    session = new AgentSession();
  });

  afterEach(async () => {
    await session.destroy();
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
  });

  describe('resumeSession', () => {
    it('returns false for nonexistent session', async () => {
      await session.init(process.cwd(), 'test-local-model');
      const result = await session.resumeSession('nonexistent-id');
      expect(result).toBe(false);
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
