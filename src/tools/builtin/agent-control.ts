/**
 * Agent Control Tools — pause/resume agents via the daemon API.
 *
 * GAP D: OpenClaw parity — agents can control each other.
 */
import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { requestAgentGatewayJson } from '../../auth/agent-gateway.js';

export const pauseAgentTool: ToolHandler = {
  name: 'pause_agent',
  description:
    'Pause another agent — stops it from processing new inbox messages while keeping ' +
    'its container running. The agent can be resumed later.\n\n' +
    'Example: pause_agent(target="kai")',
  parameters: z.object({
    target: z.string().describe('Target agent username or ID'),
    reason: z.string().optional().describe('Reason for pausing'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { target, reason } = (this as any).parameters.parse(params);
    try {
      const response = await requestAgentGatewayJson(
        'POST',
        `/v1/agents/${encodeURIComponent(target)}/pause`,
        { reason: reason || 'Paused via agent control' },
        10000,
      );
      const result = response.data as Record<string, unknown>;
      if (result.ok || result.status === 'paused') {
        return { toolUseId: '', content: `Agent "${target}" has been paused.${reason ? ` Reason: ${reason}` : ''}` };
      }
      return { toolUseId: '', content: `Failed to pause "${target}": ${result.error || 'unknown error'}`, isError: true };
    } catch (err) {
      return { toolUseId: '', content: `Error pausing agent "${target}": ${(err as Error).message}`, isError: true };
    }
  },
};

export const resumeAgentTool: ToolHandler = {
  name: 'resume_agent',
  description:
    'Resume a paused agent — allows it to start processing inbox messages again.\n\n' +
    'Example: resume_agent(target="kai")',
  parameters: z.object({
    target: z.string().describe('Target agent username or ID'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { target } = (this as any).parameters.parse(params);
    try {
      const response = await requestAgentGatewayJson(
        'POST',
        `/v1/agents/${encodeURIComponent(target)}/resume`,
        {},
        10000,
      );
      const result = response.data as Record<string, unknown>;
      if (result.ok || result.status === 'resumed') {
        return { toolUseId: '', content: `Agent "${target}" has been resumed.` };
      }
      return { toolUseId: '', content: `Failed to resume "${target}": ${result.error || 'unknown error'}`, isError: true };
    } catch (err) {
      return { toolUseId: '', content: `Error resuming agent "${target}": ${(err as Error).message}`, isError: true };
    }
  },
};
