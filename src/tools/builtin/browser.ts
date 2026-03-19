import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const browserTool: ToolHandler = {
  name: 'browser',
  description:
    'Automate a headless browser (Chromium via Playwright). Supports navigating to URLs, taking ' +
    'screenshots, clicking elements, filling forms, scrolling, extracting text, running JavaScript, ' +
    'and navigating back. The browser session persists across calls within the same conversation. ' +
    'Start by navigating to a URL, then interact with the page.',
  parameters: z.object({
    action: z.enum([
      'navigate',
      'screenshot',
      'click',
      'type',
      'scroll',
      'get_text',
      'evaluate',
      'back',
      'close',
    ]).describe('The browser action to perform'),
    url: z.string().optional().describe('URL to navigate to (required for "navigate")'),
    selector: z.string().optional().describe('CSS selector for the target element (required for "click" and "type", optional for "get_text")'),
    text: z.string().optional().describe('Text to type into the element (required for "type")'),
    direction: z.enum(['up', 'down']).optional().describe('Scroll direction (required for "scroll")'),
    script: z.string().optional().describe('JavaScript code to evaluate in the page context (required for "evaluate")'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const input = this.parameters.parse(params);

    // Dynamic import — handle Playwright not being installed
    let browserManager: typeof import('../../browser/manager.js')['browserManager'];
    try {
      const mod = await import('../../browser/manager.js');
      browserManager = mod.browserManager;
    } catch {
      return {
        toolUseId: '',
        content:
          'Browser tool requires Playwright. Install it with:\n' +
          '  npm install playwright\n' +
          '  npx playwright install chromium',
        isError: true,
      };
    }

    try {
      const session = browserManager.getSession(context.sessionId);

      switch (input.action) {
        case 'navigate': {
          if (!input.url) {
            return { toolUseId: '', content: 'The "url" parameter is required for the "navigate" action.', isError: true };
          }
          const result = await session.navigate(input.url);
          return { toolUseId: '', content: result };
        }

        case 'screenshot': {
          const base64 = await session.screenshot();
          return {
            toolUseId: '',
            content: 'Screenshot captured.',
            image: { base64, mediaType: 'image/png' },
          };
        }

        case 'click': {
          if (!input.selector) {
            return { toolUseId: '', content: 'The "selector" parameter is required for the "click" action.', isError: true };
          }
          const result = await session.click(input.selector);
          return { toolUseId: '', content: result };
        }

        case 'type': {
          if (!input.selector) {
            return { toolUseId: '', content: 'The "selector" parameter is required for the "type" action.', isError: true };
          }
          if (input.text === undefined) {
            return { toolUseId: '', content: 'The "text" parameter is required for the "type" action.', isError: true };
          }
          const result = await session.type(input.selector, input.text);
          return { toolUseId: '', content: result };
        }

        case 'scroll': {
          if (!input.direction) {
            return { toolUseId: '', content: 'The "direction" parameter is required for the "scroll" action.', isError: true };
          }
          const result = await session.scroll(input.direction);
          return { toolUseId: '', content: result };
        }

        case 'get_text': {
          const text = await session.getText(input.selector);
          if (!text) {
            return { toolUseId: '', content: '(No text content found on page)' };
          }
          return { toolUseId: '', content: text };
        }

        case 'evaluate': {
          if (!input.script) {
            return { toolUseId: '', content: 'The "script" parameter is required for the "evaluate" action.', isError: true };
          }
          const result = await session.evaluate(input.script);
          return { toolUseId: '', content: result ?? '(no return value)' };
        }

        case 'back': {
          const result = await session.back();
          return { toolUseId: '', content: result };
        }

        case 'close': {
          const result = await session.close();
          return { toolUseId: '', content: result };
        }

        default:
          return { toolUseId: '', content: `Unknown action: ${input.action as string}`, isError: true };
      }
    } catch (err) {
      const message = (err as Error).message;

      // Check for common Playwright installation issues
      if (message.includes('Executable doesn\'t exist') || message.includes('browserType.launch')) {
        return {
          toolUseId: '',
          content:
            `Browser error: ${message}\n\n` +
            'Playwright browsers may not be installed. Run:\n' +
            '  npx playwright install chromium',
          isError: true,
        };
      }

      return { toolUseId: '', content: `Browser error: ${message}`, isError: true };
    }
  },
};
