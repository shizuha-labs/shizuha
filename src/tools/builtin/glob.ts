import { z } from 'zod';
import { glob as globFn } from 'glob';
import * as path from 'node:path';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

/** Hard wall-clock budget for the walk — a glob over a huge tree (e.g. all of
 *  $HOME) must return an actionable error, never wedge the turn. */
const GLOB_DEADLINE_MS = 30_000;

export const globTool: ToolHandler = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Returns matching file paths sorted by modification time. ' +
    'Supports patterns like "**/*.ts", "src/**/*.js".',
  parameters: z.object({
    pattern: z.string().describe('Glob pattern to match files'),
    path: z.string().optional().describe('Directory to search in (default: cwd)'),
  }),
  readOnly: true,
  riskLevel: 'low',
  silentTimeoutMs: 90_000,

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, path: searchPath } = this.parameters.parse(params);
    const cwd = searchPath ? path.resolve(context.cwd, searchPath) : context.cwd;

    if (context.abortSignal?.aborted) {
      return { toolUseId: '', content: 'Glob cancelled.', isError: true };
    }

    // Bound the walk: abort on the turn's abort signal or the deadline.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GLOB_DEADLINE_MS);
    const onOuterAbort = () => ac.abort();
    context.abortSignal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const matches = await globFn(pattern, {
        cwd,
        absolute: true,
        nodir: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**'],
        signal: ac.signal,
      });

      if (matches.length === 0) {
        return { toolUseId: '', content: 'No files matched the pattern.' };
      }

      const limited = matches.slice(0, 200);
      const result = limited.join('\n');
      const suffix = matches.length > 200 ? `\n... and ${matches.length - 200} more` : '';
      return { toolUseId: '', content: `${limited.length} files found:\n${result}${suffix}` };
    } catch (err) {
      if (ac.signal.aborted) {
        return context.abortSignal?.aborted
          ? { toolUseId: '', content: 'Glob cancelled.', isError: true }
          : {
              toolUseId: '',
              content: `Glob timed out after ${GLOB_DEADLINE_MS / 1000}s walking ${cwd}. Narrow it: search a specific subdirectory or use a more specific pattern.`,
              isError: true,
            };
      }
      return { toolUseId: '', content: `Error: ${(err as Error).message}`, isError: true };
    } finally {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener('abort', onOuterAbort);
    }
  },
};
