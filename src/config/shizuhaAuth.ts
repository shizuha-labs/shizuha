import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ShizuhaAuthState {
  username: string;
  /** Platform user ID (integer from shizuha-id). Used as the canonical user
   *  identifier across dashboard, mobile app, and agent backend. */
  userId?: number;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  lastLoginAt: string;
  /** Base URL that succeeded for auth calls (without trailing slash) */
  idApiBaseUrl?: string;
  /** OAuth public client used to mint RS256 access tokens for public MCP. */
  oauthClientId?: string;
  /** JWT alg for the stored access token, when decodable. */
  accessTokenAlg?: string;
}

const ACCESS_EXPIRY_SKEW_MS = 10 * 60_000;
const REFRESH_EXPIRY_RENEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
const AUTH_LOCK_STALE_MS = 120_000;
const AUTH_LOCK_RETRY_MS = 100;
const AUTH_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_CLIENT_ID = 'cortex-admin';
let authAutoRefreshTimer: NodeJS.Timeout | null = null;
let authAutoRefreshRefs = 0;
const authAutoRefreshErrorHandlers = new Set<(err: unknown) => void>();

function authDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha');
}

export function shizuhaAuthPath(): string {
  return path.join(authDir(), 'auth.json');
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseJwtExpIso(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payloadRaw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (payloadRaw.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(payloadRaw + '='.repeat(padLen), 'base64').toString('utf-8')) as { exp?: number };
    if (!payload.exp || typeof payload.exp !== 'number') return undefined;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return undefined;
  }
}

function parseJwtAlg(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const headerRaw = parts[0]!.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (headerRaw.length % 4)) % 4;
    const header = JSON.parse(Buffer.from(headerRaw + '='.repeat(padLen), 'base64').toString('utf-8')) as { alg?: string };
    return typeof header.alg === 'string' ? header.alg : undefined;
  } catch {
    return undefined;
  }
}

function isRs256Jwt(token: string | undefined): boolean {
  return parseJwtAlg(token ?? '') === 'RS256';
}

function expiresSoon(iso: string | undefined, skewMs = ACCESS_EXPIRY_SKEW_MS): boolean {
  if (!iso) return true;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return true;
  return ts <= (Date.now() + skewMs);
}

function knownExpired(iso: string | undefined, skewMs = 0): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts <= (Date.now() + skewMs);
}

function knownExpiresSoon(iso: string | undefined, skewMs: number): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts <= (Date.now() + skewMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authLockPath(): string {
  return path.join(authDir(), 'auth.json.lock');
}

async function withShizuhaAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = authDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const lockPath = authLockPath();
  const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
      acquired = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const stat = fs.statSync(lockPath);
        if ((Date.now() - stat.mtimeMs) > AUTH_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for Shizuha auth token lock');
      }
      await sleep(AUTH_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function candidateBaseUrls(preferredBaseUrl?: string): string[] {
  const fromEnv = [
    process.env['SHIZUHA_ID_URL'],
    process.env['ID_API_URL'],
    process.env['SHIZUHA_ID_API_URL'],
  ].filter((v): v is string => Boolean(v));

  return dedupe([
    preferredBaseUrl ?? '',
    ...fromEnv,
    'https://shizuha.com',
    'http://127.0.0.1',
    'http://localhost',
    'http://127.0.0.1:8001',
    'http://localhost:8001',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
  ]).map(normalizeBaseUrl);
}

function candidateOAuthTokenEndpoints(baseUrl: string): string[] {
  const candidates = [
    `${baseUrl}/id/api/oauth/token`,
    `${baseUrl}/shizuha-id/api/oauth/token`,
    `${baseUrl}/api/oauth/token`,
  ];
  return dedupe(candidates.map((c) => c.replace(/([^:]\/)\/+/g, '$1')));
}

function candidateAuthEndpoints(baseUrl: string, action: 'login' | 'refresh' | 'user'): string[] {
  const suffix = action === 'login'
    ? 'login/'
    : action === 'refresh'
      ? 'refresh/'
      : 'user/';

  const candidates = [
    `${baseUrl}/auth/${suffix}`,
    `${baseUrl}/api/auth/${suffix}`,
    `${baseUrl}/id/api/auth/${suffix}`,
    `${baseUrl}/shizuha-id/api/auth/${suffix}`,
  ];

  return dedupe(candidates.map((c) => c.replace(/([^:]\/)\/+/g, '$1')));
}

async function postJson(url: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; payload: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { ok: response.ok, status: response.status, payload };
}

function safeErrorMessage(payload: any): string {
  if (!payload || typeof payload !== 'object') return 'Unknown error';
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.detail === 'string') return payload.detail;
  return 'Authentication failed';
}

function inferBaseUrlFromEndpoint(endpoint: string, action: 'login' | 'refresh' | 'user'): string {
  const suffix = action === 'login'
    ? '/auth/login/'
    : action === 'refresh'
      ? '/auth/refresh/'
      : '/auth/user/';

  const apiSuffix = `/api${suffix}`;
  const idApiSuffix = `/id/api${suffix}`;
  const prefixedSuffix = `/shizuha-id/api${suffix}`;

  if (endpoint.endsWith(idApiSuffix)) return endpoint.slice(0, -idApiSuffix.length);
  if (endpoint.endsWith(prefixedSuffix)) return endpoint.slice(0, -prefixedSuffix.length);
  if (endpoint.endsWith(apiSuffix)) return endpoint.slice(0, -apiSuffix.length);
  if (endpoint.endsWith(suffix)) return endpoint.slice(0, -suffix.length);
  return endpoint;
}

function inferBaseUrlFromOAuthTokenEndpoint(endpoint: string): string {
  for (const suffix of ['/id/api/oauth/token', '/shizuha-id/api/oauth/token', '/api/oauth/token']) {
    if (endpoint.endsWith(suffix)) return endpoint.slice(0, -suffix.length);
  }
  return endpoint;
}

export function readShizuhaAuth(): ShizuhaAuthState | null {
  try {
    const raw = fs.readFileSync(shizuhaAuthPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ShizuhaAuthState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.username) return null;
    // Self-heal: legacy auth.json files may be missing the
    // {access,refresh}TokenExpiresAt fields (older login flow didn't persist
    // them). Decode the JWT exp claim at read time so `expiresSoon()` works
    // correctly without forcing a re-login.
    return {
      username: parsed.username,
      userId: parsed.userId
        ?? extractUserIdFromJwt(parsed.accessToken),
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt
        ?? parseJwtExpIso(parsed.accessToken),
      refreshTokenExpiresAt: parsed.refreshTokenExpiresAt
        ?? parseJwtExpIso(parsed.refreshToken),
      lastLoginAt: parsed.lastLoginAt ?? new Date().toISOString(),
      idApiBaseUrl: parsed.idApiBaseUrl,
      oauthClientId: parsed.oauthClientId,
      accessTokenAlg: parsed.accessTokenAlg ?? parseJwtAlg(parsed.accessToken),
    };
  } catch {
    return null;
  }
}

function extractUserIdFromJwt(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payloadRaw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (payloadRaw.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(payloadRaw + '='.repeat(padLen), 'base64').toString('utf-8')) as { user_id?: number; sub?: string | number };
    if (typeof payload.user_id === 'number') return payload.user_id;
    if (typeof payload.sub === 'number') return payload.sub;
    if (typeof payload.sub === 'string') {
      const n = parseInt(payload.sub, 10);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeShizuhaAuth(state: ShizuhaAuthState): void {
  const dir = authDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const filePath = shizuhaAuthPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function clearShizuhaAuth(): boolean {
  try {
    fs.rmSync(shizuhaAuthPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function getShizuhaAuthStatus(): {
  loggedIn: boolean;
  username?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
} {
  const state = readShizuhaAuth();
  if (!state) return { loggedIn: false };
  return {
    loggedIn: true,
    username: state.username,
    accessTokenExpiresAt: state.accessTokenExpiresAt,
    refreshTokenExpiresAt: state.refreshTokenExpiresAt,
  };
}

export async function loginToShizuhaId(username: string, password: string, platformUrl?: string): Promise<{ username: string; userId?: number }> {
  const bases = candidateBaseUrls(platformUrl);
  const oauthClientId = process.env['SHIZUHA_OAUTH_CLIENT_ID']?.trim() || DEFAULT_OAUTH_CLIENT_ID;
  const oauthEndpoints = bases.flatMap((base) => candidateOAuthTokenEndpoints(base));

  let lastError = 'Unable to reach Shizuha ID API';
  for (const endpoint of oauthEndpoints) {
    try {
      const result = await postJson(endpoint, {
        grant_type: 'password',
        client_id: oauthClientId,
        username,
        password,
        scope: '* openid profile email',
      });
      if (!result.ok) {
        lastError = safeErrorMessage(result.payload);
        continue;
      }

      const payload = result.payload as {
        access_token?: string;
        refresh_token?: string;
        access?: string;
        refresh?: string;
        username?: string;
        user?: { id?: number; username?: string };
      };
      const accessToken = payload.access_token ?? payload.access;
      const refreshToken = payload.refresh_token ?? payload.refresh;
      if (!accessToken || !refreshToken || !isRs256Jwt(accessToken)) {
        lastError = 'OAuth login response missing RS256 tokens';
        continue;
      }

      const resolvedUsername = payload.user?.username?.trim() || payload.username?.trim() || username;
      const state: ShizuhaAuthState = {
        username: resolvedUsername,
        userId: payload.user?.id ?? extractUserIdFromJwt(accessToken),
        accessToken,
        refreshToken,
        accessTokenExpiresAt: parseJwtExpIso(accessToken),
        refreshTokenExpiresAt: parseJwtExpIso(refreshToken),
        lastLoginAt: new Date().toISOString(),
        idApiBaseUrl: normalizeBaseUrl(inferBaseUrlFromOAuthTokenEndpoint(endpoint)),
        oauthClientId,
        accessTokenAlg: parseJwtAlg(accessToken),
      };
      writeShizuhaAuth(state);
      return { username: resolvedUsername, userId: state.userId };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const endpoints = bases.flatMap((base) => candidateAuthEndpoints(base, 'login'));

  for (const endpoint of endpoints) {
    try {
      const result = await postJson(endpoint, { username, password });
      if (!result.ok) {
        lastError = safeErrorMessage(result.payload);
        continue;
      }

      const payload = result.payload as {
        user?: { id?: number; username?: string };
        tokens?: { access?: string; refresh?: string };
        access?: string;
        refresh?: string;
      };

      const accessToken = payload.tokens?.access ?? payload.access;
      const refreshToken = payload.tokens?.refresh ?? payload.refresh;
      if (!accessToken || !refreshToken) {
        lastError = 'Login response missing tokens';
        continue;
      }

      const resolvedUsername = payload.user?.username?.trim() || username;
      const platformUserId = payload.user?.id;
      const state: ShizuhaAuthState = {
        username: resolvedUsername,
        userId: platformUserId,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: parseJwtExpIso(accessToken),
        refreshTokenExpiresAt: parseJwtExpIso(refreshToken),
        lastLoginAt: new Date().toISOString(),
        idApiBaseUrl: normalizeBaseUrl(inferBaseUrlFromEndpoint(endpoint, 'login')),
        accessTokenAlg: parseJwtAlg(accessToken),
      };

      writeShizuhaAuth(state);
      return { username: resolvedUsername, userId: platformUserId };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  throw new Error(lastError);
}

async function refreshAccessToken(state: ShizuhaAuthState): Promise<ShizuhaAuthState> {
  if (knownExpired(state.refreshTokenExpiresAt, 0)) {
    throw new Error('Refresh token expired. Please /login again.');
  }

  const bases = candidateBaseUrls(state.idApiBaseUrl);
  const endpoints = bases.flatMap((base) => candidateAuthEndpoints(base, 'refresh'));

  let lastError = 'Token refresh failed';
  for (const endpoint of endpoints) {
    try {
      const result = await postJson(endpoint, { refresh: state.refreshToken });
      if (!result.ok) {
        lastError = safeErrorMessage(result.payload);
        continue;
      }

      const payload = result.payload as { access?: string; refresh?: string };
      if (!payload.access) {
        lastError = 'Refresh response missing access token';
        continue;
      }

      const nextRefresh = payload.refresh ?? state.refreshToken;
      const next: ShizuhaAuthState = {
        ...state,
        accessToken: payload.access,
        refreshToken: nextRefresh,
        accessTokenExpiresAt: parseJwtExpIso(payload.access),
        refreshTokenExpiresAt: parseJwtExpIso(nextRefresh),
        idApiBaseUrl: normalizeBaseUrl(inferBaseUrlFromEndpoint(endpoint, 'refresh')),
      };

      writeShizuhaAuth(next);
      return next;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  throw new Error(lastError);
}

async function refreshOAuthAccessToken(state: ShizuhaAuthState): Promise<ShizuhaAuthState> {
  if (!state.oauthClientId) {
    throw new Error('Stored Shizuha auth is not OAuth-backed. Please /login again.');
  }
  if (knownExpired(state.refreshTokenExpiresAt, 0)) {
    throw new Error('Refresh token expired. Please /login again.');
  }

  const bases = candidateBaseUrls(state.idApiBaseUrl);
  const endpoints = bases.flatMap((base) => candidateOAuthTokenEndpoints(base));
  let lastError = 'OAuth token refresh failed';
  for (const endpoint of endpoints) {
    try {
      const result = await postJson(endpoint, {
        grant_type: 'refresh_token',
        client_id: state.oauthClientId,
        refresh_token: state.refreshToken,
        scope: '* openid profile email',
      });
      if (!result.ok) {
        lastError = safeErrorMessage(result.payload);
        continue;
      }
      const payload = result.payload as { access_token?: string; refresh_token?: string; access?: string; refresh?: string };
      const accessToken = payload.access_token ?? payload.access;
      const refreshToken = payload.refresh_token ?? payload.refresh ?? state.refreshToken;
      if (!accessToken || !isRs256Jwt(accessToken)) {
        lastError = 'OAuth refresh response missing RS256 access token';
        continue;
      }
      const next: ShizuhaAuthState = {
        ...state,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: parseJwtExpIso(accessToken),
        refreshTokenExpiresAt: parseJwtExpIso(refreshToken),
        idApiBaseUrl: normalizeBaseUrl(inferBaseUrlFromOAuthTokenEndpoint(endpoint)),
        accessTokenAlg: parseJwtAlg(accessToken),
      };
      writeShizuhaAuth(next);
      return next;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new Error(lastError);
}

export async function getValidShizuhaAccessToken(): Promise<string | null> {
  const state = readShizuhaAuth();
  if (!state) return null;

  if (!expiresSoon(state.accessTokenExpiresAt) && !knownExpiresSoon(state.refreshTokenExpiresAt, REFRESH_EXPIRY_RENEW_WINDOW_MS)) {
    return state.accessToken;
  }

  return withShizuhaAuthLock(async () => {
    const lockedState = readShizuhaAuth();
    if (!lockedState) return null;
    if (!expiresSoon(lockedState.accessTokenExpiresAt) && !knownExpiresSoon(lockedState.refreshTokenExpiresAt, REFRESH_EXPIRY_RENEW_WINDOW_MS)) {
      return lockedState.accessToken;
    }

    const refreshed = await refreshAccessToken(lockedState);
    return refreshed.accessToken;
  });
}

/**
 * Force-refresh the Shizuha access token regardless of expiry.
 * Used when Cortex rejects a JWT with "Signature has expired" — the token's
 * `exp` claim may still be valid but the server-side RS256 signing key was
 * rotated, making the signature invalid. A fresh token from the refresh
 * endpoint is signed with the current key.
 */
export async function forceRefreshShizuhaAccessToken(): Promise<string | null> {
  const state = readShizuhaAuth();
  if (!state) return null;

  return withShizuhaAuthLock(async () => {
    const lockedState = readShizuhaAuth();
    if (!lockedState) return null;

    try {
      const refreshed = await refreshAccessToken(lockedState);
      return refreshed.accessToken;
    } catch {
      // If login refresh fails, try OAuth refresh
      if (lockedState.oauthClientId) {
        try {
          const refreshed = await refreshOAuthAccessToken(lockedState);
          return refreshed.accessToken;
        } catch {
          return null;
        }
      }
      return null;
    }
  });
}

export async function getValidShizuhaOAuthAccessToken(): Promise<string | null> {
  const state = readShizuhaAuth();
  if (!state) return null;

  if (
    isRs256Jwt(state.accessToken)
    && !expiresSoon(state.accessTokenExpiresAt)
    && !knownExpiresSoon(state.refreshTokenExpiresAt, REFRESH_EXPIRY_RENEW_WINDOW_MS)
  ) {
    return state.accessToken;
  }

  if (!state.oauthClientId) return null;
  return withShizuhaAuthLock(async () => {
    const lockedState = readShizuhaAuth();
    if (!lockedState?.oauthClientId) return null;
    if (
      isRs256Jwt(lockedState.accessToken)
      && !expiresSoon(lockedState.accessTokenExpiresAt)
      && !knownExpiresSoon(lockedState.refreshTokenExpiresAt, REFRESH_EXPIRY_RENEW_WINDOW_MS)
    ) {
      return lockedState.accessToken;
    }

    const refreshed = await refreshOAuthAccessToken(lockedState);
    return refreshed.accessToken;
  });
}

export function startShizuhaAuthAutoRefresh(onError?: (err: unknown) => void): () => void {
  authAutoRefreshRefs++;
  if (onError) authAutoRefreshErrorHandlers.add(onError);

  const tick = async () => {
    try {
      // Prefer the login refresh path (password/session tokens), then OAuth
      // public-client refresh. Cortex uses the same RS256 access token; either
      // path keeps auth.json fresh so resolveCortexAuthToken() never serves a
      // JWT that Cortex will reject as "Signature has expired".
      const viaLogin = await getValidShizuhaAccessToken().catch(() => null);
      if (!viaLogin) {
        await getValidShizuhaOAuthAccessToken();
      }
    } catch (err) {
      for (const handler of authAutoRefreshErrorHandlers) {
        try { handler(err); } catch { /* ignore observer failures */ }
      }
    }
  };

  if (!authAutoRefreshTimer) {
    authAutoRefreshTimer = setInterval(() => { void tick(); }, AUTH_AUTO_REFRESH_INTERVAL_MS);
    authAutoRefreshTimer.unref?.();
    void tick();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (onError) authAutoRefreshErrorHandlers.delete(onError);
    authAutoRefreshRefs = Math.max(0, authAutoRefreshRefs - 1);
    if (authAutoRefreshRefs === 0 && authAutoRefreshTimer) {
      clearInterval(authAutoRefreshTimer);
      authAutoRefreshTimer = null;
    }
  };
}

export async function verifyShizuhaAuthIdentity(): Promise<{ username?: string }> {
  const token = await getValidShizuhaAccessToken();
  if (!token) throw new Error('Not logged in.');

  const state = readShizuhaAuth();
  const bases = candidateBaseUrls(state?.idApiBaseUrl);
  const endpoints = bases.flatMap((base) => candidateAuthEndpoints(base, 'user'));

  let lastError = 'Unable to verify login status';
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        let payload: any = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        lastError = safeErrorMessage(payload);
        continue;
      }
      const payload = await response.json() as { username?: string };
      return { username: payload.username ?? state?.username };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  throw new Error(lastError);
}
