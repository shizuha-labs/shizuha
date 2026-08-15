import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const mouseTool: ToolHandler = {
  name: 'mouse',
  description:
    'Control the mouse in a human-mode browser session. Moves the cursor with realistic bezier curves ' +
    '(like a real human hand), clicks, double-clicks, drags, or scrolls. Requires an active browser ' +
    'session in human mode. Use the browser screenshot action first to identify target coordinates.',
  parameters: z.object({
    action: z.enum(['move', 'click', 'double_click', 'right_click', 'drag', 'scroll']).describe(
      'The mouse action to perform',
    ),
    x: z.number().optional().describe('Target X coordinate (required for move, click, drag start)'),
    y: z.number().optional().describe('Target Y coordinate (required for move, click, drag start)'),
    to_x: z.number().optional().describe('Drag destination X coordinate (required for drag)'),
    to_y: z.number().optional().describe('Drag destination Y coordinate (required for drag)'),
    delta: z.number().optional().describe('Scroll amount — positive = down, negative = up (required for scroll)'),
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
        content: 'Mouse tool requires the browser to be in human mode. Start a browser session with mode: "human" first.',
        isError: true,
      };
    }

    const mouse = human.getMouse();

    try {
      switch (input.action) {
        case 'move': {
          if (input.x === undefined || input.y === undefined) {
            return { toolUseId: '', content: 'x and y coordinates are required for move.', isError: true };
          }
          await mouse.moveTo(input.x, input.y);
          return { toolUseId: '', content: `Mouse moved to (${input.x}, ${input.y})` };
        }
        case 'click': {
          if (input.x !== undefined && input.y !== undefined) {
            await mouse.clickAt(input.x, input.y);
            return { toolUseId: '', content: `Clicked at (${input.x}, ${input.y})` };
          }
          await mouse.click('left');
          return { toolUseId: '', content: 'Clicked at current position' };
        }
        case 'right_click': {
          if (input.x !== undefined && input.y !== undefined) {
            await mouse.clickAt(input.x, input.y, 'right');
            return { toolUseId: '', content: `Right-clicked at (${input.x}, ${input.y})` };
          }
          await mouse.click('right');
          return { toolUseId: '', content: 'Right-clicked at current position' };
        }
        case 'double_click': {
          if (input.x !== undefined && input.y !== undefined) {
            await mouse.moveTo(input.x, input.y);
          }
          await mouse.doubleClick();
          return { toolUseId: '', content: `Double-clicked at (${mouse.x}, ${mouse.y})` };
        }
        case 'drag': {
          if (input.x === undefined || input.y === undefined || input.to_x === undefined || input.to_y === undefined) {
            return { toolUseId: '', content: 'x, y, to_x, and to_y are required for drag.', isError: true };
          }
          await mouse.moveTo(input.x, input.y);
          await mouse.drag(input.to_x, input.to_y);
          return { toolUseId: '', content: `Dragged from (${input.x}, ${input.y}) to (${input.to_x}, ${input.to_y})` };
        }
        case 'scroll': {
          if (input.delta === undefined) {
            return { toolUseId: '', content: 'delta is required for scroll.', isError: true };
          }
          await mouse.scroll(input.delta);
          return { toolUseId: '', content: `Scrolled ${input.delta > 0 ? 'down' : 'up'} by ${Math.abs(input.delta)}` };
        }
        default:
          return { toolUseId: '', content: `Unknown action: ${input.action}`, isError: true };
      }
    } catch (err) {
      return { toolUseId: '', content: `Mouse error: ${(err as Error).message}`, isError: true };
    }
  },
};
