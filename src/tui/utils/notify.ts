const IS_TMUX = Boolean(process.env['TMUX']);

/** Send desktop notification via terminal escape sequences.
 *  Uses stderr to avoid corrupting Ink's stdout cursor tracking.
 *  Terminal sequences work on stderr because they target the TTY device,
 *  not the stream.  In tmux, skip OSC sequences that can confuse the
 *  terminal multiplexer.  Tmux forwards BEL natively. */
export function notifyTaskComplete(summary?: string): void {
  const msg = summary ?? 'Task complete';
  // BEL character — triggers terminal bell / notification (tmux-safe)
  process.stderr.write('\x07');
  if (!IS_TMUX) {
    // OSC 777 notification (supported by some terminals like iTerm2, Kitty)
    process.stderr.write(`\x1b]777;notify;Shizuha;${msg}\x07`);
    // OSC 9 notification (supported by Windows Terminal, ConEmu)
    process.stderr.write(`\x1b]9;${msg}\x07`);
  }
}
