// SCLI-414 regression: `logout` must clear ALL stored provider credentials
// (Cortex/OpenAI/Anthropic/Google/Codex/Copilot), not just the platform auth.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  writeCredentials,
  readCredentials,
  clearAllProviderCredentials,
  credentialsPath,
  credentialsDir,
} from '../../src/config/credentials.js';

const ORIGINAL_HOME = process.env['HOME'];

function withHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli414-'));
  process.env['HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['HOME'] = ORIGINAL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('SCLI-414 clearAllProviderCredentials', () => {
  afterEach(() => {
    process.env['HOME'] = ORIGINAL_HOME;
  });

  it('clears cortex + openai + codex + copilot + anthropic + google from the store', () => {
    withHome(() => {
      writeCredentials({
        cortex: { apiKey: 'sk-cortex-test' },
        openai: { apiKey: 'sk-openai-test' },
        anthropic: { tokens: [{ token: 'sk-ant-test', label: 'x', addedAt: '' }] },
        google: { apiKey: 'google-test' },
        codex: {
          accounts: [{ email: 'a@b.com', accessToken: 'at', refreshToken: 'rt', accountId: '1', addedAt: '' }],
        },
        copilot: { githubToken: 'gh-test' },
      });

      const removed = clearAllProviderCredentials();
      expect(removed).toBe(true);
      const after = readCredentials();
      expect(after.cortex).toBeUndefined();
      expect(after.openai).toBeUndefined();
      expect(after.anthropic).toBeUndefined();
      expect(after.google).toBeUndefined();
      expect(after.codex).toBeUndefined();
      expect(after.copilot).toBeUndefined();
    });
  });

  it('is idempotent and returns false on an already-empty store', () => {
    withHome(() => {
      expect(clearAllProviderCredentials()).toBe(false);
      expect(clearAllProviderCredentials()).toBe(false);
    });
  });

  it('preserves 0600 permissions on the remaining store file', () => {
    withHome(() => {
      writeCredentials({ cortex: { apiKey: 'sk-cortex-test' } });
      clearAllProviderCredentials();
      // Store file remains (empty object) with 0600.
      expect(fs.existsSync(credentialsPath())).toBe(true);
      expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(credentialsDir()).mode & 0o777).toBe(0o700);
    });
  });
});
