import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  define: {
    // Build-time feature flag: enable Claude Code provider in tests (matches internal builds).
    // esbuild sets this at bundle time; vitest needs it defined here.
    __ENABLE_CLAUDE_CODE_PROVIDER__: 'true',
  },
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
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
