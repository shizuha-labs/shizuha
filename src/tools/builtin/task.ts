import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { spawnSubAgent } from '../../agent/sub-agent.js';
import { logger } from '../../utils/logger.js';

export const taskTool: ToolHandler = {
  name: 'task',
  description:
    'Launch a sub-agent to handle a complex task autonomously. ' +
    'The sub-agent runs with its own isolated context and all available tools. ' +
    'Use for parallelizable or independent work — launch multiple tasks concurrently ' +
    'in a single response for maximum throughput.\n\n' +
    'Usage notes:\n' +
    '1. Launch multiple tasks concurrently whenever possible (multiple tool_use blocks in one response)\n' +
    '2. Each task is stateless — include all necessary context in the prompt\n' +
    '3. The sub-agent result is returned to you but NOT shown to the user — summarize it yourself\n' +
    '4. Be specific: tell the sub-agent exactly what to do, which files to create/modify, and what to return',
  parameters: z.object({
    description: z.string().describe('Short description of the task (3-5 words)'),
    prompt: z.string().describe('Detailed task instructions for the sub-agent. Include all necessary context.'),
  }),
  readOnly: true, // read-only from the parent's perspective (sub-agent handles its own writes)
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { description, prompt } = this.parameters.parse(params);

    if (!context.agentConfig) {
      return {
        toolUseId: '',
        content: `[Task "${description}" cannot run — no agent config available]`,
        isError: true,
      };
    }

    const startTime = Date.now();
    logger.info({ description }, 'Task tool: spawning sub-agent');

    try {
      const result = await spawnSubAgent(context.agentConfig, {
        description,
        prompt,
        cwd: context.cwd,
      });

      const summary = [
        `Sub-agent "${description}" completed in ${(result.durationMs / 1000).toFixed(1)}s`,
        `Turns: ${result.turns}, Tokens: ${result.inputTokens}in/${result.outputTokens}out`,
        result.hadError ? '(completed with errors)' : '',
        '',
        result.output,
      ].join('\n');

      return {
        toolUseId: '',
        content: summary,
        isError: result.hadError,
      };
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.error({ err, description, elapsed }, 'Task tool: sub-agent failed');
      return {
        toolUseId: '',
        content: `Sub-agent "${description}" failed after ${elapsed}s: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
