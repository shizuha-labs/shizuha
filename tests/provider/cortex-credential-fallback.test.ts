import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveCortexAuthToken,
  resolveCortexBaseUrl,
  DEFAULT_CORTEX_BASE_URL,
} from '../../src/provider/registry.js';
import { setCortexApiKey, readCredentials } from '../../src/config/credentials.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

/**
 * SCLI-86 — the user's stored Cortex key (credentials.json) is the
 * lowest-priority fallback for inference auth. A signed-in Shizuha platform
 * token wins for interactive use so staff/owner service tier is preserved.
 * Each test gets an isolated HOME so the real credential store is untouched.
 */
describe('SCLI-86: stored Cortex key fallback', () => {
  const CORTEX_ENV = [
    'CORTEX_API_KEY',
    'CORTEX_API_KEY_SHARED_FALLBACK',
    'CORTEX_OAUTH_TOKEN',
    'CORTEX_BASE_URL',
    'SHIZUHA_CORTEX_AUTH_MODE',
  ];
  let tmpHome: string;
  let savedHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedHome = process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli86-'));
    process.env['HOME'] = tmpHome;
    for (const k of CORTEX_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env['HOME'] = savedHome;
    else delete process.env['HOME'];
    for (const k of CORTEX_ENV) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('setCortexApiKey persists the key (readable back, no group/other access)', () => {
    setCortexApiKey('sk-cortex-abc123');
    expect(readCredentials().cortex?.apiKey).toBe('sk-cortex-abc123');
    const mode = fs.statSync(path.join(tmpHome, '.shizuha', 'credentials.json')).mode & 0o777;
    expect(mode & 0o077).toBe(0); // owner-only — the credential file stays private
  });

  it('resolveCortexAuthToken falls back to the stored key (no env, no config)', () => {
    setCortexApiKey('sk-cortex-stored');
    expect(resolveCortexAuthToken()).toBe('sk-cortex-stored');
  });

  it('env CORTEX_API_KEY wins over the stored key when no platform login exists', () => {
    setCortexApiKey('sk-cortex-stored');
    process.env['CORTEX_API_KEY'] = 'sk-cortex-env';
    expect(resolveCortexAuthToken()).toBe('sk-cortex-env');
  });

  it('uses the shared fleet key when an agent has no dedicated Cortex key', () => {
    setCortexApiKey('sk-cortex-stored');
    process.env['CORTEX_API_KEY_SHARED_FALLBACK'] = 'sk-cortex-fleet';
    expect(resolveCortexAuthToken()).toBe('sk-cortex-fleet');
  });

  it('prefers a dedicated Cortex key over the shared fleet fallback', () => {
    process.env['CORTEX_API_KEY'] = 'sk-cortex-agent';
    process.env['CORTEX_API_KEY_SHARED_FALLBACK'] = 'sk-cortex-fleet';
    expect(resolveCortexAuthToken()).toBe('sk-cortex-agent');
  });

  it('signed-in Shizuha platform token wins over env CORTEX_API_KEY', () => {
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
      username: 'hritik',
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.e30.signature',
      refreshToken: 'platform-refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
    }));
    process.env['CORTEX_API_KEY'] = 'sk-cortex-env';
    expect(resolveCortexAuthToken()).toBe('eyJhbGciOiJSUzI1NiJ9.e30.signature');
  });

  it('old HS256 Shizuha platform tokens are skipped for Cortex RS256 auth', () => {
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
      username: 'hritik',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.e30.signature',
      refreshToken: 'platform-refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
    }));
    process.env['CORTEX_API_KEY'] = 'sk-cortex-env';
    expect(resolveCortexAuthToken()).toBe('sk-cortex-env');
  });

  it('SHIZUHA_CORTEX_AUTH_MODE=api_key forces API-key auth for service environments', () => {
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
      username: 'hritik',
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.e30.signature',
      refreshToken: 'platform-refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
    }));
    process.env['CORTEX_API_KEY'] = 'sk-cortex-env';
    process.env['SHIZUHA_CORTEX_AUTH_MODE'] = 'api_key';
    expect(resolveCortexAuthToken()).toBe('sk-cortex-env');
  });

  it('TOML config apiKey wins over the stored key', () => {
    setCortexApiKey('sk-cortex-stored');
    const cfg = { providers: { cortex: { apiKey: 'sk-cortex-toml' } } } as unknown as ShizuhaConfig;
    expect(resolveCortexAuthToken(cfg)).toBe('sk-cortex-toml');
  });

  it('resolveCortexBaseUrl uses the default, then the stored baseUrl', () => {
    expect(resolveCortexBaseUrl()).toBe(DEFAULT_CORTEX_BASE_URL);
    setCortexApiKey('sk-cortex-stored', 'https://cortex.example/v1');
    expect(resolveCortexBaseUrl()).toBe('https://cortex.example/v1');
  });

  it('setCortexApiKey preserves a previously stored baseUrl when only the key changes', () => {
    setCortexApiKey('sk-cortex-one', 'https://cortex.example/v1');
    setCortexApiKey('sk-cortex-two');
    const creds = readCredentials();
    expect(creds.cortex?.apiKey).toBe('sk-cortex-two');
    expect(creds.cortex?.baseUrl).toBe('https://cortex.example/v1');
  });
});
