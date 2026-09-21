import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

/**
 * SCLI-688 (SCLI-430 second increment): agent-callable multi-task wait.
 *
 * The registry primitives (waitAny/waitAll/getOutput) landed with SCLI-430's
 * core; this is the tool surface per SCLI-430 acceptance #1. mode=any mirrors
 * Grok Build's wait-any: race parallel background tasks, get the first
 * completer's id + output, then TaskStop the losers. mode=all gates on every
 * task reaching a terminal state.
 *
 * Output reads are NON-DESTRUCTIVE: getOutput(id, true) returns the full
 * buffer without advancing the delta offset, so a later TaskOutput poll still
 * sees everything.
 */
export const waitTasksTool: ToolHandler = {
  name: 'WaitTasks',
  description:
    'Wait for one or more background tasks (bash commands or agents) to reach a terminal state. ' +
    "mode=any resolves as soon as the FIRST task completes — returns its id, status and output so the losers can be TaskStop'd. " +
    'mode=all resolves when every task is terminal. Unknown ids are skipped; an empty/unknown-only set resolves immediately.',
  parameters: z.object({
    task_ids: z.array(z.string()).min(1).describe('The background task IDs to wait on'),
    mode: z
      .enum(['any', 'all'])
      .default('any')
      .describe("'any' = resolve on the first completer (race parallel tasks); 'all' = wait until every task is terminal"),
    timeout: z
      .number()
      .int()
      .min(0)
      .max(600000)
      .default(30000)
      .describe('Max wait time in ms (default: 30000)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { task_ids, mode, timeout } = this.parameters.parse(params);
    const registry = context.taskRegistry;

    if (!registry) {
      return { toolUseId: '', content: 'Background tasks are not available in this execution mode.', isError: true };
    }

    const unknown = task_ids.filter((id: string) => !registry.get(id));

    if (mode === 'any') {
      const winner = await registry.waitAny(task_ids, timeout);
      if (!winner) {
        const stillRunning = task_ids.filter((id: string) => {
          const t = registry.get(id);
          return t && !isTerminal(t.status);
        });
        const lines = [`No task reached a terminal state within ${timeout}ms.`];
        if (stillRunning.length) lines.push(`Still running: ${stillRunning.join(', ')}`);
        if (unknown.length) lines.push(`Unknown ids (skipped): ${unknown.join(', ')}`);
        return { toolUseId: '', content: lines.join('\n') };
      }
      const out = registry.getOutput(winner.id, true);
      const lines = [
        `First completer: ${winner.id} (${winner.status})`,
        out && out.exitCode != null ? `exit code: ${out.exitCode}` : null,
        out && out.error ? `error: ${out.error}` : null,
        out && out.deltaOutput ? `\noutput:\n${out.deltaOutput}` : null,
        unknown.length ? `Unknown ids (skipped): ${unknown.join(', ')}` : null,
      ].filter((l): l is string => l !== null);
      return { toolUseId: '', content: lines.join('\n') };
    }

    // mode === 'all'
    const allDone = await registry.waitAll(task_ids, timeout);
    const perTask = task_ids.map((id: string) => {
      const out = registry.getOutput(id, true);
      if (!out) return `${id}: unknown id (skipped)`;
      const exit = out.exitCode != null ? ` (exit ${out.exitCode})` : '';
      const err = out.error ? ` — ${out.error}` : '';
      return `${id}: ${out.status}${exit}${err}`;
    });
    return {
      toolUseId: '',
      content: `${allDone ? 'All tasks terminal' : `Timeout after ${timeout}ms — not all terminal`}:\n${perTask.join('\n')}`,
    };
  },
};

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}
