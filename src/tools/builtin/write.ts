import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { writeFileSafe, resolveSafePath } from '../../utils/fs.js';
import { createUnifiedDiff } from '../../utils/diff.js';

export const writeTool: ToolHandler = {
  name: 'write',
  description:
    'Write content to a file. Creates the file if it does not exist, or overwrites it. ' +
    'Parent directories are created automatically. ' +
    'For LARGE files, build them in bounded chunks: write the first chunk normally, then ' +
    'call write again with append=true for each subsequent chunk — never regenerate the ' +
    'whole file in one output and never re-send content already written.',
  parameters: z.object({
    file_path: z.string().describe('Absolute or relative path to the file'),
    content: z.string().describe('Content to write to the file'),
    append: z.boolean().optional().default(false).describe(
      'Append to the end of the existing file instead of overwriting. '
      + 'Use to build large files across multiple calls in bounded chunks.',
    ),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { file_path, content, append } = this.parameters.parse(params);
    const resolved = resolveSafePath(file_path, context.cwd);

    try {
      let oldContent = '';
      let isNew = true;
      try {
        oldContent = await fs.readFile(resolved, 'utf-8');
        isNew = false;
      } catch { /* new file */ }
      const newContent = append && !isNew ? oldContent + content : content;
      await writeFileSafe(resolved, newContent);
      const lines = newContent.split('\n').length;
      const diff = createUnifiedDiff(resolved, oldContent, newContent);
      const verb = isNew ? 'Created new file' : append ? 'Appended to' : 'Overwrote';
      const detail = append && !isNew
        ? ` (+${content.split('\n').length} lines, now ${lines} lines total)`
        : ` (${lines} lines)`;
      return {
        toolUseId: '',
        content: `${verb} ${resolved}${detail}`,
        metadata: { diff, filePath: resolved, isNew, oldContent, newContent },
      };
    } catch (err) {
      return { toolUseId: '', content: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  },
};
