import { z } from 'zod';
import * as readline from 'node:readline/promises';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

/** TUI callback for ask_user — when set, TUI owns stdin */
type AskUserCallback = (question: string) => Promise<string>;
let _askUserCallback: AskUserCallback | null = null;

/** Set the ask_user callback (TUI uses this to own stdin) */
export function setAskUserCallback(cb: AskUserCallback | null): void {
  _askUserCallback = cb;
}

export const askUserTool: ToolHandler = {
  name: 'ask_user',
  description:
    'Ask the user a question and wait for their response. Use when you need clarification or approval.',
  parameters: z.object({
    question: z.string().describe('The question to ask the user'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { question } = this.parameters.parse(params);

    // TUI mode: use injected callback
    if (_askUserCallback) {
      const answer = await _askUserCallback(question);
      return { toolUseId: '', content: answer.trim() || '[No response]' };
    }

    // In CLI mode, read from stdin
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(`\n[Agent asks]: ${question}\n> `);
        return { toolUseId: '', content: answer.trim() || '[No response]' };
      } finally {
        rl.close();
      }
    }

    // In non-interactive mode (HTTP API), return a placeholder
    return {
      toolUseId: '',
      content: '[Non-interactive mode: cannot ask user. Proceeding with best judgment.]',
    };
  },
};
