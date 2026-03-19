import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ShizuhaAuthState {
  username: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  lastLoginAt: string;
  /** Base URL that succeeded for auth calls (without trailing slash) */
  idApiBaseUrl?: string;
}

const ACCESS_EXPIRY_SKEW_MS = 60_000;

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

function expiresSoon(iso: string | undefined, skewMs = ACCESS_EXPIRY_SKEW_MS): boolean {
  if (!iso) return true;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return true;
  return ts <= (Date.now() + skewMs);
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
    'http://127.0.0.1',
    'http://localhost',
    'http://127.0.0.1:8001',
    'http://localhost:8001',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
  ]).map(normalizeBaseUrl);
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

export function readShizuhaAuth(): ShizuhaAuthState | null {
  try {
    const raw = fs.readFileSync(shizuhaAuthPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ShizuhaAuthState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.username) return null;
    return {
      username: parsed.username,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
      refreshTokenExpiresAt: parsed.refreshTokenExpiresAt,
      lastLoginAt: parsed.lastLoginAt ?? new Date().toISOString(),
      idApiBaseUrl: parsed.idApiBaseUrl,
    };
  } catch {
    return null;
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

export async function loginToShizuhaId(username: string, password: string): Promise<{ username: string }> {
  const bases = candidateBaseUrls();
  const endpoints = bases.flatMap((base) => candidateAuthEndpoints(base, 'login'));

  let lastError = 'Unable to reach Shizuha ID API';
  for (const endpoint of endpoints) {
    try {
      const result = await postJson(endpoint, { username, password });
      if (!result.ok) {
        lastError = safeErrorMessage(result.payload);
        continue;
      }

      const payload = result.payload as {
        user?: { username?: string };
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
      const state: ShizuhaAuthState = {
        username: resolvedUsername,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: parseJwtExpIso(accessToken),
        refreshTokenExpiresAt: parseJwtExpIso(refreshToken),
        lastLoginAt: new Date().toISOString(),
        idApiBaseUrl: normalizeBaseUrl(inferBaseUrlFromEndpoint(endpoint, 'login')),
      };

      writeShizuhaAuth(state);
      return { username: resolvedUsername };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  throw new Error(lastError);
}

async function refreshAccessToken(state: ShizuhaAuthState): Promise<ShizuhaAuthState> {
  if (expiresSoon(state.refreshTokenExpiresAt, 0)) {
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

export async function getValidShizuhaAccessToken(): Promise<string | null> {
  const state = readShizuhaAuth();
  if (!state) return null;

  if (!expiresSoon(state.accessTokenExpiresAt)) {
    return state.accessToken;
  }

  const refreshed = await refreshAccessToken(state);
  return refreshed.accessToken;
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
