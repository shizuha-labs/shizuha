/**
 * DECSTBM scroll-region emitters (PLAT-7382).
 *
 * When mouse reporting is ON, wheel events scroll the conversation viewport
 * via terminal-native scroll-region mechanics instead of an Ink repaint: the
 * region is set to the viewport's absolute screen rows, SU/SD scrolls the
 * region's content natively, and the region is reset — all wrapped in
 * DECSC/DECRC so Ink's cursor position is untouched. The visual scroll
 * happens in the terminal; the app's scroll model syncs silently (no state
 * change, no repaint), so long transcripts scroll smoothly without
 * full-frame repaint artifacts.
 */

const ESC = '\x1b';

export interface ScrollRegionSpec {
  /** 1-indexed absolute top row of the scroll region (inclusive). */
  top: number;
  /** 1-indexed absolute bottom row of the scroll region (inclusive). */
  bottom: number;
  /** Positive = scroll content up (reveal lower lines); negative = down. */
  lines: number;
}

/**
 * Build the byte sequence that scrolls `spec.lines` within the region
 * [top, bottom] and leaves terminal state exactly as it was found.
 *
 * CSI S/T (SU/SD) operate on the DECSTBM region when one is set (xterm,
 * ECMA-48). The region is reset after the scroll so a later Ink repaint or
 * crash never inherits a shrunken scrolling context.
 */
export function buildScrollRegionSequence(spec: ScrollRegionSpec): string {
  const { top, bottom, lines } = spec;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(lines)) {
    return '';
  }
  if (top < 1 || bottom < top || lines === 0) {
    return '';
  }
  const scroll = lines > 0 ? `${ESC}[${lines}S` : `${ESC}[${-lines}T`; // SD takes a positive count — negate the wheel-up delta
  return (
    ESC + '7' + // DECSC — save cursor
    `${ESC}[${top};${bottom}r` + // DECSTBM — set the region
    scroll + // SU/SD — scroll within the region
    `${ESC}[r` + // DECSTBM reset — full-screen region restored
    ESC + '8' // DECRC — restore cursor
  );
}

/**
 * True when the wheel event should drive scroll-region mechanics: mouse
 * reporting is ON (the user's sticky /mouse preference) and the viewport
 * geometry is known. With /mouse off the wheel belongs to tmux/terminal
 * scrollback (beta#330) and this returns false — behavior unchanged.
 */
export function shouldUseScrollRegion(
  _mouseReporting: boolean | undefined,
  _geometry: { top: number; bottom: number } | null,
): boolean {
  // Always false. PLAT-7382's DECSTBM wheel path scrolled the *terminal
  // cells* without painting newly revealed transcript rows, so wheel-down
  // at the bottom filled the region with blanks and wheel-up showed empty
  // canvas until the next Ink repaint. PgUp/PgDn already used the Ink
  // scroll model (correct). The wheel now uses that same path.
  return false;
}
