/**
 * SCLI-243: Shizuha CLI TUI theme — semantic color roles adapted from pi's
 * dark theme (badlogic/pi-mono, packages/coding-agent interactive theme
 * `dark.json`; MIT). One module owns every color; components reference roles,
 * never raw ANSI names, so the palette stays coherent and swappable.
 *
 * Values are truecolor hexes; Ink/chalk automatically downsamples to the
 * nearest ANSI-256/16 color on terminals without truecolor support.
 */

export const theme = {
  // ── message types ──────────────────────────────────────────────────────
  /** "You" label + user-message accents (pi: blue #5f87ff). */
  user: '#5f87ff',
  /** Assistant label (pi: accent teal — calm, distinct from user blue). */
  assistant: '#8abeb7',
  /** Tool call titles (pi: cyan — active/attention without alarm). */
  tool: '#00d7ff',
  /** System/info + de-emphasized content (pi: gray). */
  muted: '#808080',
  /** Deeply de-emphasized (pi: dimGray) — reasoning, separators, hints. */
  dim: '#666666',

  // ── semantic states ────────────────────────────────────────────────────
  success: '#b5bd68',   // pi green
  error: '#cc6666',     // pi red
  warning: '#ffff00',   // pi yellow

  // ── accents ────────────────────────────────────────────────────────────
  /** File paths, inline code, key highlights (pi: accent). */
  accent: '#8abeb7',
  /** Links (pi: mdLink). */
  link: '#81a2be',
  /** Markdown headings (pi: mdHeading). */
  heading: '#f0c674',
  /** Code blocks (pi: mdCodeBlock). */
  codeBlock: '#b5bd68',

  // ── chrome ─────────────────────────────────────────────────────────────
  /** Status-bar text + quiet chrome (pi: gray). */
  chrome: '#808080',
  /** Divider/border lines (pi: borderMuted — quiet, not neon). */
  border: '#505050',
  /** Emphasized border/active pane (pi: borderAccent). */
  borderActive: '#00d7ff',

  // ── diffs ──────────────────────────────────────────────────────────────
  diffAdded: '#b5bd68',
  diffRemoved: '#cc6666',
  diffContext: '#808080',
  diffHeader: '#00d7ff',
} as const;

export type ThemeRole = keyof typeof theme;
