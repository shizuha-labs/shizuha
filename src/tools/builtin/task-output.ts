import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const taskOutputTool: ToolHandler = {
  name: 'TaskOutput',
  description:
    'Read the output of a background task (bash command or agent). ' +
    'By default, blocks until the task completes (up to timeout). ' +
    'Set block=false for a non-blocking check.',
  parameters: z.object({
    task_id: z.string().describe('The background task ID to read output from'),
    block: z.boolean().default(true).describe('Whether to wait for completion (default: true)'),
    timeout: z.number().int().min(0).max(600000).default(30000).describe('Max wait time in ms when blocking (default: 30000)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { task_id, block, timeout } = this.parameters.parse(params);
    const registry = context.taskRegistry;

    if (!registry) {
      return { toolUseId: '', content: 'Background tasks are not available in this execution mode.', isError: true };
    }

    const task = registry.get(task_id);
    if (!task) {
      return { toolUseId: '', content: `No task found with ID: ${task_id}`, isError: true };
    }

    const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'killed';

    if (!isTerminal && block) {
      const completed = await registry.waitForCompletion(task_id, timeout);
      if (!completed) {
        return {
          toolUseId: '',
          content: formatOutput(task, 'not_ready'),
        };
      }
    } else if (!isTerminal && !block) {
      return {
        toolUseId: '',
        content: formatOutput(task, 'not_ready'),
      };
    }

    // Refresh task reference after potential wait
    const finalTask = registry.get(task_id)!;
    return {
      toolUseId: '',
      content: formatOutput(finalTask, 'success'),
      isError: finalTask.status === 'failed',
    };
  },
};

function formatOutput(
  task: { id: string; type: string; status: string; description: string; output: string; error?: string; exitCode?: number },
  retrievalStatus: 'success' | 'not_ready',
): string {
  const parts = [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${task.id}</task_id>`,
    `<task_type>${task.type}</task_type>`,
    `<status>${task.status}</status>`,
    `<description>${task.description}</description>`,
  ];

  if (task.exitCode !== undefined) {
    parts.push(`<exit_code>${task.exitCode}</exit_code>`);
  }

  if (task.output) {
    parts.push(`<output>\n${task.output}\n</output>`);
  }

  if (task.error) {
    parts.push(`<error>${task.error}</error>`);
  }

  return parts.join('\n');
}
