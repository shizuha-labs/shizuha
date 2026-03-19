import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { writeFileSafe, resolveSafePath } from '../../utils/fs.js';
import { createUnifiedDiff } from '../../utils/diff.js';

export const writeTool: ToolHandler = {
  name: 'write',
  description:
    'Write content to a file. Creates the file if it does not exist, or overwrites it. ' +
    'Parent directories are created automatically.',
  parameters: z.object({
    file_path: z.string().describe('Absolute or relative path to the file'),
    content: z.string().describe('Content to write to the file'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { file_path, content } = this.parameters.parse(params);
    const resolved = resolveSafePath(file_path, context.cwd);

    try {
      let oldContent = '';
      let isNew = true;
      try {
        oldContent = await fs.readFile(resolved, 'utf-8');
        isNew = false;
      } catch { /* new file */ }
      await writeFileSafe(resolved, content);
      const lines = content.split('\n').length;
      const diff = createUnifiedDiff(resolved, oldContent, content);
      return {
        toolUseId: '',
        content: `Wrote ${lines} lines to ${resolved}`,
        metadata: { diff, filePath: resolved, isNew, oldContent, newContent: content },
      };
    } catch (err) {
      return { toolUseId: '', content: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  },
};
