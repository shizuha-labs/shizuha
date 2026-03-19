import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeShizuhaAuth,
  readShizuhaAuth,
  clearShizuhaAuth,
  getShizuhaAuthStatus,
  shizuhaAuthPath,
  getValidShizuhaAccessToken,
  loginToShizuhaId,
  type ShizuhaAuthState,
} from '../../src/config/shizuhaAuth.js';

describe('shizuhaAuth', () => {
  let tmpHome: string;
  const originalHome = process.env['HOME'];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-auth-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env['HOME'] = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes and reads auth state', () => {
    const state: ShizuhaAuthState = {
      username: 'kai',
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      lastLoginAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      idApiBaseUrl: 'http://localhost:8001',
    };

    writeShizuhaAuth(state);
    const loaded = readShizuhaAuth();

    expect(loaded).toEqual(state);
    expect(shizuhaAuthPath()).toBe(path.join(tmpHome, '.shizuha', 'auth.json'));
  });

  it('creates auth file and directory with restricted permissions', () => {
    const state: ShizuhaAuthState = {
      username: 'ryo',
      accessToken: 'access',
      refreshToken: 'refresh',
      lastLoginAt: new Date().toISOString(),
    };

    writeShizuhaAuth(state);

    const filePath = shizuhaAuthPath();
    const dirPath = path.dirname(filePath);
    const fileMode = fs.statSync(filePath).mode & 0o777;
    const dirMode = fs.statSync(dirPath).mode & 0o777;

    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('clears auth and reports logged out status', async () => {
    writeShizuhaAuth({
      username: 'sora',
      accessToken: 'access',
      refreshToken: 'refresh',
      lastLoginAt: new Date().toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    });

    expect(getShizuhaAuthStatus().loggedIn).toBe(true);
    expect(clearShizuhaAuth()).toBe(true);
    expect(getShizuhaAuthStatus()).toEqual({ loggedIn: false });
    await expect(getValidShizuhaAccessToken()).resolves.toBeNull();
  });

  it('logs in via nginx /id/api path from host fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://localhost/id/api/auth/login/') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { username: 'hritik' },
            tokens: {
              access: 'access.token.value',
              refresh: 'refresh.token.value',
            },
          }),
        };
      }
      throw new Error('fetch failed');
    }));

    await expect(loginToShizuhaId('hritik', 'admin123')).resolves.toEqual({ username: 'hritik' });

    const stored = readShizuhaAuth();
    expect(stored?.username).toBe('hritik');
    expect(stored?.idApiBaseUrl).toBe('http://localhost');
  });
});
