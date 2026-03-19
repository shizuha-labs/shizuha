import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const taskTool: ToolHandler = {
  name: 'task',
  description:
    'Spawn a sub-agent to handle a complex task. The sub-agent runs with its own context ' +
    'and returns results when complete. Use for parallelizable or independent work.',
  parameters: z.object({
    description: z.string().describe('Short description of the task (3-5 words)'),
    prompt: z.string().describe('Detailed task instructions for the sub-agent'),
    model: z.string().optional().describe('Model override for the sub-agent'),
  }),
  readOnly: true,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { description, prompt, model: _model } = this.parameters.parse(params);

    // Sub-agent spawning is handled by the agent loop, not directly here.
    // This tool returns a placeholder — the loop intercepts task tool calls.
    return {
      toolUseId: '',
      content: `[Sub-agent task "${description}" would be spawned here. Prompt: ${prompt.slice(0, 200)}...]`,
    };
  },
};
