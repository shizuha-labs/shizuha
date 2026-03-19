import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

const execFileAsync = promisify(execFile);

/** Fallback to native grep when ripgrep is not installed */
async function grepFallback(
  pattern: string,
  target: string,
  fileGlob: string | undefined,
  ctx: number | undefined,
  maxResults: number,
  context: ToolContext,
): Promise<ToolResult> {
  const args = ['-r', '-n', '--color=never'];
  if (ctx) args.push(`-C${ctx}`);
  if (fileGlob) args.push(`--include=${fileGlob}`);
  args.push('-m', String(maxResults));
  args.push('--', pattern, target);

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: context.cwd,
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const lines = stdout.trim().split('\n');
    return { toolUseId: '', content: `${lines.length} matches:\n${stdout.trim()}` };
  } catch (err: unknown) {
    const error = err as { code?: number; stdout?: string; message?: string };
    if (error.code === 1) {
      return { toolUseId: '', content: 'No matches found.' };
    }
    return { toolUseId: '', content: `Search error: ${error.message}`, isError: true };
  }
}

export const grepTool: ToolHandler = {
  name: 'grep',
  description:
    'Search file contents using ripgrep (rg). Supports regex patterns. ' +
    'Returns matching lines with file paths and line numbers.',
  parameters: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search (default: cwd)'),
    glob: z.string().optional().describe('File glob filter (e.g., "*.ts")'),
    context: z.number().int().min(0).max(10).optional().describe('Lines of context around matches'),
    max_results: z.number().int().min(1).max(500).optional().default(100).describe('Max results'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, path: searchPath, glob: fileGlob, context: ctx, max_results } = this.parameters.parse(params);
    const target = searchPath ?? context.cwd;

    const args = ['--no-heading', '--line-number', '--color=never', `--max-count=${max_results}`];
    if (fileGlob) args.push(`--glob=${fileGlob}`);
    if (ctx) args.push(`-C${ctx}`);
    args.push('--', pattern, target);

    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: context.cwd,
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const lines = stdout.trim().split('\n');
      return { toolUseId: '', content: `${lines.length} matches:\n${stdout.trim()}` };
    } catch (err: unknown) {
      const error = err as { code?: number; stdout?: string; message?: string };
      if (error.code === 1) {
        return { toolUseId: '', content: 'No matches found.' };
      }
      // rg not found — fall back to native grep
      if (error.message?.includes('ENOENT')) {
        return await grepFallback(pattern, target, fileGlob, ctx, max_results, context);
      }
      return { toolUseId: '', content: `Search error: ${error.message}`, isError: true };
    }
  },
};
