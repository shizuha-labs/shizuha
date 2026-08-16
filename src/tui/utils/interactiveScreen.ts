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
