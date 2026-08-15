import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const keyboardTool: ToolHandler = {
  name: 'keyboard',
  description:
    'Type text or press keys in a human-mode browser session with realistic human timing. ' +
    'Supports typing text (with natural inter-key delays), pressing individual keys, keyboard ' +
    'shortcuts (hotkeys like Ctrl+C), and hold/release for modifier keys. Requires an active ' +
    'browser session in human mode.',
  parameters: z.object({
    action: z.enum(['type', 'press', 'hotkey', 'hold', 'release']).describe(
      'The keyboard action to perform',
    ),
    text: z.string().optional().describe('Text to type with human-like timing (required for "type")'),
    key: z.string().optional().describe(
      'Key name for press/hold/release (e.g., "enter", "tab", "escape", "backspace", "f5", "up", "down")',
    ),
    modifiers: z.array(z.string()).optional().describe(
      'Modifier keys for hotkey (e.g., ["ctrl"], ["ctrl", "shift"])',
    ),
    target_key: z.string().optional().describe(
      'Target key for hotkey (e.g., "a" for Ctrl+A, "l" for Ctrl+L)',
    ),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const input = this.parameters.parse(params);

    let browserManager: typeof import('../../browser/manager.js')['browserManager'];
    try {
      const mod = await import('../../browser/manager.js');
      browserManager = mod.browserManager;
    } catch {
      return { toolUseId: '', content: 'Browser module not available.', isError: true };
    }

    const session = browserManager.getSession(context.sessionId, 'human');
    const human = session.humanSession;
    if (!human) {
      return {
        toolUseId: '',
        content: 'Keyboard tool requires the browser to be in human mode. Start a browser session with mode: "human" first.',
        isError: true,
      };
    }

    const keyboard = human.getKeyboard();

    try {
      switch (input.action) {
        case 'type': {
          if (!input.text) {
            return { toolUseId: '', content: 'text is required for type action.', isError: true };
          }
          await keyboard.typeText(input.text);
          const preview = input.text.length > 50 ? input.text.slice(0, 50) + '...' : input.text;
          return { toolUseId: '', content: `Typed: "${preview}"` };
        }
        case 'press': {
          if (!input.key) {
            return { toolUseId: '', content: 'key is required for press action.', isError: true };
          }
          await keyboard.pressKey(input.key);
          return { toolUseId: '', content: `Pressed: ${input.key}` };
        }
        case 'hotkey': {
          if (!input.modifiers?.length || !input.target_key) {
            return { toolUseId: '', content: 'modifiers and target_key are required for hotkey action.', isError: true };
          }
          await keyboard.hotkey(input.modifiers, input.target_key);
          return { toolUseId: '', content: `Hotkey: ${input.modifiers.join('+')}+${input.target_key}` };
        }
        case 'hold': {
          if (!input.key) {
            return { toolUseId: '', content: 'key is required for hold action.', isError: true };
          }
          keyboard.holdKey(input.key);
          return { toolUseId: '', content: `Holding: ${input.key}` };
        }
        case 'release': {
          if (!input.key) {
            return { toolUseId: '', content: 'key is required for release action.', isError: true };
          }
          keyboard.releaseKey(input.key);
          return { toolUseId: '', content: `Released: ${input.key}` };
        }
        default:
          return { toolUseId: '', content: `Unknown action: ${input.action}`, isError: true };
      }
    } catch (err) {
      return { toolUseId: '', content: `Keyboard error: ${(err as Error).message}`, isError: true };
    }
  },
};
