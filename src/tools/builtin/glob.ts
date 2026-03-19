import { z } from 'zod';
import { glob as globFn } from 'glob';
import * as path from 'node:path';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

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

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, path: searchPath } = this.parameters.parse(params);
    const cwd = searchPath ? path.resolve(context.cwd, searchPath) : context.cwd;

    try {
      const matches = await globFn(pattern, {
        cwd,
        absolute: true,
        nodir: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      if (matches.length === 0) {
        return { toolUseId: '', content: 'No files matched the pattern.' };
      }

      const limited = matches.slice(0, 200);
      const result = limited.join('\n');
      const suffix = matches.length > 200 ? `\n... and ${matches.length - 200} more` : '';
      return { toolUseId: '', content: `${limited.length} files found:\n${result}${suffix}` };
    } catch (err) {
      return { toolUseId: '', content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};
