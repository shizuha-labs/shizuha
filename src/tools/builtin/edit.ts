import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { resolveSafePath, writeFileSafe } from '../../utils/fs.js';
import { applyEdit, createUnifiedDiff } from '../../utils/diff.js';

export const editTool: ToolHandler = {
  name: 'edit',
  description:
    'Perform an exact string replacement in a file. The old_string must appear exactly once ' +
    'in the file (unless replace_all is true). Use this for surgical edits to existing files.',
  parameters: z.object({
    file_path: z.string().describe('Path to the file to edit'),
    old_string: z.string().describe('The exact string to find and replace'),
    new_string: z.string().describe('The replacement string'),
    replace_all: z.boolean().optional().default(false).describe('Replace all occurrences'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = this.parameters.parse(params);
    const resolved = resolveSafePath(file_path, context.cwd);

    try {
      const content = await fs.readFile(resolved, 'utf-8');
      const { result, replacements } = applyEdit(content, old_string, new_string, replace_all);
      await writeFileSafe(resolved, result);
      const diff = createUnifiedDiff(resolved, content, result);
      return {
        toolUseId: '',
        content: `Edited ${resolved}: ${replacements} replacement${replacements === 1 ? '' : 's'}`,
        metadata: { diff, filePath: resolved, oldContent: content, newContent: result },
      };
    } catch (err) {
      return { toolUseId: '', content: `Error editing file: ${(err as Error).message}`, isError: true };
    }
  },
};
