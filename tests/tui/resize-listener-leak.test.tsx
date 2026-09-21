// @vitest-environment jsdom
/**
 * SCLI-372: prompt-queue interactions must not leak resize listeners.
 *
 * The old useTerminalSize attached a native `process.stdout.on('resize', ...)`
 * listener per component use; repeated mounts during prompt-queue turns
 * accumulated listeners until Node printed
 * `MaxListenersExceededWarning: 11 resize listeners added to [WriteStream]`.
 *
 * The fix is a module-level singleton: exactly ONE native listener regardless
 * of how many components mount. This test mounts the hook 15 times (past the
 * default 11-listener warning threshold) and asserts the native listener count
 * stays at 1 and no warning is emitted.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { useTerminalSize } from '../../src/tui/hooks/useTerminalSize.js';

function Probe() {
  useTerminalSize();
  return React.createElement('div', null, 'probe');
}

describe('SCLI-372 resize listener lifecycle', () => {
  it('keeps exactly one native resize listener across many mounts', () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const before = process.stdout.listenerCount('resize');

    const views = [];
    for (let i = 0; i < 15; i++) {
      views.push(render(React.createElement(Probe)));
    }

    const after = process.stdout.listenerCount('resize');
    expect(after).toBe(before + 1); // exactly one shared native listener

    cleanup();

    expect(warning).not.toHaveBeenCalled();
    // The shared native listener is a module singleton — it stays at one.
    expect(process.stdout.listenerCount('resize')).toBe(before + 1);
    warning.mockRestore();
  });
});
