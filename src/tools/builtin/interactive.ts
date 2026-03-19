/**
 * Interactive Reply Tool — lets agents send buttons, polls, and other
 * interactive payloads that channels render natively.
 *
 * GAP A: OpenClaw parity — interactive_reply built-in tool.
 */
import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { validateInteractivePayload, type InteractivePayload } from '../../gateway/interactive.js';

const ButtonSchema = z.object({
  text: z.string().max(64).describe('Button label'),
  callbackData: z.string().max(256).describe('Callback data sent when pressed'),
  style: z.enum(['default', 'primary', 'destructive']).optional().describe('Visual style'),
});

const PollSchema = z.object({
  question: z.string().max(300).describe('Poll question'),
  options: z.array(z.string().max(200)).min(2).max(10).describe('Poll options (2-10)'),
  maxSelections: z.number().int().min(1).max(10).optional().describe('Max selections per voter'),
  anonymous: z.boolean().optional().describe('Whether votes are anonymous'),
});

export const interactiveReplyTool: ToolHandler = {
  name: 'interactive_reply',
  description:
    'Send an interactive response with buttons or a poll. Channels that support ' +
    'interactive elements (Telegram, Discord, Slack) will render them natively. ' +
    'Other channels fall back to text.\n\n' +
    'Use action="buttons" to send a grid of clickable buttons.\n' +
    'Use action="poll" to create a poll.\n\n' +
    'Examples:\n' +
    '  interactive_reply(action="buttons", text="Choose an option:", buttons=[[{text:"Yes", callbackData:"yes"}, {text:"No", callbackData:"no"}]])\n' +
    '  interactive_reply(action="poll", question="Favorite language?", options=["TypeScript", "Python", "Rust"])',
  parameters: z.object({
    action: z.enum(['buttons', 'poll']).describe('Type of interactive element'),
    text: z.string().optional().describe('Accompanying text message (for buttons)'),
    buttons: z.array(z.array(ButtonSchema)).optional().describe('Rows of buttons (for action=buttons)'),
    question: z.string().optional().describe('Poll question (for action=poll)'),
    options: z.array(z.string()).optional().describe('Poll options (for action=poll)'),
    max_selections: z.number().optional().describe('Max poll selections (default: 1)'),
    anonymous: z.boolean().optional().describe('Anonymous poll (default: false)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (this as any).parameters.parse(params);

    let payload: InteractivePayload | null = null;

    if (args.action === 'buttons') {
      if (!args.buttons || args.buttons.length === 0) {
        return { toolUseId: '', content: 'Error: buttons array is required for action="buttons"', isError: true };
      }
      payload = validateInteractivePayload({ buttons: args.buttons });
    } else if (args.action === 'poll') {
      if (!args.question || !args.options || args.options.length < 2) {
        return { toolUseId: '', content: 'Error: question and at least 2 options required for action="poll"', isError: true };
      }
      payload = validateInteractivePayload({
        poll: {
          question: args.question,
          options: args.options,
          maxSelections: args.max_selections,
          anonymous: args.anonymous,
        },
      });
    }

    if (!payload) {
      return { toolUseId: '', content: 'Error: invalid interactive payload', isError: true };
    }

    // The payload is returned as structured metadata — the channel delivery layer
    // reads it and renders natively (Telegram inline keyboards, Discord components, etc.)
    const text = args.text || (payload.poll ? `Poll: ${payload.poll.question}` : 'Please choose:');

    // Build text fallback for channels that don't support interactive elements
    let fallback = text;
    if (payload.buttons) {
      fallback += '\n\nOptions:';
      for (const row of payload.buttons) {
        for (const btn of row) {
          fallback += `\n  [${btn.text}]`;
        }
      }
    }
    if (payload.poll) {
      fallback += `\n\n${payload.poll.question}`;
      payload.poll.options.forEach((opt, i) => {
        fallback += `\n  ${i + 1}. ${opt}`;
      });
    }

    return {
      toolUseId: '',
      content: fallback,
      metadata: {
        interactive: payload,
        text,
      },
    };
  },
};
