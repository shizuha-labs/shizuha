import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCortexAuthToken } from '../../src/provider/registry.js';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeJwt(expSec: number): string {
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({ exp: expSec, sub: '3', email: 't@example.com' });
  return `${header}.${payload}.sig`;
}

describe('resolveCortexAuthToken JWT expiry fallback', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevMode: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-cortex-auth-'));
    prevHome = process.env['HOME'];
    prevMode = process.env['SHIZUHA_CORTEX_AUTH_MODE'];
    process.env['HOME'] = tmpHome;
    delete process.env['SHIZUHA_CORTEX_AUTH_MODE'];
    delete process.env['CORTEX_API_KEY'];
    delete process.env['CORTEX_OAUTH_TOKEN'];
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevMode === undefined) delete process.env['SHIZUHA_CORTEX_AUTH_MODE'];
    else process.env['SHIZUHA_CORTEX_AUTH_MODE'] = prevMode;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('falls back to config API key when login JWT is expired', () => {
    const expired = makeJwt(Math.floor(Date.now() / 1000) - 120);
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
      username: 'hritik',
      userId: 3,
      accessToken: expired,
      refreshToken: 'refresh',
      accessTokenExpiresAt: new Date(Date.now() - 120_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
    }), { mode: 0o600 });

    const token = resolveCortexAuthToken({
      providers: { cortex: { apiKey: 'sk-cortex-fallback-key', baseUrl: 'https://cortex.example/v1' } },
    } as any);
    expect(token).toBe('sk-cortex-fallback-key');
  });

  it('uses a still-fresh login JWT when not near expiry', () => {
    const fresh = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
      username: 'hritik',
      userId: 3,
      accessToken: fresh,
      refreshToken: 'refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
    }), { mode: 0o600 });

    const token = resolveCortexAuthToken({
      providers: { cortex: { apiKey: 'sk-cortex-fallback-key', baseUrl: 'https://cortex.example/v1' } },
    } as any);
    expect(token).toBe(fresh);
  });

  it('falls back within the 10-minute expiry skew window', () => {
    // 5 minutes left → inside skew → must not send near-dead JWT
    const almost = makeJwt(Math.floor(Date.now() / 1000) + 5 * 60);
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
      username: 'hritik',
      accessToken: almost,
      refreshToken: 'refresh',
      accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
    }), { mode: 0o600 });

    const token = resolveCortexAuthToken({
      providers: { cortex: { apiKey: 'sk-cortex-fallback-key' } },
    } as any);
    expect(token).toBe('sk-cortex-fallback-key');
  });
});
