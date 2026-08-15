import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const stubPlugin = {
  name: 'stub-optional',
  setup(build) {
    // Packages that need complete stubs (native deps, not available on Android)
    const stubs = ['react-devtools-core', 'yoga-wasm-web', 'better-sqlite3', 'tiktoken'];
    build.onResolve({ filter: new RegExp(`^(${stubs.join('|')})$`) }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'tiktoken') {
        return {
          contents: `
            export function encoding_for_model() { return { encode: (s) => s.split(' '), free: () => {} }; }
            export function get_encoding() { return { encode: (s) => s.split(' '), free: () => {} }; }
          `,
          loader: 'js',
        };
      }
      if (args.path === 'better-sqlite3') {
        return {
          contents: `export default function Database() { throw new Error('SQLite not available on Android'); };`,
          loader: 'js',
        };
      }
      return { contents: 'export default undefined;', loader: 'js' };
    });
  },
};

// Ink patches for Tier 3 renderer
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
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/shizuha-mobile.js',
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: {
    '__ENABLE_CLAUDE_CODE_PROVIDER__': 'false',
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
  plugins: [stubPlugin, inkPatchPlugin],
  external: [],  // Bundle everything for mobile
});

console.log('Built dist/shizuha-mobile.js');
