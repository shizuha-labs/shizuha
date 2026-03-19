import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const taskStopTool: ToolHandler = {
  name: 'TaskStop',
  description: 'Stop a running background task (bash command or agent).',
  parameters: z.object({
    task_id: z.string().describe('The ID of the background task to stop'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { task_id } = this.parameters.parse(params);
    const registry = context.taskRegistry;

    if (!registry) {
      return { toolUseId: '', content: 'Background tasks are not available in this execution mode.', isError: true };
    }

    const task = registry.get(task_id);
    if (!task) {
      return { toolUseId: '', content: `No task found with ID: ${task_id}`, isError: true };
    }

    if (task.status !== 'running' && task.status !== 'pending') {
      return { toolUseId: '', content: `Task ${task_id} is already ${task.status}.` };
    }

    // Kill via AbortController — the bash process or sub-agent will handle cleanup
    const killed = registry.kill(task_id);
    if (!killed) {
      return { toolUseId: '', content: `Failed to stop task ${task_id}.`, isError: true };
    }

    // For bash tasks with a PID, also kill the process group
    if (task.type === 'bash' && task.pid) {
      try {
        process.kill(-task.pid, 'SIGTERM');
        setTimeout(() => {
          try { process.kill(-task.pid!, 'SIGKILL'); } catch { /* already dead */ }
        }, 2000).unref();
      } catch { /* process already dead */ }
    }

    return { toolUseId: '', content: `Task ${task_id} (${task.description}) has been stopped.` };
  },
};
