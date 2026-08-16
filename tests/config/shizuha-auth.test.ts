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
  getValidShizuhaOAuthAccessToken,
  loginToShizuhaId,
  type ShizuhaAuthState,
} from '../../src/config/shizuhaAuth.js';

function jwt(alg: string, expSeconds: number, extra: Record<string, unknown> = {}): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg, typ: 'JWT' })}.${enc({ exp: expSeconds, ...extra })}.sig`;
}

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
      if (String(url).includes('/api/oauth/token')) {
        return { ok: false, status: 400, json: async () => ({ error: 'unsupported' }) };
      }
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

  it('prefers OAuth password login and stores RS256 tokens for MCP', async () => {
    const access = jwt('RS256', Math.floor(Date.now() / 1000) + 3600, { sub: '42', username: 'hritik' });
    const refresh = jwt('RS256', Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, { sub: '42', client_id: 'cortex-admin' });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://shizuha.com/api/oauth/token') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
        expect(body).toMatchObject({ grant_type: 'password', client_id: 'cortex-admin', username: 'hritik' });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: access,
            refresh_token: refresh,
          }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginToShizuhaId('hritik', 'admin123')).resolves.toEqual({ username: 'hritik', userId: 42 });

    const stored = readShizuhaAuth();
    expect(stored?.accessToken).toBe(access);
    expect(stored?.oauthClientId).toBe('cortex-admin');
    expect(stored?.accessTokenAlg).toBe('RS256');
    await expect(getValidShizuhaOAuthAccessToken()).resolves.toBe(access);
  });

  it('does not return legacy HS256 tokens for MCP OAuth auth', async () => {
    writeShizuhaAuth({
      username: 'hritik',
      accessToken: jwt('HS256', Math.floor(Date.now() / 1000) + 3600),
      refreshToken: jwt('HS256', Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
      lastLoginAt: new Date().toISOString(),
    });

    await expect(getValidShizuhaAccessToken()).resolves.toMatch(/\./);
    await expect(getValidShizuhaOAuthAccessToken()).resolves.toBeNull();
  });

  it('refreshes OAuth access tokens when refresh token expiry is unknown', async () => {
    const oldAccess = jwt('RS256', Math.floor(Date.now() / 1000) - 60, { sub: '42', username: 'hritik' });
    const newAccess = jwt('RS256', Math.floor(Date.now() / 1000) + 3600, { sub: '42', username: 'hritik' });
    writeShizuhaAuth({
      username: 'hritik',
      accessToken: oldAccess,
      refreshToken: 'opaque-refresh-token',
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      lastLoginAt: new Date().toISOString(),
      idApiBaseUrl: 'https://shizuha.com/id',
      oauthClientId: 'cortex-admin',
      accessTokenAlg: 'RS256',
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://shizuha.com/id/api/oauth/token') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
        expect(body).toMatchObject({
          grant_type: 'refresh_token',
          client_id: 'cortex-admin',
          refresh_token: 'opaque-refresh-token',
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: newAccess,
            refresh_token: 'next-opaque-refresh-token',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    }));

    await expect(getValidShizuhaOAuthAccessToken()).resolves.toBe(newAccess);

    const stored = readShizuhaAuth();
    expect(stored?.accessToken).toBe(newAccess);
    expect(stored?.refreshToken).toBe('next-opaque-refresh-token');
  });

  it('proactively rotates OAuth tokens before refresh expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldAccess = jwt('RS256', now + 3600, { sub: '42', username: 'hritik' });
    const oldRefresh = jwt('RS256', now + 24 * 60 * 60, { sub: '42', client_id: 'cortex-admin' });
    const newAccess = jwt('RS256', now + 3600, { sub: '42', username: 'hritik' });
    const newRefresh = jwt('RS256', now + 30 * 24 * 60 * 60, { sub: '42', client_id: 'cortex-admin' });
    writeShizuhaAuth({
      username: 'hritik',
      accessToken: oldAccess,
      refreshToken: oldRefresh,
      accessTokenExpiresAt: new Date((now + 3600) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date((now + 24 * 60 * 60) * 1000).toISOString(),
      lastLoginAt: new Date().toISOString(),
      idApiBaseUrl: 'https://shizuha.com',
      oauthClientId: 'cortex-admin',
      accessTokenAlg: 'RS256',
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://shizuha.com/id/api/oauth/token') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
        expect(body.refresh_token).toBe(oldRefresh);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: newAccess,
            refresh_token: newRefresh,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getValidShizuhaOAuthAccessToken()).resolves.toBe(newAccess);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = readShizuhaAuth();
    expect(stored?.refreshToken).toBe(newRefresh);
    expect(stored?.refreshTokenExpiresAt).toBe(new Date((now + 30 * 24 * 60 * 60) * 1000).toISOString());
  });

  it('serializes concurrent OAuth refreshes through a file lock', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldAccess = jwt('RS256', now - 60, { sub: '42', username: 'hritik' });
    const oldRefresh = jwt('RS256', now + 30 * 24 * 60 * 60, { sub: '42', client_id: 'cortex-admin' });
    const newAccess = jwt('RS256', now + 3600, { sub: '42', username: 'hritik' });
    const newRefresh = jwt('RS256', now + 30 * 24 * 60 * 60, { sub: '42', client_id: 'cortex-admin' });
    writeShizuhaAuth({
      username: 'hritik',
      accessToken: oldAccess,
      refreshToken: oldRefresh,
      accessTokenExpiresAt: new Date((now - 60) * 1000).toISOString(),
      refreshTokenExpiresAt: new Date((now + 30 * 24 * 60 * 60) * 1000).toISOString(),
      lastLoginAt: new Date().toISOString(),
      idApiBaseUrl: 'https://shizuha.com',
      oauthClientId: 'cortex-admin',
      accessTokenAlg: 'RS256',
    });

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: newAccess,
          refresh_token: newRefresh,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(Promise.all([
      getValidShizuhaOAuthAccessToken(),
      getValidShizuhaOAuthAccessToken(),
    ])).resolves.toEqual([newAccess, newAccess]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
