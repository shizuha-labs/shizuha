/**
 * PLAT-4650 — vite GHSA-4w7w / GHSA-fx2h / GHSA-p9ff / GHSA-v2wj / GHSA-v6wh
 *
 * Transitive-override / direct-dep consumer-boundary regression
 * (verify-before-push): real consumers are vite.web.config.ts,
 * vite.tauri.config.ts, and vitest (via vitest/config → vite). Coverage
 * crosses vite's public `defineConfig` + `resolveConfig` API rather than
 * only asserting a package.json version string.
 *
 * Patched floor for the 7.x line is >= 7.3.5 (GHSA-fx2h / GHSA-v6wh);
 * earlier 7.3.2 only covers a subset of the consolidated advisories.
 */
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

describe('vite security regression (PLAT-4650)', () => {
  it('pins a patched 7.x line (>= 7.3.5) for named consumers', () => {
    // Named consumers that import vite / vitest-config (which depends on vite).
    for (const name of ['vite', 'vitest'] as const) {
      expect(() => require.resolve(`${name}/package.json`)).not.toThrow();
    }

    const pkg = require('vite/package.json') as { version: string };
    const declared = (
      require('../../package.json') as {
        devDependencies?: { vite?: string };
      }
    ).devDependencies?.vite;

    // package.json declares ^7.3.6; resolved install must clear the 7.3.5 floor.
    expect(declared).toMatch(/^\^?7\.3\.(5|6|[7-9]|\d{2,})$|^\^?7\.[4-9]/);
    expect(gte(pkg.version, '7.3.5')).toBe(true);
    expect(pkg.version.startsWith('7.')).toBe(true);
  });

  it('defineConfig + resolveConfig work through the upgraded vite', async () => {
    // Consumer boundary: same public API used by vite.web.config.ts /
    // vite.tauri.config.ts (import { defineConfig } from 'vite').
    const vite = await import('vite');
    expect(typeof vite.defineConfig).toBe('function');
    expect(typeof vite.resolveConfig).toBe('function');

    const cfg = vite.defineConfig({
      root: process.cwd(),
      // Keep server.fs defaults — the deny-bypass advisories live on this path.
      server: {
        fs: {
          strict: true,
        },
      },
      build: {
        write: false,
      },
    });

    const resolved = await vite.resolveConfig(cfg, 'serve');
    expect(resolved).toBeTruthy();
    expect(resolved.server?.fs?.strict).toBe(true);
    // Happy-path identity: command/mode round-trip through resolveConfig.
    expect(resolved.command).toBe('serve');
  });
});
