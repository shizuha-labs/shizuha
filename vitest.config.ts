import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: {
    // Build-time feature flag: enable Claude Code provider in tests (matches internal builds).
    // esbuild sets this at bundle time; vitest needs it defined here.
    __ENABLE_CLAUDE_CODE_PROVIDER__: 'true',
  },
  plugins: [react()],
  resolve: {
    alias: {
      // The ClaudeCodeProvider is loaded via require('./claude-code.js') in registry.ts
      // (CJS require for dead-code elimination in public builds). Vitest can't resolve
      // .js → .ts for CJS require, so alias the exact resolved path.
      [path.resolve('src/provider/claude-code.js')]: path.resolve('src/provider/claude-code.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Shared workstations/runners expose far more CPUs than the SQLite- and
    // subprocess-heavy suite can use efficiently. Unbounded file workers starve
    // healthy tests past their 30s timeout. Keep every invocation (npm test,
    // pre-push, and full CI) parallel but below that oversubscription cliff.
    maxWorkers: process.env['SHIZUHA_CI_MAX_WORKERS']?.trim() || '4',
    testTimeout: 30000,
  },
});
