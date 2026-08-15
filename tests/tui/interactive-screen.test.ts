import { describe, expect, it } from 'vitest';
import {
  ENTER_INTERACTIVE_SCREEN,
  LEAVE_INTERACTIVE_SCREEN,
  enterInteractiveScreen,
  leaveInteractiveScreen,
} from '../../src/tui/utils/interactiveScreen.js';

describe('interactive terminal lifecycle', () => {
  it('owns one alternate screen and restores mouse/cursor modes idempotently', () => {
    const writes: string[] = [];
    const stream = {
      isTTY: true,
      write: (chunk: string) => { writes.push(chunk); return true; },
    } as unknown as NodeJS.WriteStream;

    expect(enterInteractiveScreen(stream)).toBe(true);
    expect(enterInteractiveScreen(stream)).toBe(false);
    expect(leaveInteractiveScreen()).toBe(true);
    expect(leaveInteractiveScreen()).toBe(false);
    expect(writes).toEqual([ENTER_INTERACTIVE_SCREEN, LEAVE_INTERACTIVE_SCREEN]);
    expect(ENTER_INTERACTIVE_SCREEN).toContain('\x1b[?1049h');
    expect(ENTER_INTERACTIVE_SCREEN).toContain('\x1b[?1006h');
    expect(LEAVE_INTERACTIVE_SCREEN).toContain('\x1b[?1006l');
    expect(LEAVE_INTERACTIVE_SCREEN).toContain('\x1b[?1049l');
  });
});
