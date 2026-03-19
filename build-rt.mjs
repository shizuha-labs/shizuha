#!/usr/bin/env node
/**
 * build-rt.mjs — Build the Shizuha Runtime CLI for distribution.
 *
 * Pipeline (same approach as Claude Code / industry standard):
 *   1. esbuild bundle + minify (tree-shake, mangle locals, compact whitespace)
 *   2. Strip source file paths from error/stack-trace strings
 *   3. Strip architecture-revealing string literals
 *
 * Usage:
 *   node build-rt.mjs                                    # → dist/shizuha.min.js
 *   node build-rt.mjs --out ../rt/dist/shizuha.min.js    # Custom output path
 *
 * The output is a single self-contained ESM file for Node.js >= 20.
 */

import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Parse CLI args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : 'dist/shizuha.min.js';
const enableClaudeCodeProvider = args.includes('--enable-claude-code-provider');

console.log(`\n🔧 Shizuha RT Build Pipeline`);
console.log(`   Output: ${outFile}\n`);

// ── Step 1: esbuild bundle + minify ─────────────────────────────────────

console.log('Step 1/3: esbuild bundle + minify...');
const t1 = Date.now();

const stubPlugin = {
  name: 'stub-optional',
  setup(b) {
    const stubs = ['react-devtools-core', 'yoga-wasm-web'];
    b.onResolve({ filter: new RegExp(`^(${stubs.join('|')})$`) }, (a) => ({
      path: a.path,
      namespace: 'stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

const inkPatchPlugin = {
  name: 'ink-tier3-patch',
  setup(b) {
    b.onLoad({ filter: /ink\/build\/log-update\.js$/ }, () => ({
      contents: fs.readFileSync('src/tui/renderer/diffLogUpdate.ts', 'utf8'),
      loader: 'ts',
      resolveDir: path.resolve('node_modules/ink/build'),
    }));
    b.onLoad({ filter: /ink\/build\/hooks\/use-input\.js$/ }, () => ({
      contents: fs.readFileSync('src/tui/renderer/stableUseInput.ts', 'utf8'),
      loader: 'ts',
      resolveDir: path.resolve('node_modules/ink/build/hooks'),
    }));
  },
};

// esbuild handles all standard obfuscation:
//   - minify: removes whitespace + comments, shortens syntax
//   - mangleProps with regex: mangles internal property names matching pattern
//   - treeShaking: removes dead code
//   - drop: removes debugger statements
//   - legalComments: strips license headers
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: outFile,
  minify: true,
  sourcemap: false,
  treeShaking: true,
  legalComments: 'none',
  drop: ['debugger'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: {
    '__ENABLE_CLAUDE_CODE_PROVIDER__': String(enableClaudeCodeProvider),
  },
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import{createRequire as __cr}from"node:module";',
      'import{fileURLToPath as __fu}from"node:url";',
      'import{dirname as __dn}from"node:path";',
      'const require=__cr(import.meta.url);',
      'const __filename=__fu(import.meta.url);',
      'const __dirname=__dn(__filename);',
      'process.noDeprecation=!0;',
    ].join('\n'),
  },
  plugins: [stubPlugin, inkPatchPlugin],
  external: [
    'better-sqlite3',
    'tiktoken',
    '@anthropic-ai/sdk',
    'openai',
    '@google/generative-ai',
    '@modelcontextprotocol/sdk',
    'pino',
    'pino-pretty',
    'thread-stream',
    'ws',
  ],
});

console.log(`   Done (${Date.now() - t1}ms)`);

// ── Step 2: Strip source file paths ─────────────────────────────────────

console.log('Step 2/3: Strip source file paths...');
const t2 = Date.now();

let code = fs.readFileSync(outFile, 'utf8');
const originalSize = code.length;

// Split banner from body — only sanitize the body to avoid breaking imports
const bannerEndMarker = 'process.noDeprecation=!0;';
const bannerEnd = code.indexOf(bannerEndMarker);
let banner = '';
let body = code;
if (bannerEnd !== -1) {
  const splitAt = bannerEnd + bannerEndMarker.length;
  banner = code.slice(0, splitAt) + '\n';
  body = code.slice(splitAt);
}

// Strip source file paths like "src/agent/turn.ts"
// These appear in esbuild error messages and stack traces
body = body.replace(/src\/[a-zA-Z0-9_\/.]+\.(ts|js|tsx|jsx)/g, 'x');

code = banner + body;

let pathsStripped = originalSize - banner.length - body.length;
console.log(`   Stripped ${pathsStripped} bytes of source paths (${Date.now() - t2}ms)`);

// ── Step 3: Strip architecture-revealing strings ─────────────────────────

console.log('Step 3/3: Sanitize revealing strings...');
const t3 = Date.now();

const revealingPatterns = [
  // Internal component names used only in log messages
  [/"ShizuhaWSChannel"/g, '"C1"'],
  [/"DiscordChannel"/g, '"C2"'],
  [/"TelegramChannel"/g, '"C3"'],
  [/"WhatsAppChannel"/g, '"C4"'],
  [/"PermissionEngine"/g, '"E1"'],
  [/"ToolRegistry"/g, '"R1"'],
  // Log messages that reveal architecture
  [/"Compaction complete"/g, '"op done"'],
  [/"Compaction retry/g, '"retry'],
  [/"Discord Gateway/g, '"GW'],
  [/"Connecting to Discord Gateway"/g, '"connecting"'],
  // Internal service identifiers in log-only contexts
  [/"shizuha-microcompact"/g, '"mc"'],
];

let sanitized = 0;
for (const [pattern, replacement] of revealingPatterns) {
  const before = code.length;
  code = code.replace(pattern, replacement);
  if (code.length !== before) sanitized++;
}

console.log(`   Sanitized ${sanitized} patterns (${Date.now() - t3}ms)`);

// Write final output
fs.writeFileSync(outFile, code);
fs.chmodSync(outFile, 0o755);

const finalSize = (fs.statSync(outFile).size / 1e6).toFixed(1);
console.log(`\n✅ Output: ${outFile} (${finalSize}MB)\n`);
