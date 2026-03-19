import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Stub out optional packages that aren't installed */
const stubPlugin = {
  name: 'stub-optional',
  setup(build) {
    const stubs = ['react-devtools-core', 'yoga-wasm-web'];
    build.onResolve({ filter: new RegExp(`^(${stubs.join('|')})$`) }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      const stubMap = {};
      return {
        contents: stubMap[args.path] || 'export default undefined;',
        loader: 'js',
      };
    });
  },
};

/**
 * Tier 3 Custom Renderer — replace Ink's output and input pipelines.
 *
 * log-update.js → diffLogUpdate.ts: Line-level diff renderer (no clearTerminal)
 * use-input.js  → stableUseInput.ts: Stable refs (no listener re-subscription)
 *
 * The resolveDir trick makes relative imports in our replacements resolve
 * against Ink's own build directory, so they can import Ink's internal
 * modules (parse-keypress, use-stdin, etc.) seamlessly.
 */
const inkPatchPlugin = {
  name: 'ink-tier3-patch',
  setup(build) {
    // Replace Ink's log-update with our line-diff renderer
    build.onLoad({ filter: /ink\/build\/log-update\.js$/ }, () => ({
      contents: fs.readFileSync('src/tui/renderer/diffLogUpdate.ts', 'utf8'),
      loader: 'ts',
      resolveDir: path.resolve('node_modules/ink/build'),
    }));

    // Replace Ink's useInput with our stable-ref version
    build.onLoad({ filter: /ink\/build\/hooks\/use-input\.js$/ }, () => ({
      contents: fs.readFileSync('src/tui/renderer/stableUseInput.ts', 'utf8'),
      loader: 'ts',
      resolveDir: path.resolve('node_modules/ink/build/hooks'),
    }));
  },
};


await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/shizuha.js',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __dirnameFn } from "node:path";',
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameFn(__filename);',
      // Suppress runtime deprecation noise (e.g. DEP0040 punycode) in CLI TUI.
      'process.noDeprecation = true;',
    ].join('\n'),
  },
  plugins: [stubPlugin, inkPatchPlugin],
  external: [
    'better-sqlite3',
    'pino',
    'pino-pretty',
    'thread-stream',
    'ws',
    '@modelcontextprotocol/sdk',
    '@google/generative-ai',
    '@anthropic-ai/sdk',
    'openai',
    'tiktoken',
    'playwright',
  ],
});

console.log('Built dist/shizuha.js');
