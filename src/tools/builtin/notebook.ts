import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { resolveSafePath } from '../../utils/fs.js';

interface NotebookCell {
  cell_type: string;
  source: string[];
  [key: string]: unknown;
}

interface Notebook {
  cells: NotebookCell[];
  [key: string]: unknown;
}

export const notebookTool: ToolHandler = {
  name: 'notebook_edit',
  description:
    'Edit a Jupyter notebook cell. Can replace cell content, insert a new cell, or delete a cell.',
  parameters: z.object({
    notebook_path: z.string().describe('Path to the .ipynb file'),
    cell_number: z.number().int().min(0).describe('Cell index (0-based)'),
    new_source: z.string().describe('New cell source content'),
    cell_type: z.enum(['code', 'markdown']).optional().describe('Cell type (for insert)'),
    edit_mode: z.enum(['replace', 'insert', 'delete']).optional().default('replace'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { notebook_path, cell_number, new_source, cell_type, edit_mode } = this.parameters.parse(params);
    const resolved = resolveSafePath(notebook_path, context.cwd);

    try {
      const raw = await fs.readFile(resolved, 'utf-8');
      const notebook = JSON.parse(raw) as Notebook;

      if (edit_mode === 'insert') {
        const newCell: NotebookCell = {
          cell_type: cell_type ?? 'code',
          source: new_source.split('\n').map((l: string, i: number, arr: string[]) => (i < arr.length - 1 ? l + '\n' : l)),
          metadata: {},
          ...(cell_type !== 'markdown' ? { outputs: [], execution_count: null } : {}),
        };
        notebook.cells.splice(cell_number, 0, newCell);
      } else if (edit_mode === 'delete') {
        if (cell_number >= notebook.cells.length) {
          return { toolUseId: '', content: `Cell ${cell_number} does not exist`, isError: true };
        }
        notebook.cells.splice(cell_number, 1);
      } else {
        if (cell_number >= notebook.cells.length) {
          return { toolUseId: '', content: `Cell ${cell_number} does not exist`, isError: true };
        }
        const cell = notebook.cells[cell_number]!;
        cell.source = new_source.split('\n').map((l: string, i: number, arr: string[]) => (i < arr.length - 1 ? l + '\n' : l));
        if (cell_type) cell.cell_type = cell_type;
      }

      await fs.writeFile(resolved, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');
      return { toolUseId: '', content: `Notebook ${edit_mode}: cell ${cell_number} in ${resolved}` };
    } catch (err) {
      return { toolUseId: '', content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};
