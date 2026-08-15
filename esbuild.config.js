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
      '(() => {',
      '  const privateEnvJson = process.env["SHIZUHA_PRIVATE_ENV_JSON"];',
      '  if (!privateEnvJson) return;',
      '  try {',
      '    const fs = require("node:fs");',
      '    const payload = JSON.parse(fs.readFileSync(privateEnvJson, "utf8"));',
      '    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;',
      '    for (const [key, value] of Object.entries(payload)) {',
      '      if (typeof key === "string" && key && !/[=\\u0000\\r\\n]/.test(key) && typeof value === "string") {',
      '        process.env[key] = value;',
      '      }',
      '    }',
      '  } catch {',
      '    // Keep startup quiet: callers without private launch env are unaffected,',
      '    // and daemon logs must never include secret-bearing payload details.',
      '  }',
      '})();',
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

// Copy daemon templates (e.g. HEARTBEAT.md) to dist/templates/
const templatesSrc = path.join('src', 'daemon', 'templates');
const templatesDst = path.join('dist', 'templates');
if (fs.existsSync(templatesSrc)) {
  fs.mkdirSync(templatesDst, { recursive: true });
  let templateCount = 0;
  for (const entry of fs.readdirSync(templatesSrc, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.copyFileSync(path.join(templatesSrc, entry.name), path.join(templatesDst, entry.name));
      templateCount++;
    }
  }
  console.log(`Copied ${templateCount} daemon template(s) to dist/templates/`);
}

// Copy integration skills to dist/ (subdirectory/SKILL.md format, same as community skills)
const skillsSrc = path.join('src', 'skills', 'integrations');
const skillsDst = path.join('dist', 'skills', 'integrations');
fs.mkdirSync(skillsDst, { recursive: true });
let skillCount = 0;
for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    const skillFile = path.join(skillsSrc, entry.name, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      const dstDir = path.join(skillsDst, entry.name);
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(skillFile, path.join(dstDir, 'SKILL.md'));
      skillCount++;
    }
  }
}
console.log(`Built dist/shizuha.js + ${skillCount} integration skills`);
