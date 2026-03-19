/**
 * Custom log-update replacement for Ink (Tier 3 renderer).
 *
 * Replaces ink/build/log-update.js via esbuild plugin. Instead of Ink's
 * standard "erase everything + rewrite" approach (which causes clearTerminal
 * flicker when output exceeds viewport), this module OVERWRITES lines in
 * place — no moment where content is blank, no flicker even without DEC 2026.
 *
 * Strategy:
 *   1. Track cursor offset from the start of our output block
 *   2. Move cursor to top of block
 *   3. For each line: overwrite changed, skip unchanged, clear removed
 *   4. Restore cursor to a known offset at the end
 *
 * Tall content handling: when output exceeds the terminal's visible rows,
 * only the tail (last `realRows` lines) is written to screen. When content
 * grows, CSI S (Scroll Up) pushes old top lines into the terminal's
 * scrollback buffer so they remain accessible via tmux Ctrl+B [.
 * The diff tracks which slice of prevLines is actually on screen
 * (`prevScreenStart`) so subsequent renders diff correctly even across
 * tall↔short transitions.
 *
 * DEC Mode 2026 wrapping is handled by Ink's throttledLog — we don't nest.
 */

import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';

const create = (_stream: NodeJS.WriteStream, { showCursor = false } = {}) => {
  // Write to the REAL stdout — Ink passes a proxy with spoofed `rows`.
  const stream: NodeJS.WriteStream = (process as any).stdout;

  let prevLines: string[] = [];
  let prevOutput = '';
  let hasHiddenCursor = false;
  let cursorDirty = false;

  // Number of lines below the output origin the cursor currently sits.
  // Clamped to (realRows - 1) to avoid moving above the terminal's top.
  let cursorOffset = 0;

  // Track what's actually visible on screen for correct diffing.
  let prevRenderedCount = 0; // Number of lines on screen from previous render
  let prevScreenStart = 0;   // Index into prevLines of first on-screen line
  let prevRealRows = 0;      // Track terminal rows to detect resize
  let prevRealCols = 0;      // Track terminal columns to detect resize

  const render = (str: string): boolean => {
    if (!showCursor && !hasHiddenCursor) {
      cliCursor.hide(stream);
      hasHiddenCursor = true;
    }

    if (str === prevOutput && !cursorDirty) return false;
    cursorDirty = false;

    const nextLines = str.split('\n');
    // Ink appends '\n' — the trailing empty element from split is phantom.
    const hasTrailingNewline = str.endsWith('\n');
    const nextVisible = hasTrailingNewline ? nextLines.length - 1 : nextLines.length;
    const realRows = stream.rows ?? 50;

    // ── Resize detection: when terminal size changes, force full redraw ──
    const realCols = stream.columns ?? 80;
    let resizeCleared = false;
    if (prevRealRows > 0 && (realRows !== prevRealRows || realCols !== prevRealCols) && prevRenderedCount > 0) {
      resizeCleared = true;
      prevOutput = '';
      prevLines = [];
      cursorOffset = 0;
      prevRenderedCount = 0;
      prevScreenStart = 0;
      prevRealRows = realRows;
      prevRealCols = realCols;
      // Fall through to first-render path with clear prefix
    }
    prevRealRows = realRows;
    prevRealCols = realCols;

    const buf: string[] = [];

    // Prepend screen clear into the same write buffer so clear + content
    // are atomic — no gap for ghost frames between separate writes.
    if (resizeCleared) {
      buf.push('\x1b[2J\x1b[H');
    }

    if (prevRenderedCount === 0) {
      // ── First render: write line by line with \n (allows natural scrolling) ──
      for (let i = 0; i < nextVisible; i++) {
        buf.push('\r');
        buf.push(nextLines[i]!);
        buf.push('\x1b[K'); // clear to end of line
        if (i < nextVisible - 1) {
          buf.push('\n');
        }
      }
      // Cursor is on the last content line. Clamp offset to real terminal bounds.
      cursorOffset = Math.min(Math.max(0, nextVisible - 1), realRows - 1);
      if (nextVisible > realRows) {
        prevScreenStart = nextVisible - realRows;
        prevRenderedCount = realRows;
      } else {
        prevScreenStart = 0;
        prevRenderedCount = nextVisible;
      }
    } else {
      // ── Subsequent renders ──

      // Step 1: Move cursor to top of visible block (or as far up as possible).
      if (cursorOffset > 0) {
        buf.push(`\x1b[${cursorOffset}A`);
      }

      if (nextVisible > realRows) {
        // ── Tall content: output exceeds viewport ──
        const tailStart = nextVisible - realRows;

        // Determine how much content grew since last frame.
        const prevTotalVisible = prevScreenStart + prevRenderedCount;
        const growth = Math.max(0, nextVisible - prevTotalVisible);

        if (growth > 0) {
          // ── Content grew: push overflow to scrollback, then rewrite visible ──
          // Move cursor from row 0 to the bottom of previous visible content.
          // Natural \n from there fills empty rows (if any), then scrolls —
          // pushing old top lines into the terminal's scrollback buffer.
          // Only the overflow \n's are emitted (not a full content rewrite),
          // so scrollback receives each line exactly once with no duplication.
          const prevBottom = Math.min(prevRenderedCount, realRows) - 1;
          if (prevBottom > 0) {
            buf.push(`\x1b[${prevBottom}B`);
          }
          for (let g = 0; g < growth; g++) {
            buf.push('\n');
          }
          // Cursor is at row realRows - 1 (prevBottom + growth > realRows - 1
          // is always true in this branch). Move back to row 0 and rewrite
          // the entire visible area with the correct tail content.
          buf.push(`\x1b[${realRows - 1}A`);
          for (let row = 0; row < realRows; row++) {
            buf.push('\r');
            buf.push(nextLines[tailStart + row]!);
            buf.push('\x1b[K');
            if (row < realRows - 1) {
              buf.push('\x1b[1B');
            }
          }
        } else {
          // ── No growth — diff against prev screen content ──
          for (let row = 0; row < realRows; row++) {
            buf.push('\r');
            const nextIdx = tailStart + row;
            const prevIdx = prevScreenStart + row;
            const prevLine = prevIdx >= 0 && prevIdx < prevLines.length
              ? prevLines[prevIdx]
              : undefined;
            if (prevLine === undefined || nextLines[nextIdx] !== prevLine) {
              buf.push(nextLines[nextIdx]!);
              buf.push('\x1b[K');
            }
            if (row < realRows - 1) {
              buf.push('\x1b[1B');
            }
          }
        }
        cursorOffset = realRows - 1;
        prevScreenStart = tailStart;
        prevRenderedCount = realRows;
      } else {
        // ── Normal diff: output fits in viewport ──
        const maxLines = Math.max(nextVisible, prevRenderedCount);

        // Step 2: Process each line.
        for (let i = 0; i < maxLines; i++) {
          // Move to column 0 of this line
          buf.push('\r');

          if (i >= nextVisible) {
            // Extra old line — erase it
            buf.push('\x1b[2K');
          } else {
            // Diff against what's actually on screen
            const prevIdx = prevScreenStart + i;
            const prevLine = prevIdx >= 0 && prevIdx < prevLines.length
              ? prevLines[prevIdx]
              : undefined;
            if (prevLine === undefined || nextLines[i] !== prevLine) {
              // Changed or new line — overwrite in place
              buf.push(nextLines[i]!);
              buf.push('\x1b[K'); // erase any trailing old content
            }
            // Unchanged lines: cursor stays at column 0 — that's fine,
            // the existing content on screen is correct.
          }

          // Advance to the next line (unless this is the very last row)
          if (i < maxLines - 1) {
            buf.push('\x1b[1B'); // cursor down (no scroll, stays in buffer)
          }
        }

        // Step 3: cursor is now on line (maxLines - 1).
        // We want it at the correct offset for the next render cycle.
        const targetOffset = hasTrailingNewline ? nextVisible : Math.max(0, nextVisible - 1);
        const currentLine = maxLines - 1;

        if (currentLine < targetOffset) {
          // Need to move down (shouldn't normally happen)
          buf.push(`\x1b[${targetOffset - currentLine}B`);
        } else if (currentLine > targetOffset) {
          // Output shrunk — move back up
          buf.push(`\x1b[${currentLine - targetOffset}A`);
        }

        // Clamp to real terminal bounds
        cursorOffset = Math.min(targetOffset, realRows - 1);
        prevScreenStart = 0;
        prevRenderedCount = nextVisible;
      }
    }

    stream.write(buf.join(''));

    prevOutput = str;
    prevLines = nextLines;
    return true;
  };

  render.clear = () => {
    if (prevRenderedCount > 0) {
      // Move to top, then erase down
      if (cursorOffset > 0) {
        stream.write(`\x1b[${cursorOffset}A`);
      }
      stream.write(ansiEscapes.eraseLines(prevRenderedCount));
    }
    prevOutput = '';
    prevLines = [];
    cursorOffset = 0;
    prevRenderedCount = 0;
    prevScreenStart = 0;
    prevRealRows = 0;
    prevRealCols = 0;
  };

  render.done = () => {
    prevOutput = '';
    prevLines = [];
    cursorOffset = 0;
    prevRenderedCount = 0;
    prevScreenStart = 0;
    prevRealRows = 0;
    prevRealCols = 0;
    if (!showCursor) {
      cliCursor.show(stream);
      hasHiddenCursor = false;
    }
  };

  render.sync = (str: string) => {
    // Called by Ink to sync state after an external write (e.g., clearTerminal).
    const realRows = stream.rows ?? 50;
    prevRealRows = realRows;
    prevRealCols = stream.columns ?? 80;
    prevOutput = str;
    prevLines = str.split('\n');
    const hasTrailing = str.endsWith('\n');
    const visible = hasTrailing ? prevLines.length - 1 : prevLines.length;
    if (visible > realRows) {
      prevScreenStart = visible - realRows;
      prevRenderedCount = realRows;
    } else {
      prevScreenStart = 0;
      prevRenderedCount = visible;
    }
    cursorOffset = Math.min(
      hasTrailing ? visible : Math.max(0, visible - 1),
      realRows - 1,
    );
  };

  render.setCursorPosition = () => {
    // We manage our own cursor via MultiLineInput — unused.
    cursorDirty = true;
  };

  render.isCursorDirty = () => cursorDirty;
  render.willRender = (str: string) => str !== prevOutput || cursorDirty;

  return render;
};

export default { create };
