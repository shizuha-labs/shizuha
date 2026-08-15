/**
 * SCLI-383: help dismiss must not leak printables into the composer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('SCLI-383 help dismiss key isolation', () => {
  it('HelpOverlay documents Esc/q and dismisses on those keys', () => {
    const src = read('src/tui/components/HelpOverlay.tsx');
    expect(src).toMatch(/Esc or q closes/);
    expect(src).not.toMatch(/any key closes/);
    expect(src).toMatch(/key\.escape/);
    expect(src).toMatch(/input === 'q'/);
  });

  it('App arms composer suppress on help and pager dismiss', () => {
    const src = read('src/tui/App.tsx');
    expect(src).toContain('armComposerKeySuppress');
    expect(src).toContain('composerKeySuppressed');
    expect(src).toMatch(/HelpOverlay onDismiss[\s\S]*armComposerKeySuppress/);
    expect(src).toMatch(/isLocked=\{!!pendingApproval \|\| composerKeySuppressed\}/);
  });

  it('/help all opens the pager instead of dumping into an active draft surface', () => {
    const src = read('src/tui/hooks/useSlashCommands.ts');
    expect(src).toMatch(/case '\/help':[\s\S]*showInPager\(HELP_FULL_TEXT\)/);
  });
});
