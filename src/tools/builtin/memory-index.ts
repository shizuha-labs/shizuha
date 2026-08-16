/**
 * Memory Index tool — advanced persistent memory search with FTS5 + vector embeddings.
 *
 * This augments the simple memory tool with a full-text index + optional
 * vector embeddings for semantic search. Configurable per agent.
 */

import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import type { MemoryIndex } from '../../memory/index.js';

let sharedIndex: MemoryIndex | null = null;

export function setMemoryIndex(index: MemoryIndex): void {
  sharedIndex = index;
}

export const memoryIndexSearchTool: ToolHandler = {
  name: 'memory_index_search',
  description:
    'Deep search across all persistent memory (MEMORY.md, memory/*.md, session logs) ' +
    'using full-text indexing and optional semantic embeddings.\n' +
    'Returns ranked results with file path, line numbers, and relevance score.\n' +
    'Use this for broad recall queries when the simple memory tool returns nothing.\n\n' +
    'Examples:\n' +
    '  memory_index_search(query="authentication setup")\n' +
    '  memory_index_search(query="what did we decide about the database")',
  parameters: z.object({
    query: z.string().describe('Search query — keywords, concepts, or questions'),
    max_results: z.number().optional().default(6).describe('Max results (default: 6)'),
  }),
  readOnly: true,
  riskLevel: 'low' as const,

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedIndex) {
      return { toolUseId: '', content: 'Memory index not initialized', isError: true };
    }

    const { query, max_results } = (this as any).parameters.parse(params);

    try {
      const results = await sharedIndex.search(query, max_results);

      if (results.length === 0) {
        return { toolUseId: '', content: `No indexed memories matching "${query}".` };
      }

      const stats = sharedIndex.stats();
      const formatted = results.map((r, i) =>
        `${i + 1}. [${r.source}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n   ${r.snippet.slice(0, 300)}`
      ).join('\n\n');

      return {
        toolUseId: '',
        content: `${results.length} results from ${stats.chunks} indexed chunks (${stats.files} files, ${stats.embedded} embedded):\n\n${formatted}`,
      };
    } catch (err) {
      return { toolUseId: '', content: `Memory index search error: ${(err as Error).message}`, isError: true };
    }
  },
};

export const memoryIndexStatsTool: ToolHandler = {
  name: 'memory_index_stats',
  description: 'Show memory index statistics — files tracked, chunks indexed, embeddings generated.',
  parameters: z.object({}),
  readOnly: true,
  riskLevel: 'low' as const,

  async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedIndex) {
      return { toolUseId: '', content: 'Memory index not initialized', isError: true };
    }

    const stats = sharedIndex.stats();
    return {
      toolUseId: '',
      content: JSON.stringify({
        files: stats.files,
        chunks: stats.chunks,
        embedded: stats.embedded,
        vectorSearchAvailable: stats.hasVec,
      }, null, 2),
    };
  },
};
