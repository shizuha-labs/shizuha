import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readCredentialsStrict,
  credentialsPath,
} from '../../src/config/credentials.js';

/**
 * SCLI-425: `auth status` must not silently map a corrupt
 * ~/.shizuha/credentials.json to "not configured", and must not raw-crash on a
 * JSON `null` root.
 */
describe('readCredentialsStrict (SCLI-425 corruption-aware read)', () => {
  let tmpHome: string;
  const originalHome = process.env['HOME'];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli425-creds-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seed(raw: string): void {
    const dir = path.dirname(credentialsPath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialsPath(), raw, { mode: 0o600 });
  }

  const corruptShapes: Array<[string, string]> = [
    ['empty file', ''],
    ['whitespace only', '   \n  '],
    ['invalid JSON', '{ not json !!'],
    ['JSON null', 'null'],
    ['array root', '[]'],
    ['string root', '"hello"'],
    ['number root', '42'],
    ['boolean root', 'true'],
  ];

  it.each(corruptShapes)('reports corruption for %s (ok=false)', (_name, raw) => {
    seed(raw);
    const result = readCredentialsStrict();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).not.toMatch(/\.js:\d+/);
    }
  });

  it('treats an absent store as clean missing (ok=true, empty store)', () => {
    const result = readCredentialsStrict();
    expect(result).toEqual({ ok: true, store: {} });
  });

  it('treats a valid empty object as clean', () => {
    seed('{}');
    const result = readCredentialsStrict();
    expect(result).toEqual({ ok: true, store: {} });
  });

  it('round-trips a valid populated store', () => {
    seed(JSON.stringify({ copilot: { githubToken: 'ghp_abc', addedAt: 't' } }));
    const result = readCredentialsStrict();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.store.copilot?.githubToken).toBe('ghp_abc');
    }
  });

  it('does not mutate, truncate, or replace the corrupt store', () => {
    const original = 'null';
    seed(original);
    const before = fs.readFileSync(credentialsPath(), 'utf-8');
    readCredentialsStrict();
    const after = fs.readFileSync(credentialsPath(), 'utf-8');
    expect(after).toBe(before);
    expect(after).toBe(original);
  });

  it('stays clean for a store with supported provider shape', () => {
    seed(
      JSON.stringify({
        anthropic: { tokens: [{ token: 't', label: 'l', addedAt: 'a' }] },
        codex: { accounts: [] },
      }),
    );
    const result = readCredentialsStrict();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.store.anthropic?.tokens?.length).toBe(1);
      expect(result.store.codex?.accounts).toEqual([]);
    }
  });
});
