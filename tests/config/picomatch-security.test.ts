/**
 * PLAT-4645 — picomatch GHSA-3v7f-55p6-f55p / GHSA-c2c7-rcm5-vvqj
 *
 * Transitive-override consumer-boundary regression (verify-before-push):
 * real consumers are vite@7.3.1, vitest@3.2.4, and tinyglobby@0.2.15 (via
 * fdir). Coverage crosses tinyglobby's public glob API — the package that
 * actually require()s picomatch — rather than importing the leaf directly.
 *
 * Advisory edge payloads (not safe stand-ins):
 * - GHSA-c2c7-rcm5-vvqj ReDoS: overlapping extglob `+(a|aa)` (also nested
 *   forms in the advisory). Patched ≥4.0.4 literalizes / non-backtracks —
 *   must finish quickly and must NOT match `a`/`aa` the way 4.0.3 did.
 * - GHSA-3v7f-55p6-f55p method injection: `[[:constructor:]]` must not match
 *   unintended fixture names (constructor.txt / toString.txt / …).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

function parseSemver(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((part) => Number(part));
  return [major, minor, patch];
}

function gte(version: string, minimum: string): boolean {
  const [aMaj, aMin, aPat] = parseSemver(version);
  const [bMaj, bMin, bPat] = parseSemver(minimum);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

type TinyGlob = {
  globSync: (
    patterns: string | string[],
    options?: { cwd?: string; absolute?: boolean },
  ) => string[];
};

describe('picomatch security regression (PLAT-4645)', () => {
  it('pins a patched picomatch line (>= 4.0.4) for named consumers', () => {
    // Dependency-tree evidence: these packages resolve the overridden leaf.
    // Named consumers that require() picomatch in the lockfile tree.
    const consumers = ['vite', 'vitest', 'tinyglobby'] as const;
    for (const name of consumers) {
      expect(() => require.resolve(`${name}/package.json`)).not.toThrow();
    }

    const pkg = require('picomatch/package.json') as { version: string };
    // package.json overrides pin 4.0.5; accept any patched >=4.0.4 (incl. 4.1.x).
    const pinned = (
      require('../../package.json') as {
        overrides?: { picomatch?: string };
      }
    ).overrides?.picomatch;
    expect(pinned).toBe('4.0.5');
    expect(gte(pkg.version, '4.0.4')).toBe(true);
    expect(pkg.version).toBe(pinned);
  });

  it('tinyglobby safely handles real advisory payloads through overridden picomatch', () => {
    const tinyglobby = require('tinyglobby') as TinyGlob;

    const dir = mkdtempSync(join(tmpdir(), 'plat-4645-picomatch-'));
    try {
      // Happy-path + ReDoS-adjacent names (4.0.3 matched a/aa/a.txt for +(a|aa)).
      writeFileSync(join(dir, 'index.js'), 'export default 1\n');
      writeFileSync(join(dir, 'index.ts'), 'export default 1\n');
      writeFileSync(join(dir, 'a'), 'a\n');
      writeFileSync(join(dir, 'aa'), 'aa\n');
      writeFileSync(join(dir, 'aaa'), 'aaa\n');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      writeFileSync(join(dir, 'aa.txt'), 'aa\n');
      writeFileSync(join(dir, 'b.txt'), 'b\n');
      writeFileSync(join(dir, 'c.txt'), 'c\n');
      // Method-injection bait names from GHSA-3v7f-55p6-f55p.
      writeFileSync(join(dir, 'constructor.txt'), 'ctor\n');
      writeFileSync(join(dir, 'toString.txt'), 'ts\n');
      writeFileSync(join(dir, 'valueOf.txt'), 'vo\n');
      writeFileSync(join(dir, 'Object.txt'), 'obj\n');
      // Long non-matching name — vulnerable 4.0.3 blocks multi-seconds on +(a|aa).
      writeFileSync(join(dir, `${'a'.repeat(40)}b`), 'long\n');

      // Normal pattern path used by vite/vitest-style globs.
      const jsHits = tinyglobby.globSync('*.js', { cwd: dir });
      expect(jsHits.sort()).toEqual(['index.js']);

      // GHSA-c2c7-rcm5-vvqj — overlapping extglob ReDoS payload.
      // Patched picomatch literalizes / non-backtracks: must finish quickly and
      // must NOT expand to a/aa/a.txt the way unpatched 4.0.3 did.
      const redosStarted = Date.now();
      const redosBare = tinyglobby.globSync('+(a|aa)', { cwd: dir });
      const redosTxt = tinyglobby.globSync('+(a|aa).txt', { cwd: dir });
      const nested = tinyglobby.globSync('*(+(a))', { cwd: dir });
      const redosMs = Date.now() - redosStarted;
      expect(redosMs).toBeLessThan(250);
      expect(redosBare).toEqual([]);
      expect(redosTxt).toEqual([]);
      expect(nested).toEqual([]);

      // GHSA-3v7f-55p6-f55p — POSIX method-injection payload must not select
      // unintended fixture names (constructor/toString/valueOf/Object).
      const injected = tinyglobby.globSync('[[:constructor:]].txt', { cwd: dir });
      const injectedStar = tinyglobby.globSync('[[:constructor:]]*', { cwd: dir });
      expect(injected).toEqual([]);
      expect(injectedStar).toEqual([]);
      for (const bait of [
        'constructor.txt',
        'toString.txt',
        'valueOf.txt',
        'Object.txt',
      ]) {
        expect(injected).not.toContain(bait);
        expect(injectedStar).not.toContain(bait);
      }

      // Control: legitimate POSIX class still works through the same consumer.
      const alnum = tinyglobby.globSync('[[:alnum:]].txt', { cwd: dir });
      expect(alnum.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
