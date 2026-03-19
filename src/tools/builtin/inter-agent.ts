/**
 * Inter-agent communication tools — allows agents to message each other.
 * Works by calling the daemon's /v1/agents/:id/ask HTTP API.
 */
import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { requestAgentGatewayJson } from '../../auth/agent-gateway.js';

const AGENT_USERNAME = process.env['AGENT_USERNAME'] || 'unknown';

export const messageAgentTool: ToolHandler = {
  name: 'message_agent',
  description:
    'Send a message to another agent and get their response. ' +
    'Use this to delegate tasks, ask questions, or coordinate with other agents.\n\n' +
    'Examples:\n' +
    '  message_agent(target="claw", message="Tell me a joke")\n' +
    '  message_agent(target="claude", message="Review this code for security issues")',
  parameters: z.object({
    target: z.string().describe('Target agent username (e.g., "claw", "claude", "shizuhacodex")'),
    message: z.string().describe('Message to send'),
    timeout_seconds: z.number().optional().default(60).describe('Max wait in seconds'),
  }),
  readOnly: true,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { target, message, timeout_seconds } = (this as any).parameters.parse(params);
    const timeout = timeout_seconds * 1000;

    try {
      const response = await requestAgentGatewayJson(
        'POST',
        `/v1/agents/${encodeURIComponent(target)}/ask`,
        { content: message, from_agent: AGENT_USERNAME, timeout },
        timeout + 5000,
      );
      const result = response.data as Record<string, unknown>;
      if (result.ok) {
        return { toolUseId: '', content: `[${result.from}]: ${result.response}` };
      }
      return { toolUseId: '', content: `Error: ${result.error || 'unknown error'}`, isError: true };
    } catch (err) {
      return { toolUseId: '', content: `Failed to contact agent "${target}": ${(err as Error).message}`, isError: true };
    }
  },
};

export const listAgentsTool: ToolHandler = {
  name: 'list_agents',
  description: 'List all available agents that you can communicate with via message_agent.',
  parameters: z.object({}),
  readOnly: true,
  riskLevel: 'low',

  async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const response = await requestAgentGatewayJson('GET', '/v1/agents', undefined, 5000);
      const result = response.data as Record<string, unknown>;
      const agents = (result.agents ?? []) as Array<{ name: string; username: string; status: string }>;
      const list = agents
        .filter(a => a.username !== AGENT_USERNAME) // Don't list self
        .map(a => `- ${a.name} (@${a.username}) — ${a.status}`)
        .join('\n');
      return { toolUseId: '', content: list || 'No other agents available.' };
    } catch (err) {
      return { toolUseId: '', content: `Error listing agents: ${(err as Error).message}`, isError: true };
    }
  },
};
