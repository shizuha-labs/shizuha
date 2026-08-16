/**
 * Android esbuild config — builds a self-contained shizuha-android.js
 * that runs on nodejs-mobile (Node.js 18, arm64).
 *
 * Key differences from the standard build:
 * - Bundles ALL dependencies (no externals) — no node_modules on Android
 * - Stubs native modules (better-sqlite3, tiktoken) with JS implementations
 * - Stubs pino/thread-stream (worker_threads unreliable on nodejs-mobile)
 * - Disables Claude Code OAuth provider (no Claude CLI on Android)
 * - Entry point: src/android-entry.ts (exports runAgentWithPrompt, no CLI)
 */

import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolve stubs to absolute paths
const stubsDir = path.resolve('stubs');

/** Redirect native/problematic modules to our JS stubs */
const androidStubPlugin = {
  name: 'android-stubs',
  setup(build) {
    const stubs = {
      'better-sqlite3': path.join(stubsDir, 'better-sqlite3.mjs'),
      'tiktoken': path.join(stubsDir, 'tiktoken.mjs'),
      'pino': path.join(stubsDir, 'pino.mjs'),
      'pino-pretty': path.join(stubsDir, 'pino-pretty.mjs'),
      'thread-stream': path.join(stubsDir, 'thread-stream.mjs'),
      // Optional packages that aren't installed
      'react-devtools-core': null,
      'yoga-wasm-web': null,
      // Playwright — not available on Android (no browser)
      'playwright-core': null,
      'chromium-bidi/lib/cjs/bidiMapper/BidiMapper': null,
      'chromium-bidi/lib/cjs/cdp/CdpConnection': null,
      // pdf-parse — 8.5MB of bundled pdf.js workers, not needed on Android
      'pdf-parse': null,
    };

    for (const [pkg, stubPath] of Object.entries(stubs)) {
      build.onResolve({ filter: new RegExp(`^${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => {
        if (stubPath === null) {
          return { path: pkg, namespace: 'empty-stub' };
        }
        return { path: stubPath };
      });
    }

    // Empty stubs for packages that just need `export default undefined`
    build.onLoad({ filter: /.*/, namespace: 'empty-stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

/** Tier 3 Custom Renderer — same as standard build */
const inkPatchPlugin = {
  name: 'ink-tier3-patch',
  setup(build) {
    build.onLoad({ filter: /ink\/build\/log-update\.js$/ }, () => ({
      contents: fs.readFileSync('src/tui/renderer/diffLogUpdate.ts', 'utf8'),
      loader: 'ts',
      resolveDir: path.resolve('node_modules/ink/build'),
    }));

    build.onLoad({ filter: /ink\/build\/hooks\/use-input\.js$/ }, () => ({
      contents: fs.readFileSync('src/tui/renderer/stableUseInput.ts', 'utf8'),
      loader: 'ts',
      resolveDir: path.resolve('node_modules/ink/build/hooks'),
    }));
  },
};

await build({
  entryPoints: ['src/android-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',  // nodejs-mobile v18
  format: 'esm',
  outfile: 'dist/shizuha-android.js',
  sourcemap: false,  // Save space on Android
  minify: false,     // Keep readable for debugging PoC
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: {
    '__ENABLE_CLAUDE_CODE_PROVIDER__': 'false',  // No Claude CLI on Android
  },
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __dirnameFn } from "node:path";',
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameFn(__filename);',
      'process.noDeprecation = true;',
    ].join('\n'),
  },
  plugins: [androidStubPlugin, inkPatchPlugin],
  // No externals! Everything is bundled.
  external: [],
});

const stat = fs.statSync('dist/shizuha-android.js');
console.log(`Built dist/shizuha-android.js (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
