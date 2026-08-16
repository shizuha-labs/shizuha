/**
 * `message_user` built-in tool — agent's primary path to deliver a message
 * to any user (human or agent) on the configured backend.
 *
 * In linked mode (BACKEND_URL = real platform) this works against shizuha-
 * connect's `MessageUserView`. In daemon-only mode (BACKEND_URL = daemon's
 * mini-Connect) it works against the mini-Connect's `/messaging/dm/` endpoint.
 * Either way, the agent's natural turn output stays private and ONLY this
 * tool delivers user-visible text.
 *
 * Built-in equivalent of `mcp__shizuha-connect__message_user` for
 * deployments where the Python MCP server isn't reachable (true daemon-only).
 */

import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { sendConnectDm } from '../../platform/connect-dm.js';

const AGENT_USERNAME = process.env['AGENT_USERNAME'] || 'agent';

export const messageUserTool: ToolHandler = {
  name: 'message_user',
  description:
    'Send a direct message to any user (human or agent) on the configured backend. ' +
    'THE primary mechanism for replying — natural LLM turn output is private and is ' +
    'never delivered. To reach the sender of a message (or any other user), call this tool. ' +
    'Address by EITHER `recipient_username` (preferred — looked up on the backend) OR ' +
    '`recipient_email` (when you only have an email). Both paths work whether the ' +
    'backend is the real platform or the local daemon mini-Connect.\n\n' +
    'Examples:\n' +
    '  message_user(recipient_username="hritik", content="pong")\n' +
    '  message_user(recipient_username="kai", content="please review AT-91")',
  parameters: z.object({
    recipient_username: z.string().optional().describe(
      'Backend username of the recipient (preferred). Inbound messages arrive prefixed `[username]`.',
    ),
    recipient_email: z.string().optional().describe(
      'Recipient email (alternative to recipient_username). Use when you only have the email.',
    ),
    content: z.string().describe('Message body. Markdown supported. Be concise and self-contained.'),
    client_message_id: z.string().optional().describe(
      'Optional UUID for idempotency. Same id retried returns the original message without duplicating.',
    ),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const parsed = (this as unknown as { parameters: typeof messageUserTool['parameters'] }).parameters.parse(params);
    const recipientUsername = (parsed.recipient_username || '').trim();
    const recipientEmail = (parsed.recipient_email || '').trim();
    const content = (parsed.content || '').trim();
    const clientMessageId = (parsed.client_message_id || '').trim() || undefined;

    if (!recipientUsername && !recipientEmail) {
      return {
        toolUseId: '',
        content: 'Error: provide either recipient_username (e.g. "hritik") or recipient_email.',
        isError: true,
      };
    }
    if (!content) {
      return { toolUseId: '', content: 'Error: content is required.', isError: true };
    }

    const result = await sendConnectDm({
      recipientUsername,
      recipientEmail,
      content,
      clientMessageId,
      sender: {
        username: AGENT_USERNAME,
        agentId: process.env['AGENT_ID'] || undefined,
      },
    });
    if (!result.ok) {
      return {
        toolUseId: '',
        content: `Failed to send message: ${result.error || 'unknown error'}`,
        isError: true,
      };
    }
    const label = recipientUsername || recipientEmail;
    const recipientName = result.recipient?.name || label;
    const idempotent = result.idempotentReplay ? ' (idempotent replay — no duplicate)' : '';
    const newConv = result.createdNew ? ' (started a new conversation)' : '';
    return {
      toolUseId: '',
      content: `Message delivered to ${recipientName} via Connect.${newConv}${idempotent}`,
    };
  },
};
