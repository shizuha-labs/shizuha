import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SCLI-447: Ctrl+D at an idle empty composer must exit cleanly (the
 * conventional terminal EOF affordance), not be silently swallowed.
 *
 * Regression: the InputBox handler had no Ctrl+D case, so a single Ctrl+D at
 * an empty composer fell through to the "clear completions" else-branch and
 * the process stayed alive with no diagnostic — breaking the conventional
 * EOF/exit affordance.
 */
const src = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/App.tsx'),
  'utf8',
);

describe('Ctrl+D EOF exit at empty composer', () => {
  it('handles Ctrl+D in the always-active global input handler', () => {
    expect(src, 'Ctrl+D must be recognised in the global handler').toMatch(
      /key\.ctrl && _input === 'd'/,
    );
  });

  it('exits cleanly only when the composer is empty (no data loss)', () => {
    // Must gate on an empty/whitespace draft so a non-empty composer never
    // loses typed input to an accidental Ctrl+D.
    expect(src, 'empty-composer guard required').toMatch(
      /!inputRef\.current \|\| inputRef\.current\.trim\(\) === ''/,
    );
  });

  it('uses the same clean-exit path as Ctrl+C at idle', () => {
    expect(src, 'must call exitTui(exit)').toMatch(
      /key\.ctrl && _input === 'd'[\s\S]{0,200}exitTui\(exit\)/,
    );
  });

  it('does not exit when the composer has a non-empty draft', () => {
    // The guard must be an early return/condition, not an unconditional exit.
    const ctrlDBlock = src.match(
      /if \(key\.ctrl && _input === 'd'\) \{[\s\S]{0,400}?\n    \}/,
    );
    expect(ctrlDBlock, 'Ctrl+D block must exist').not.toBeNull();
    const block = ctrlDBlock![0];
    expect(block).toMatch(/if \(!inputRef\.current \|\| inputRef\.current\.trim\(\) === ''\)/);
    // exitTui must be inside the empty-guard, not unconditional.
    const guardIndex = block.indexOf("inputRef.current.trim() === ''");
    const exitIndex = block.indexOf('exitTui(exit)');
    expect(guardIndex, 'guard must precede exitTui').toBeGreaterThanOrEqual(0);
    expect(exitIndex, 'exitTui must be after the guard').toBeGreaterThan(guardIndex);
  });
});
