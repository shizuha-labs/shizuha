import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Stub out optional packages that aren't installed */
const stubPlugin = {
  name: 'stub-optional',
  setup(build) {
    const stubs = ['react-devtools-core', 'yoga-wasm-web'];
    build.onResolve({ filter: new RegExp(`^(${stubs.join('|')})$`) }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
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


// Build-time feature flags (can be overridden via CLI args)
// Usage: node esbuild.config.js --no-claude-code-provider
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : 'dist/shizuha.js';
const finalOutFile = path.resolve(outFile);
const outDir = path.dirname(finalOutFile);
const tmpOutFile = path.join(outDir, `.${path.basename(finalOutFile)}.tmp-${process.pid}-${Date.now()}.js`);
const tmpMapFile = `${tmpOutFile}.map`;
const finalMapFile = `${finalOutFile}.map`;
const defaultMinRuntimeBytes = path.basename(finalOutFile).includes('.min.') ? 5 * 1024 * 1024 : 15 * 1024 * 1024;
const minRuntimeBytes = Number.parseInt(process.env.SHIZUHA_RT_MIN_BYTES || String(defaultMinRuntimeBytes), 10);
const enableClaudeCodeProvider = !args.includes('--no-claude-code-provider');

function validateRuntimeBundle(file) {
  const stat = fs.statSync(file);
  if (stat.size < minRuntimeBytes) {
    throw new Error(`bundle validation failed: ${file} is ${stat.size} bytes (< ${minRuntimeBytes})`);
  }

  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, header.length, 0);
    if (!header.toString('utf8').startsWith('#!/usr/bin/env node')) {
      throw new Error(`bundle validation failed: ${file} is missing the node shebang`);
    }
  } finally {
    fs.closeSync(fd);
  }

  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

function preserveOwnerAndMode(tmp, final) {
  let uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  let mode = 0o755;

  try {
    const existing = fs.statSync(final);
    uid = existing.uid;
    gid = existing.gid;
    mode = existing.mode & 0o777;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  fs.chmodSync(tmp, mode || 0o755);
  if (typeof uid === 'number' && typeof gid === 'number') {
    try {
      fs.chownSync(tmp, uid, gid);
    } catch (err) {
      if (typeof process.getuid === 'function' && process.getuid() === 0) throw err;
      console.warn(`Warning: could not preserve owner on ${tmp}: ${err.message}`);
    }
  }
}

function cleanupTemp() {
  try { fs.rmSync(tmpOutFile, { force: true }); } catch {}
  try { fs.rmSync(tmpMapFile, { force: true }); } catch {}
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: tmpOutFile,
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: {
    '__ENABLE_CLAUDE_CODE_PROVIDER__': String(enableClaudeCodeProvider),
  },
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
    'tiktoken',
    '@anthropic-ai/sdk',
    'openai',
    '@google/generative-ai',
    '@modelcontextprotocol/sdk',
    'pino',
    'pino-pretty',
    'thread-stream',
    'ws',
    'playwright',
    'playwright-core',
  ],
});

try {
  if (fs.existsSync(tmpMapFile)) {
    const finalMapName = path.basename(finalMapFile);
    const tmpMapName = path.basename(tmpMapFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let bundle = fs.readFileSync(tmpOutFile, 'utf8');
    bundle = bundle.replace(new RegExp(`//# sourceMappingURL=${tmpMapName}\\s*$`), `//# sourceMappingURL=${finalMapName}`);
    fs.writeFileSync(tmpOutFile, bundle);
  }

  preserveOwnerAndMode(tmpOutFile, finalOutFile);
  validateRuntimeBundle(tmpOutFile);
  fs.renameSync(tmpOutFile, finalOutFile);
  if (fs.existsSync(tmpMapFile)) fs.renameSync(tmpMapFile, finalMapFile);
} catch (err) {
  cleanupTemp();
  throw err;
}

console.log(`Built ${outFile} atomically`);
