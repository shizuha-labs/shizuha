/**
 * SCLI-397: the installed CLI must present ONE canonical public version
 * identity across `-V` / `--version` and the TUI startup hero.
 *
 * Previously `src/index.ts` reported `0.1.0` while `WelcomeArt.tsx` branded
 * the same build `v0.1.0-beta` — mutually contradictory release identities
 * from one executable. Both surfaces now read the single `CLI_VERSION`
 * constant from `src/shared/version.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('SCLI-397 canonical version identity', () => {
  it('defines a single canonical CLI_VERSION constant', () => {
    const src = read('src/shared/version.ts');
    expect(src).toMatch(/CLI_VERSION\s*=\s*'[^']+'/);
    expect(src).not.toMatch(/CLI_VERSION\s*=\s*'[^']*@[^']*'/); // no placeholders
  });

  it('the CLI --version flag reads the canonical constant (not a hardcoded string)', () => {
    const src = read('src/index.ts');
    expect(src).toContain("import { CLI_VERSION } from './shared/version.js'");
    expect(src).toMatch(/\.version\(CLI_VERSION\)/);
    // No divergent hardcoded version in the flag wiring.
    expect(src).not.toMatch(/\.version\('0\.1\.0'\)/);
  });

  it('the TUI startup hero reads the same canonical constant', () => {
    const src = read('src/tui/components/WelcomeArt.tsx');
    expect(src).toContain("import { CLI_VERSION } from '../../shared/version.js'");
    expect(src).toMatch(/const VERSION = CLI_VERSION;/);
    // The old divergent hardcoded beta string must be gone.
    expect(src).not.toContain("'0.1.0-beta'");
  });
});
