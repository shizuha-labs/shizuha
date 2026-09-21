import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SCLI-448: Ctrl+Z must suspend the foreground job (Unix job control), never
 * be captured as editor Undo. Undo moves to Ctrl+Y; both bindings are
 * documented in /help all and the HelpOverlay.
 *
 * Regression: the shortcut handler bound Ctrl+Z to "undo last edit", so a
 * human Ctrl+Z rendered "Nothing to undo", the shell never reported a stopped
 * job, and `fg` was consumed into the composer.
 */
const appSrc = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/App.tsx'),
  'utf8',
);
const helpSrc = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/hooks/useSlashCommands.ts'),
  'utf8',
);
const overlaySrc = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/components/HelpOverlay.tsx'),
  'utf8',
);

describe('Ctrl+Z job-control suspend (SCLI-448)', () => {
  it('handles Ctrl+Z in the always-active global input handler', () => {
    expect(appSrc, 'Ctrl+Z must be recognised in the global handler').toMatch(
      /key\.ctrl && _input === 'z'/,
    );
  });

  it('suspends via suspendTui, not editor undo', () => {
    // The global handler must call suspendTui() on Ctrl+Z.
    expect(appSrc).toMatch(
      /key\.ctrl && _input === 'z'[\s\S]{0,120}suspendTui\(\)/,
    );
  });

  it('stops the whole foreground process group with SIGSTOP', () => {
    // Node ignores SIGTSTP by default, so suspension must use SIGSTOP
    // (uncatchable, always stops); the shell reports "Stopped" identically.
    expect(appSrc, 'must stop the process group').toMatch(
      /process\.kill\(0, 'SIGSTOP'\)/,
    );
    expect(appSrc, 'must not rely on SIGTSTP (Node ignores it)').not.toMatch(
      /process\.kill\(0, 'SIGTSTP'\)/,
    );
  });

  it('restores the cooked terminal before suspending', () => {
    expect(appSrc).toMatch(/process\.stdin\.setRawMode\(false\)/);
  });

  it('re-enters raw mode + alternate screen on SIGCONT', () => {
    expect(appSrc).toMatch(/process\.on\('SIGCONT'/);
    expect(appSrc).toMatch(/process\.stdin\.setRawMode\(true\)/);
    expect(appSrc).toMatch(/enterInteractiveScreen\(process\.stdout\)/);
  });

  it('moved editor Undo off Ctrl+Z onto Ctrl+Y', () => {
    // Undo must no longer be bound to Ctrl+Z.
    expect(appSrc, 'Undo must not be on Ctrl+Z').not.toMatch(
      /key\.ctrl && _input === 'z'[\s\S]{0,120}popEdit\(\)/,
    );
    expect(appSrc, 'Undo must be on Ctrl+Y').toMatch(
      /key\.ctrl && _input === 'y'[\s\S]{0,120}popEdit\(\)/,
    );
  });

  it('documents Ctrl+Z suspend and Ctrl+Y undo in /help all', () => {
    expect(helpSrc).toMatch(/Ctrl\+Z suspend \(fg resumes\)/);
    expect(helpSrc).toMatch(/Ctrl\+Y undo edit/);
  });

  it('documents Ctrl+Z suspend and Ctrl+Y undo in the HelpOverlay', () => {
    expect(overlaySrc).toMatch(/Ctrl\+Z suspend \(fg resumes\)/);
    expect(overlaySrc).toMatch(/Ctrl\+Y undo edit/);
  });
});
