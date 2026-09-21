/**
 * SCLI-519 routing policy for slash-command result messages.
 *
 * A slash command (e.g. `/doctor`) returns a display string. Short,
 * single-line notices belong in the transient `statusMessage` slot. Multi-line
 * diagnostic blocks MUST be rendered as transcript rows instead: the transcript
 * viewport is virtualized and height-measured, so it can never be overwritten
 * by the persistent header/status chrome — whereas the single-line status slot
 * plus the fixed-chrome WelcomeArt collapse when a tall block sits above them
 * and the header redraw overwrote diagnostic rows (SCLI-519 @120x40).
 */
export type SlashMessageKind = 'status' | 'transcript';

export function slashMessageKind(message: string | undefined | null): SlashMessageKind {
  const text = message ?? '';
  return text.includes('\n') ? 'transcript' : 'status';
}
