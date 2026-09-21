/** Terminal lifecycle for the fullscreen, internally-scrolled TUI. */

export const ENTER_INTERACTIVE_SCREEN =
  '\x1b[?1049h' // alternate screen
  + '\x1b[?1000h' // button + wheel events
  + '\x1b[?1006h' // SGR mouse coordinates
  + '\x1b[?25l' // hide the hardware cursor; InputBox paints its own
  + '\x1b[H\x1b[2J';

export const LEAVE_INTERACTIVE_SCREEN =
  '\x1b[?1006l'
  + '\x1b[?1000l'
  + '\x1b[?25h'
  + '\x1b[?1049l';

// SCLI-479: runtime mouse-capture toggle. Disabling DECSET 1000/1006 hands the
// wheel back to tmux/terminal scrollback (no Ctrl-B needed); enabling restores
// the TUI's internal viewport scrolling. The choice is persisted in settings.
export const ENABLE_MOUSE_REPORTING = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_MOUSE_REPORTING = '\x1b[?1006l\x1b[?1000l';

let activeStream: NodeJS.WriteStream | null = null;

export function enterInteractiveScreen(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (!stream.isTTY || activeStream) return false;
  activeStream = stream;
  stream.write(ENTER_INTERACTIVE_SCREEN);
  return true;
}

export function leaveInteractiveScreen(): boolean {
  if (!activeStream) return false;
  const stream = activeStream;
  activeStream = null;
  stream.write(LEAVE_INTERACTIVE_SCREEN);
  return true;
}

/** Drop a leftover DECSTBM region without wiping Ink's current frame. */
export function resetScrollRegion(stream: NodeJS.WriteStream = process.stdout): void {
  try {
    if (!stream.isTTY) return;
    stream.write('\x1b[r');
  } catch {
    // ignore
  }
}

/** Reset DECSTBM and clear the canvas. Use only when Ink is about to mount a
 *  *new* tree onto a screen a raw writer (the pager) just owned. */
export function resetTuiCanvas(stream: NodeJS.WriteStream = process.stdout): void {
  try {
    if (!stream.isTTY) return;
    stream.write('\x1b[r\x1b[H\x1b[2J\x1b[0m');
  } catch {
    // ignore
  }
}

/**
 * Enable or disable SGR mouse capture at runtime. Returns false when the
 * interactive screen is not active (no stream to write to).
 */
export function setMouseReporting(enabled: boolean, stream: NodeJS.WriteStream = process.stdout): boolean {
  if (!stream.isTTY) return false;
  stream.write(enabled ? ENABLE_MOUSE_REPORTING : DISABLE_MOUSE_REPORTING);
  return true;
}
