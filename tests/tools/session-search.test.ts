import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/tools/types.js';

// We need a fresh module for each test to reset the sharedStore state
// Use dynamic imports after calling setSearchStore

const { sessionSearchTool, setSearchStore } = await import(
  '../../src/tools/builtin/session-search.js'
);

const dummyContext: ToolContext = {
  cwd: '/tmp',
  sessionId: 'test-session',
};

describe('sessionSearchTool', () => {
  describe('metadata', () => {
    it('has the correct name', () => {
      expect(sessionSearchTool.name).toBe('session_search');
    });

    it('is read-only and low risk', () => {
      expect(sessionSearchTool.readOnly).toBe(true);
      expect(sessionSearchTool.riskLevel).toBe('low');
    });
  });

  describe('parameter validation', () => {
    it('requires query parameter', () => {
      const result = sessionSearchTool.parameters.safeParse({});
      expect(result.success).toBe(false);
    });

    it('accepts valid query', () => {
      const result = sessionSearchTool.parameters.safeParse({ query: 'hello' });
      expect(result.success).toBe(true);
    });

    it('limit must be a positive integer', () => {
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: 0 }).success,
      ).toBe(false);
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: -1 }).success,
      ).toBe(false);
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: 1.5 }).success,
      ).toBe(false);
    });

    it('limit must not exceed 50', () => {
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: 51 }).success,
      ).toBe(false);
    });

    it('accepts valid limit values', () => {
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: 1 }).success,
      ).toBe(true);
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: 50 }).success,
      ).toBe(true);
      expect(
        sessionSearchTool.parameters.safeParse({ query: 'test', limit: 25 }).success,
      ).toBe(true);
    });

    it('limit is optional', () => {
      const result = sessionSearchTool.parameters.safeParse({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBeUndefined();
    });
  });

  describe('execute — no store', () => {
    // Use a fresh import to get a module where the store hasn't been set.
    // Since the module-level variable retains state from setSearchStore calls,
    // we test the "no store" case by setting store to null via a workaround.

    it('returns error when no store is set', async () => {
      // Create a fresh module instance with no store
      vi.resetModules();
      const freshModule = await import('../../src/tools/builtin/session-search.js');
      const result = await freshModule.sessionSearchTool.execute(
        { query: 'test' },
        dummyContext,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not initialized');
    });
  });

  describe('execute — with mock store', () => {
    let mockStore: {
      searchMessages: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockStore = {
        searchMessages: vi.fn(),
      };
      setSearchStore(mockStore as any);
    });

    it('returns message when no results found', async () => {
      mockStore.searchMessages.mockReturnValue([]);

      const result = await sessionSearchTool.execute({ query: 'nonexistent' }, dummyContext);
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('No messages matching "nonexistent"');
    });

    it('passes default limit of 10 when not specified', async () => {
      mockStore.searchMessages.mockReturnValue([]);
      await sessionSearchTool.execute({ query: 'test' }, dummyContext);
      expect(mockStore.searchMessages).toHaveBeenCalledWith('test', 10);
    });

    it('passes custom limit when specified', async () => {
      mockStore.searchMessages.mockReturnValue([]);
      await sessionSearchTool.execute({ query: 'test', limit: 5 }, dummyContext);
      expect(mockStore.searchMessages).toHaveBeenCalledWith('test', 5);
    });

    it('formats single result correctly', async () => {
      mockStore.searchMessages.mockReturnValue([
        {
          sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
          role: 'user',
          content: 'How do I deploy to production?',
          timestamp: new Date('2026-03-10T15:30:00Z').getTime(),
          rank: -1.5,
        },
      ]);

      const result = await sessionSearchTool.execute({ query: 'deploy' }, dummyContext);
      expect(result.content).toContain('Found 1 result for "deploy"');
      expect(result.content).toContain('2026-03-10');
      expect(result.content).toContain('(user)');
      expect(result.content).toContain('abcdef12...');
      expect(result.content).toContain('How do I deploy to production?');
    });

    it('formats multiple results correctly', async () => {
      mockStore.searchMessages.mockReturnValue([
        {
          sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
          role: 'user',
          content: 'First message about testing',
          timestamp: new Date('2026-03-10').getTime(),
          rank: -2.0,
        },
        {
          sessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
          role: 'assistant',
          content: 'Second message about testing',
          timestamp: new Date('2026-03-09').getTime(),
          rank: -1.5,
        },
      ]);

      const result = await sessionSearchTool.execute({ query: 'testing' }, dummyContext);
      expect(result.content).toContain('Found 2 results for "testing"');
      expect(result.content).toContain('1.');
      expect(result.content).toContain('2.');
      expect(result.content).toContain('(user)');
      expect(result.content).toContain('(assistant)');
    });

    it('truncates long content to 200 characters', async () => {
      const longContent = 'A'.repeat(300);
      mockStore.searchMessages.mockReturnValue([
        {
          sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
          role: 'user',
          content: longContent,
          timestamp: Date.now(),
          rank: -1.0,
        },
      ]);

      const result = await sessionSearchTool.execute({ query: 'test' }, dummyContext);
      // Content should be sliced to 197 + '...' = 200 chars for the snippet
      expect(result.content).toContain('A'.repeat(197) + '...');
      expect(result.content).not.toContain('A'.repeat(201));
    });

    it('does not truncate content at exactly 200 characters', async () => {
      const exactContent = 'B'.repeat(200);
      mockStore.searchMessages.mockReturnValue([
        {
          sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
          role: 'user',
          content: exactContent,
          timestamp: Date.now(),
          rank: -1.0,
        },
      ]);

      const result = await sessionSearchTool.execute({ query: 'test' }, dummyContext);
      expect(result.content).toContain(exactContent);
    });

    it('uses singular "result" for single match', async () => {
      mockStore.searchMessages.mockReturnValue([
        {
          sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
          role: 'user',
          content: 'Single result',
          timestamp: Date.now(),
          rank: -1.0,
        },
      ]);

      const result = await sessionSearchTool.execute({ query: 'single' }, dummyContext);
      expect(result.content).toContain('1 result for');
      expect(result.content).not.toContain('1 results');
    });

    it('uses plural "results" for multiple matches', async () => {
      mockStore.searchMessages.mockReturnValue([
        {
          sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
          role: 'user',
          content: 'A',
          timestamp: Date.now(),
          rank: -1.0,
        },
        {
          sessionId: 'bbbbbbbb-0000-0000-0000-000000000000',
          role: 'assistant',
          content: 'B',
          timestamp: Date.now(),
          rank: -0.5,
        },
      ]);

      const result = await sessionSearchTool.execute({ query: 'test' }, dummyContext);
      expect(result.content).toContain('2 results for');
    });

    it('returns error on store exception', async () => {
      mockStore.searchMessages.mockImplementation(() => {
        throw new Error('FTS5 syntax error');
      });

      const result = await sessionSearchTool.execute({ query: 'bad query +++' }, dummyContext);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('FTS5 syntax error');
    });
  });
});
