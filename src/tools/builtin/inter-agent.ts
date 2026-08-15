/**
 * Agent discovery — `list_agents` returns the live roster so an agent can
 * pick a recipient by username for `mcp__shizuha-connect__message_user`.
 *
 * The legacy `message_agent` tool was removed: it forced agents to know
 * whether the recipient was human or agent and broke when they got it
 * wrong. Connect routes by recipient identity, so one tool
 * (`message_user`) handles both cases. Use `list_agents` for discovery,
 * then call `mcp__shizuha-connect__message_user(recipient_username=…,
 * content=…)`.
 */
import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { requestAgentGatewayJson } from '../../auth/agent-gateway.js';

const AGENT_USERNAME = process.env['AGENT_USERNAME'] || 'unknown';

export const listAgentsTool: ToolHandler = {
  name: 'list_agents',
  description:
    'List all available agents you can talk to. To send a message to one, ' +
    'use `mcp__shizuha-connect__message_user(recipient_username=<username>, ' +
    'content=<message>)` — that tool handles both humans and agents.',
  parameters: z.object({}),
  readOnly: true,
  riskLevel: 'low',

  async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const response = await requestAgentGatewayJson('GET', '/v1/agents', undefined, 5000);
      const result = response.data as Record<string, unknown>;
      const agents = (result.agents ?? []) as Array<{ name: string; username: string; status: string }>;
      const list = agents
        .filter(a => a.username !== AGENT_USERNAME)
        .map(a => `- ${a.name} (@${a.username}) — ${a.status}`)
        .join('\n');
      return { toolUseId: '', content: list || 'No other agents available.' };
    } catch (err) {
      return { toolUseId: '', content: `Error listing agents: ${(err as Error).message}`, isError: true };
    }
  },
};
