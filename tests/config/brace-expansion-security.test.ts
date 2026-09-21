/**
 * PLAT-5322 — brace-expansion CVE-2026-14257 (DoS via unbounded expansion
 * length → OOM process crash).
 *
 * Affects versions >= 4.0.0, < 5.0.8; fixed in 5.0.8, 3.0.3, 2.1.3, 1.1.17.
 * The vulnerable copies lived in the vscode extension's lockfile
 * (brace-expansion 1.1.16 via minimatch 3.x, and 5.0.7 via glob's minimatch
 * 10.x). The fix pins patched-compatible lines via package.json overrides:
 * 1.x → 1.1.18 (same CJS function API minimatch 3.x expects) and 5.x → 5.0.9
 * (same API minimatch 10.x expects) — no major bump, no call-shape break.
 *
 * This regression scans every brace-expansion version in every lockfile in
 * the repo and fails if any falls in a vulnerable range.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function parseSemver(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((part) => Number(part));
  return [major, minor, patch];
}

/** CVE-2026-14257 vulnerable range check. */
function isVulnerable(version: string): boolean {
  const [maj, min, pat] = parseSemver(version);
  if (maj === 1) return min < 1 || (min === 1 && pat < 17); // < 1.1.17
  if (maj === 2) return min < 1 || (min === 1 && pat < 3); // < 2.1.3
  if (maj === 3) return min < 0 || (min === 0 && pat < 3); // < 3.0.3
  if (maj >= 4) return maj < 5 || (maj === 5 && pat < 8); // >=4.0.0, <5.0.8
  return false;
}

function braceExpansionVersions(lockPath: string): string[] {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const out: string[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key.endsWith('node_modules/brace-expansion') && entry && typeof entry === 'object') {
      const v = (entry as { version?: string }).version;
      if (v) out.push(v);
    }
  }
  return out;
}

describe('brace-expansion CVE-2026-14257 (PLAT-5322)', () => {
  const lockfiles = [
    join(ROOT, 'package-lock.json'),
    join(ROOT, 'extensions', 'vscode', 'package-lock.json'),
  ];

  for (const lockPath of lockfiles) {
    it(`no vulnerable brace-expansion in ${lockPath.replace(ROOT, '')}`, () => {
      const versions = braceExpansionVersions(lockPath);
      expect(versions.length).toBeGreaterThan(0);
      for (const v of versions) {
        expect(isVulnerable(v), `brace-expansion ${v} is vulnerable to CVE-2026-14257`).toBe(false);
      }
    });
  }

  it('vscode extension pins patched-compatible lines via overrides', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'extensions', 'vscode', 'package.json'), 'utf8'),
    );
    const overrides = pkg.overrides ?? {};
    // Patched 1.x line for minimatch 3.x (CJS function API) and patched 5.x
    // line for minimatch 10.x — never a major bump that breaks the consumer.
    expect(overrides['brace-expansion@^1.1.7']).toBe('1.1.18');
    expect(overrides['brace-expansion@^5.0.5']).toBe('5.0.9');
  });
});
