/**
 * Unit tests for diffLogUpdate source-backed scrollback reflow on terminal
 * resize (SCLI-480).
 *
 * The renderer replaces ink/build/log-update.js and writes to process.stdout.
 * On a terminal-size change it must:
 *   1. Clear the screen AND the terminal scrollback (CSI 3 J) so stale-width
 *      wrapped lines do not survive in scrollback.
 *   2. Re-emit the FULL source from the top so the terminal re-wraps every
 *      finalized line at the new width (copy/paste stays faithful).
 *
 * These are deterministic renderer-level assertions (no tmux/PTY required);
 * the tmux e2e suite covers the live resize path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import diffLogUpdate from '../../src/tui/renderer/diffLogUpdate';

interface FakeStream {
  rows: number;
  columns: number;
  isTTY: boolean;
  writes: string[];
  write: (chunk: string) => boolean;
}

function makeFakeStream(rows: number, columns: number): FakeStream {
  const writes: string[] = [];
  return {
    rows,
    columns,
    isTTY: true,
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

describe('diffLogUpdate resize reflow (SCLI-480)', () => {
  const realStdout = process.stdout;

  function setStdout(stream: FakeStream): void {
    Object.defineProperty(process, 'stdout', {
      value: stream,
      configurable: true,
      writable: true,
    });
  }

  let stream: FakeStream;

  beforeEach(() => {
    stream = makeFakeStream(24, 80);
    setStdout(stream);
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdout', {
      value: realStdout,
      configurable: true,
      writable: true,
    });
  });

  it('clears scrollback (CSI 3 J) and re-emits full source on resize', () => {
    const render = diffLogUpdate.create(stream as any, { showCursor: false });

    // Tall content: 50 lines with long payloads that wrap at 80 cols.
    const lines = Array.from(
      { length: 50 },
      (_, i) => `line-${String(i).padStart(2, '0')} ${'x'.repeat(60)}`,
    );
    const content = lines.join('\n') + '\n';

    render(content);

    // Simulate a terminal resize: width 80 -> 120.
    stream.columns = 120;
    stream.writes.length = 0;
    // Force the render path (same string would otherwise short-circuit).
    render.setCursorPosition();
    render(content);

    const output = stream.writes.join('');

    // Scrollback clear emitted on resize (no stale-width wraps survive).
    expect(output).toContain('\x1b[3J');
    // Screen clear + cursor home accompany it.
    expect(output).toContain('\x1b[2J\x1b[3J\x1b[H');

    // Full source re-emitted from the top (first and last lines present).
    expect(output).toContain('line-00');
    expect(output).toContain('line-49');
    // Every source line is re-emitted (not just the tail).
    for (let i = 0; i < 50; i++) {
      expect(output).toContain(`line-${String(i).padStart(2, '0')}`);
    }
  });

  it('does NOT clear scrollback on a normal (non-resize) incremental render', () => {
    const render = diffLogUpdate.create(stream as any, { showCursor: false });

    const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, '0')}`);
    render(lines.join('\n') + '\n');

    stream.writes.length = 0;
    // Append more content at the same terminal size.
    render(lines.concat(['line-30']).join('\n') + '\n');

    const output = stream.writes.join('');
    // No scrollback clear on a routine incremental update.
    expect(output).not.toContain('\x1b[3J');
  });
});
