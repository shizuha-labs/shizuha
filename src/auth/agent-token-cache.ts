/** The agent-owned disk cache shared by the runtime and one-shot subprocesses. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export interface AgentTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: number | string;
  email: string;
  organizationId: number;
  obtainedAt: string;
}

class CacheIdentityMismatch extends Error {}

function readCache(file: string): Partial<AgentTokenData> | null {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('agent token cache is not a regular file');
    const contents = fs.readFileSync(file, 'utf8'); // I/O failures remain cache refusal.
    let value: unknown;
    try { value = JSON.parse(contents); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Partial<AgentTokenData>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Linux flock is attached to the open directory description, inherited at fd3
 * by the fixed-argv helper and retained by this process after the helper exits.
 * Closing the fd (including on process death) releases it. No lock file or
 * stale-lock timer exists. Broker pods are Linux; other platforms retain the
 * legacy atomic writer, but decline broker cache projection without this lock.
 */
function withCacheLock<T>(directory: string, action: () => T): T {
  if (process.platform !== 'linux') {
    if (process.env['MCP_AUTH_PROXY_SOCKET']) throw new Error('broker cache locking requires Linux');
    return action();
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const lock = spawnSync('/usr/bin/flock', ['--exclusive', '--timeout', '1', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor], timeout: 1500,
    });
    if (lock.error || lock.status !== 0) throw new Error('agent token cache lock unavailable');
    return action();
  } finally {
    fs.closeSync(descriptor);
  }
}

function issuedAt(payload: Record<string, unknown> | null): number | null {
  const iat = payload?.['iat'];
  return typeof iat === 'number' && Number.isSafeInteger(iat) && iat > 0
    && iat <= Math.floor(Date.now() / 1000) ? iat : null;
}

function checkPrincipal(previous: Partial<AgentTokenData> | null, token: AgentTokenData): void {
  const previousUserId = principal(previous?.userId);
  const nextUserId = principal(token.userId);
  if (previousUserId && nextUserId && previousUserId !== nextUserId) throw new CacheIdentityMismatch();
}

/** Compare issuer time, never response arrival/obtainedAt or a longer TTL. */
function retainPrevious(previous: Partial<AgentTokenData> | null, token: AgentTokenData): boolean {
  if (!previous?.accessToken) return false;
  if (previous.accessToken === token.accessToken) return true;
  const oldClaims = claims(previous.accessToken);
  const nextClaims = claims(token.accessToken);
  const oldIat = issuedAt(oldClaims);
  const nextIat = issuedAt(nextClaims);
  // Only retain a still-valid token bound to the same principal. Distinct
  // tokens issued in the same second cannot be ordered; keep the current one.
  return oldIat !== null && nextIat !== null && oldIat >= nextIat
    && oldClaims?.['token_type'] === 'access'
    && principal(oldClaims['user_id']) === principal(token.userId)
    && oldClaims['username'] === nextClaims?.['username']
    && typeof oldClaims['exp'] === 'number' && oldClaims['exp'] * 1000 > Date.now();
}

/** All runtime writers share comparison + atomic replacement under one lock. */
export function writeAgentTokenCache(file: string, token: AgentTokenData): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('agent token cache directory is not a directory');
  // The normal cached broker GET needs no helper process or disk replacement.
  const initial = readCache(file);
  checkPrincipal(initial, token);
  if (initial?.accessToken === token.accessToken) return;
  withCacheLock(directory, () => {
    const previous = readCache(file); // Another process may have renewed while we waited.
    checkPrincipal(previous, token);
    if (retainPrevious(previous, token)) return;
    const temporary = path.join(directory, `.agent-token-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(token, null, 2));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  });
}

function claims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return null;
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown> : null;
  } catch { return null; }
}

function principal(value: unknown): string | null {
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9][0-9]*$/.test(String(value))
    ? String(value) : null;
}

/**
 * Successful broker acquisition is the renewal event. MCP calls this same
 * boundary without AgentTokenManager, so leaving persistence solely in that
 * manager stranded the subprocess cache while MCP used a renewed JWT.
 *
 * The authenticated pod-local broker is the signer/trust boundary. These
 * checks bind its claims to this seat before replacing its cache; they do not
 * independently verify a JWT signature. No extra request or timer is started.
 * False rejects malformed/mismatched identity. I/O failure preserves the old
 * cache and the caller can still use its valid in-memory broker token.
 */
export function synchronizeBrokerTokenCache(accessToken: string, expiresAt: string): boolean {
  const primary = process.env['AGENT_USERNAME']?.trim();
  const secondary = process.env['SHIZUHA_AGENT_USERNAME']?.trim();
  const username = primary || secondary;
  if (!username) return true; // Non-agent caller: no agent cache is selected.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,45}[a-z0-9])?$/.test(username)
      || (primary && secondary && primary !== secondary)) return false;
  const payload = claims(accessToken);
  const userId = principal(payload?.['user_id']);
  const exp = payload?.['exp'];
  const declaredExpiry = expiresAt ? Date.parse(expiresAt) : undefined;
  if (!payload || payload['username'] !== username || !userId || payload['token_type'] !== 'access'
      || issuedAt(payload) === null
      || typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= Date.now()
      || exp <= (payload['iat'] as number)
      || !Number.isFinite(new Date(exp * 1000).getTime())
      || (declaredExpiry !== undefined && (!Number.isFinite(declaredExpiry) || declaredExpiry !== exp * 1000))) {
    return false;
  }
  const expectedUserId = process.env['AGENT_USER_ID'];
  if (expectedUserId && principal(expectedUserId) !== userId) return false;
  const file = path.join(process.env['HOME'] ?? '/root', '.shizuha', 'auth', `token-${username}.json`);
  try {
    const previous = readCache(file);
    writeAgentTokenCache(file, {
      accessToken,
      refreshToken: '', // Broker owns refresh; never copy a password/refresh grant.
      expiresAt: new Date(exp * 1000).toISOString(),
      userId,
      email: typeof payload['email'] === 'string' ? payload['email'] : `${username}@agents.shizuha.io`,
      organizationId: typeof payload['organization_id'] === 'number'
        ? payload['organization_id'] : (previous?.organizationId ?? 1),
      obtainedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof CacheIdentityMismatch) return false;
    console.warn('Agent token cache update failed; existing cache retained');
  }
  return true;
}
