/**
 * PLAT-4646 — postcss GHSA-qx2v-qp2m-jg93 / GHSA-6g55-p6wh-862q / GHSA-r28c-9q8g-f849
 *
 * Consumer-boundary regression: vite calls postcss.parse / stringify.
 * Pin must stay on patched ≥8.5.18 without breaking that API.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('postcss security regression (PLAT-4646)', () => {
  it('resolves a patched 8.5.x line (>= 8.5.18)', () => {
    const pkg = require('postcss/package.json') as { version: string };
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    expect(major).toBe(8);
    expect(minor).toBe(5);
    expect(patch).toBeGreaterThanOrEqual(18);
  });

  it('exposes parse/stringify API used by vite', () => {
    const postcss = require('postcss') as {
      parse: (css: string) => { toResult: () => { css: string }; nodes: unknown[] };
    };
    expect(typeof postcss.parse).toBe('function');
    const root = postcss.parse('a{color:red}');
    expect(root.nodes.length).toBe(1);
    expect(root.toResult().css).toContain('color');
  });
});
