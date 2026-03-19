import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import type { StateStore } from '../../state/store.js';

/** Shared state store reference — set by agent process / TUI session during init */
let sharedStore: StateStore | null = null;

/** Called by agent process / TUI session to inject the store for search */
export function setSearchStore(store: StateStore): void {
  sharedStore = store;
}

export const sessionSearchTool: ToolHandler = {
  name: 'session_search',
  description:
    'Search across all past conversation messages using full-text search. ' +
    'Use this to recall previous discussions, find specific information mentioned in past sessions, ' +
    'or verify what was discussed before. Returns matching message snippets ranked by relevance.',
  parameters: z.object({
    query: z
      .string()
      .describe('Search query (supports FTS5 syntax: AND, OR, NOT, "exact phrase")'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Max results to return (default: 10)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedStore) {
      return {
        toolUseId: '',
        content: 'Session search not initialized — no store available.',
        isError: true,
      };
    }

    const { query, limit } = sessionSearchTool.parameters.parse(params);

    try {
      const results = sharedStore.searchMessages(query, limit ?? 10);

      if (results.length === 0) {
        return { toolUseId: '', content: `No messages matching "${query}".` };
      }

      const formatted = results
        .map((r, i) => {
          const date = new Date(r.timestamp).toISOString().split('T')[0];
          const snippet =
            r.content.length > 200
              ? r.content.slice(0, 197) + '...'
              : r.content;
          return `${i + 1}. [${date}] (${r.role}) ${r.sessionId.slice(0, 8)}...: ${snippet}`;
        })
        .join('\n\n');

      return {
        toolUseId: '',
        content: `Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}`,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Search error: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
