/**
 * Agent Account Provisioner
 *
 * An agent is a shizuha-id user, full stop. The daemon authenticates as
 * each agent the same way a human does — POST /id/api/auth/login/ with
 * username + password — and trusts the login response as the single
 * source of truth for user_id / email / etc. No fragile lookups, no
 * "find me by name" guesses.
 *
 * Cred file (`~/.shizuha/agent-auth/<username>.json`) holds the long-
 * lived secret (the password) plus a denormalized cache of the latest
 * login result. The cache is informational; if it ever drifts from
 * shizuha-id, the next login wins and the file is rewritten.
 *
 * First-time provisioning (when the agent has never existed in
 * shizuha-id) goes through the internal agent identity API when the
 * daemon owner can be identified, so shizuha-id stamps
 * account_type=agent + created_by at creation. It then sets the
 * password and logs in. We only fall into provisioning when *login*
 * fails — never when a lookup says the user "might" exist.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

/**
 * Resolve a shizuha-id URL for an app path (given WITHOUT the public `/id`
 * ingress prefix, e.g. `api/auth/login/`).
 *
 * HA / flap-free: shizuha-id runs as ≥2 replicas behind a ClusterIP Service. When
 * `SHIZUHA_ID_INTERNAL_URL` is set (e.g. http://shizuha-id.shizuha.svc.cluster.local:8001)
 * every provisioning call — login, approve, set-password, register, refresh,
 * fleet-provision — goes straight to that Service, which load-balances across all
 * replicas. That removes the daemon's dependency on a SINGLE node's tailnet/ingress
 * path (`SHIZUHA_PLATFORM_URL` auto-detects to one host's Tailscale IP, e.g.
 * http://100.64.0.3): if that node or its nginx ingress flaps, provisioning WOULD
 * fail even though shizuha-id itself is healthy on another node — the exact
 * `account_provisioning_failed_after_retries` ANDON we saw during the LAN flap.
 * Fall back to the public front (`${baseUrl}/id/…`) only when no internal URL is
 * configured (dev / bare-metal). Direct app URLs carry no `/id` prefix.
 */
export function shizuhaIdApiUrl(baseUrl: string, appPath: string): string {
  const internalBase = (process.env['SHIZUHA_ID_INTERNAL_URL'] ?? '').trim().replace(/\/+$/, '');
  const cleanPath = appPath.replace(/^\/+/, '');
  return internalBase ? `${internalBase}/${cleanPath}` : `${baseUrl}/id/${cleanPath}`;
}

interface AgentCredentials {
  username: string;
  email: string;
  password: string;
  /** Cached from the most recent login response — informational only.
   *  shizuha-id is the source of truth; the next successful login
   *  rewrites this from the response payload. */
  userId?: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  createdAt: string;
}

interface ProvisionResult {
  accessToken: string;
  refreshToken: string;
  userId: number;
  username: string;
  email: string;
}

interface AgentLoginSuccess {
  kind: 'success';
  accessToken: string;
  refreshToken: string;
  userId: number;
}

interface AgentLoginCredentialMismatch {
  kind: 'credential-mismatch';
  reason: 'invalid-credentials';
  status: 401;
}

interface AgentLoginAuthState {
  kind: 'auth-state';
  reason: 'account-disabled' | 'pending-approval' | 'approval-denied' | '2fa-enrollment-required';
  status: 401 | 403;
}

interface AgentLoginTransient {
  kind: 'transient';
  reason: 'http' | 'transport' | 'invalid-response' | 'auth-contract' | 'backoff';
  status?: number;
  retryAfterMs: number;
}

type AgentLoginOutcome = AgentLoginSuccess | AgentLoginCredentialMismatch | AgentLoginAuthState | AgentLoginTransient;

const LOGIN_BACKOFF_BASE_MS = 2_000;
const LOGIN_BACKOFF_MAX_MS = 30_000;
const LOGIN_AUTH_BODY_MAX_BYTES = 4_096;
const loginBackoffByAgent = new Map<string, { failures: number; retryAt: number }>();

type BoundedJsonObject =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'malformed' | 'oversized' };

/**
 * Read the small Shizuha-ID authentication error contract without ever
 * retaining or logging an unbounded/raw response body. The stream path is used
 * for real fetch Responses; the text fallback keeps lightweight unit-test
 * doubles compatible with the same byte limit.
 */
async function readBoundedJsonObject(resp: Response): Promise<BoundedJsonObject> {
  const contentLength = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > LOGIN_AUTH_BODY_MAX_BYTES) {
    return { ok: false, reason: 'oversized' };
  }

  let text: string;
  if (resp.body?.getReader) {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > LOGIN_AUTH_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'oversized' };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(body);
  } else if (typeof resp.text === 'function') {
    text = await resp.text();
    if (new TextEncoder().encode(text).byteLength > LOGIN_AUTH_BODY_MAX_BYTES) {
      return { ok: false, reason: 'oversized' };
    }
  } else {
    // Lightweight test doubles may expose json() only. Production fetch
    // Responses always take the stream path above.
    try {
      const value = await resp.json();
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true, value: value as Record<string, unknown> }
        : { ok: false, reason: 'malformed' };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }

  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : { ok: false, reason: 'malformed' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * PLAT-4573: bounded exponential backoff with equal jitter.  Keeping a non-zero
 * floor avoids an immediate retry storm, while jitter prevents every fleet
 * agent from retrying Shizuha ID in lockstep.  `rand` is injectable so the
 * contract is deterministic in tests.
 */
export function computeAgentLoginBackoffMs(
  failures: number,
  rand: () => number = Math.random,
): number {
  const attempt = Math.max(1, Math.floor(failures));
  const ceiling = Math.min(LOGIN_BACKOFF_BASE_MS * (2 ** (attempt - 1)), LOGIN_BACKOFF_MAX_MS);
  const jitter = 0.5 + (Math.max(0, Math.min(1, rand())) * 0.5);
  return Math.round(ceiling * jitter);
}

function clearAgentLoginBackoff(baseUrl: string, username: string): void {
  loginBackoffByAgent.delete(`${baseUrl}\n${username}`);
}

function transientAgentLogin(
  baseUrl: string,
  username: string,
  detail: Omit<AgentLoginTransient, 'kind' | 'retryAfterMs'>,
): AgentLoginTransient {
  const key = `${baseUrl}\n${username}`;
  const failures = Math.min((loginBackoffByAgent.get(key)?.failures ?? 0) + 1, 32);
  const retryAfterMs = computeAgentLoginBackoffMs(failures);
  loginBackoffByAgent.set(key, { failures, retryAt: Date.now() + retryAfterMs });
  return { kind: 'transient', ...detail, retryAfterMs };
}

type PasswordRollback = (() => void | Promise<void>) | null | undefined;
type PersistAgentPassword = (password: string) => PasswordRollback | Promise<PasswordRollback>;

const CREDENTIALS_DIR_NAME = 'agent-auth';

function getCredentialsDir(): string {
  const dir = path.join(process.env['HOME'] ?? '~', '.shizuha', CREDENTIALS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadCredentials(username: string): AgentCredentials | null {
  const filePath = path.join(getCredentialsDir(), `${username}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function saveCredentials(creds: AgentCredentials): void {
  const filePath = path.join(getCredentialsDir(), `${creds.username}.json`);
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function generatePassword(): string {
  return crypto.randomBytes(24).toString('base64url') + '!A1';
}

function decodeJwtExpiry(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return new Date(Date.now() + 86400 * 1000).toISOString();
  }
}

function isTokenExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const BUFFER_MS = 5 * 60 * 1000;
  return Date.now() > new Date(expiresAt).getTime() - BUFFER_MS;
}

function saveAgentLogin(
  agentUsername: string,
  email: string,
  password: string,
  loginResult: { accessToken: string; refreshToken: string; userId: number },
): ProvisionResult {
  const creds: AgentCredentials = {
    username: agentUsername,
    email,
    password,
    userId: loginResult.userId,
    accessToken: loginResult.accessToken,
    refreshToken: loginResult.refreshToken,
    tokenExpiresAt: decodeJwtExpiry(loginResult.accessToken),
    createdAt: new Date().toISOString(),
  };
  saveCredentials(creds);
  return { ...loginResult, username: agentUsername, email };
}

/**
 * SCLI-202: a mutable admin-token holder that can RE-MINT itself when a call
 * fails because the daemon's admin access token was revoked mid-provision.
 *
 * Root cause of the PLAT-2982 fleet outage: the daemon reuses ONE admin token
 * for every agent's approve + set-password. set-password invalidates access
 * tokens (that is its job), and during a full-fleet re-provision the daemon's
 * own admin access token gets revoked partway through, so every REMAINING
 * approve/set-password 401s with "User access token revoked" → those agents'
 * passwords are never reconciled → they can't log in ("Invalid credentials") →
 * the broker can't mint Connect tokens → agents fall back to id-login and storm
 * shizuha-id. The refresh token survives (only the ACCESS token is revoked), so
 * the holder re-mints a fresh admin access token via the refresh flow and the
 * caller retries ONCE — turning a fleet-wide cascade into a self-heal.
 */
interface AdminTokenHolder {
  value: string;
  /** Force-refresh the admin access token; returns the new token or null. */
  remint?: () => Promise<string | null>;
}

/** True when a shizuha-id response indicates the CALLER's access token is
 *  revoked/invalid (as opposed to a genuine authz/validation failure). */
function looksRevokedAdminToken(status: number, data: Record<string, unknown>): boolean {
  if (status !== 401) return false;
  const msg = `${(data['error'] ?? data['detail'] ?? data['message'] ?? '')}`.toLowerCase();
  return (
    msg.includes('revoked') ||
    msg.includes('token is invalid') ||
    msg.includes('token not valid') ||
    msg.includes('invalid token') ||
    // Bare 401 with no informative body on an admin-authenticated call is
    // treated as a possibly-revoked token so we re-mint + retry once rather
    // than cascade-fail the rest of the fleet.
    msg === ''
  );
}

async function reconcileCanonicalAccountPassword(opts: {
  baseUrl: string;
  admin: AdminTokenHolder;
  agentUsername: string;
  email: string;
  userId: number;
  canonicalPassword: string;
}): Promise<ProvisionResult | null> {
  // SCLI-205 (A′): prefer the scoped fleet-provisioner endpoint (static token,
  // agents-only, atomic reconnect+set_password+approve) over the operator-admin
  // set-password. When the token isn't mounted, use the legacy admin path.
  if (fleetProvisionerToken()) {
    // PLAT-4006: the fleet-provisioner endpoint keys on USERNAME, not userId, so
    // it can heal a FULLY-drifted account even when no userId is resolvable (the
    // exact docker-held-agent case). Do NOT gate this path on userId.
    const prov = await provisionViaFleetEndpoint(opts.baseUrl, {
      username: opts.agentUsername, email: opts.email, password: opts.canonicalPassword,
    });
    if (!prov) return null;
  } else {
    // The operator-admin set_password path DOES need a concrete userId.
    if (opts.userId <= 0) {
      logger.error({ agent: opts.agentUsername }, 'Agent account: cannot reconcile canonical password via admin path without userId (no fleet-provisioner token mounted)');
      return null;
    }
    const passwordSet = await setAgentPassword(opts.baseUrl, opts.admin, opts.userId, opts.canonicalPassword);
    if (!passwordSet) return null;
  }
  // SCLI-202: set-password just invalidated every prior access token for this
  // user, so the ONLY safe next step is a fresh canonical login — never reuse a
  // cached/pre-set-password token. loginAgent below is that fresh mint; its
  // token (post-set-password) is what is stored + handed to the broker.
  const loginResult = await loginAgent(opts.baseUrl, opts.agentUsername, opts.canonicalPassword);
  if (loginResult.kind !== 'success') {
    logger.error({ agent: opts.agentUsername, userId: opts.userId, outcome: loginResult.kind }, 'Agent account: canonical password set but login failed');
    return null;
  }
  logger.info({ agent: opts.agentUsername, userId: loginResult.userId }, 'Agent account: reconciled canonical account password');
  return saveAgentLogin(opts.agentUsername, opts.email, opts.canonicalPassword, loginResult);
}

/**
 * Ensure an agent has a valid Shizuha ID JWT.
 *
 * Path:
 *   1. Cached token still valid → return it.
 *   2. Login with stored password → on success, persist + return.
 *   3. Login fails → provisionFirstTime (register + approve + set
 *      password + login). On success, persist + return.
 *   4. Provisioning fails → return null. Operator must intervene
 *      (no silent guessing, no fragile lookups that desync identity).
 *
 * The userId in the returned ProvisionResult always comes from the
 * login response, never from the cached file. If the cached file's
 * userId is wrong (e.g. from a past bug), it gets overwritten here.
 */
export async function ensureAgentAccount(opts: {
  agentUsername: string;
  agentEmail?: string;
  agentFirstName?: string;
  agentLastName?: string;
  platformUrl: string;
  adminToken: string;
  /** Runtime/daemon agent id, persisted in shizuha-id for agent ownership reconnects. */
  agentRuntimeId?: string;
  /** Canonical container-side credential (#2 broker scoped shizuha-id grant). */
  canonicalPassword?: string;
  /**
   * Persist the generated/reused password to the canonical container-side store.
   * Called before the shizuha-id account write; if any later step fails, the
   * returned rollback is invoked so the daemon never leaves #2 changed while #5
   * failed (PLAT-558 fail-closed single-write).
   */
  persistCanonicalPassword?: PersistAgentPassword;
  /**
   * SCLI-202: force-refresh the daemon's own admin access token. Called when an
   * admin-authenticated call (approve/set-password) 401s with a revoked-token
   * error mid-fleet, so provisioning self-heals instead of cascade-failing.
   */
  remintAdminToken?: () => Promise<string | null>;
}): Promise<ProvisionResult | null> {
  const { agentUsername, platformUrl, adminToken } = opts;
  const email = opts.agentEmail || `${agentUsername}@agents.shizuha.io`;
  const firstName = opts.agentFirstName || agentUsername.charAt(0).toUpperCase() + agentUsername.slice(1);
  const lastName = opts.agentLastName || '(AI Agent)';
  const baseUrl = platformUrl.replace(/\/+$/, '');
  // SCLI-202: a single mutable admin-token holder shared across this agent's
  // approve + set-password calls; on a mid-provision revocation it re-mints
  // once and the fresh token propagates to the remaining calls.
  const admin: AdminTokenHolder = { value: adminToken, remint: opts.remintAdminToken };

  const stored = loadCredentials(agentUsername);

  // PLAT-558: when the broker-scoped canonical credential (#2) exists, it is
  // authoritative. Do not fast-path on an old agent-auth token/password: first
  // reconcile shizuha-id (#5) to the same value, then return a fresh login token.
  if (opts.canonicalPassword) {
    const canonicalLogin = await loginAgent(baseUrl, agentUsername, opts.canonicalPassword);
    if (canonicalLogin.kind === 'success') {
      logger.info({ agent: agentUsername, userId: canonicalLogin.userId }, 'Agent account: logged in with canonical credential');
      return saveAgentLogin(agentUsername, email, opts.canonicalPassword, canonicalLogin);
    }

    // PLAT-4573: only the exact Shizuha-ID 401 Invalid credentials contract
    // proves credential drift. Disabled/policy states, unknown auth responses,
    // timeout, DNS/network failure, 429, 5xx, malformed success body, or active
    // backoff are non-drift/indeterminate and MUST NOT mutate the account.
    if (canonicalLogin.kind !== 'credential-mismatch') {
      logger.warn(
        {
          agent: agentUsername,
          outcome: canonicalLogin.kind,
          reason: canonicalLogin.reason,
          status: canonicalLogin.status,
          retryAfterMs: canonicalLogin.kind === 'transient' ? canonicalLogin.retryAfterMs : undefined,
        },
        'Agent account: canonical login is not a confirmed credential mismatch — failing closed without credential reconciliation (PLAT-4573)',
      );
      return null;
    }

    // PLAT-3997: the canonical (k8s Secret-injected) AGENT_PASSWORD received a
    // confirmed exact 401 Invalid credentials response from shizuha-id, so the
    // account password has DRIFTED.
    // This is the exact failure that breaks agent SSO after a creds
    // (re)generation (secret rotated, account never updated). Fail LOUD so the
    // drift is visible in logs, then reconcile the account to the canonical
    // (injected) value in the branches below so it self-heals to login=200.
    logger.error(
      { agent: agentUsername },
      'Agent account: account<->secret AGENT_PASSWORD DRIFT detected -- injected canonical password failed shizuha-id login; reconciling the account to the injected secret value (PLAT-3997)',
    );

    if (stored?.accessToken && !isTokenExpired(stored.tokenExpiresAt)) {
      const userId = decodeUserIdFromJwt(stored.accessToken) ?? stored.userId ?? 0;
      return await reconcileCanonicalAccountPassword({
        baseUrl, admin, agentUsername, email, userId, canonicalPassword: opts.canonicalPassword,
      });
    }

    if (stored?.password) {
      const legacyLogin = await loginAgent(baseUrl, agentUsername, stored.password);
      if (legacyLogin.kind === 'success') {
        return await reconcileCanonicalAccountPassword({
          baseUrl, admin, agentUsername, email, userId: legacyLogin.userId, canonicalPassword: opts.canonicalPassword,
        });
      }
    }

    // PLAT-4006 (candidate A — architect determination): FULLY-drifted account.
    // Canonical login failed, there is no valid cached token, and the legacy
    // password login failed or was absent — so NONE of the reconcile branches
    // above fired. Before PLAT-4006 this fell straight through to the
    // non-canonical fast paths below, which CANNOT fix a drifted account, so the
    // account stayed drifted and the agent thrashed (the docker-held agents
    // ichi/san/kai/ni drift post-restart -> empty-turn thrash). The daemon holds
    // shizuha-id admin rights, so reconcile UNCONDITIONALLY here — this is
    // exactly when self-healing is most needed. userId comes from the persisted
    // cred file (survives token expiry); the username-based fleet-provisioner
    // path needs no userId at all.
    const driftedUserId = (stored?.accessToken ? decodeUserIdFromJwt(stored.accessToken) : null) ?? stored?.userId ?? 0;
    const healed = await reconcileCanonicalAccountPassword({
      baseUrl, admin, agentUsername, email, userId: driftedUserId, canonicalPassword: opts.canonicalPassword,
    });
    if (healed) {
      logger.info({ agent: agentUsername }, 'Agent account: fully-drifted account self-healed via unconditional canonical reconcile (PLAT-4006)');
      return healed;
    }
    // PLAT-4006 / PLAT-1254 FAIL-LOUD: a fully-drifted agent that could not be
    // reconciled (no fleet token + no resolvable userId, or the admin
    // set_password/login failed) will keep failing shizuha-id auth and thrash.
    // Log LOUD so it is visible; do NOT silently fall through to a path that
    // cannot fix the drift. The bridge empty-turn detector (PLAT-1242) + auto-
    // andon (PLAT-1254) then surface it to the cluster manager DM.
    logger.error(
      { agent: agentUsername, userId: driftedUserId, hasFleetToken: !!fleetProvisionerToken() },
      'Agent account: FULLY-DRIFTED account could NOT self-heal — canonical+cached+legacy logins all failed AND the unconditional admin reconcile failed; agent will thrash until manually reconciled (PLAT-4006/PLAT-1254 fail-loud)',
    );
  }

  // 1. Cached, fresh token — fast path only when there is no canonical #2 value
  // to reconcile.
  if (stored?.accessToken && !isTokenExpired(stored.tokenExpiresAt)) {
    if (stored.password && opts.persistCanonicalPassword) {
      try {
        await opts.persistCanonicalPassword(stored.password);
      } catch (err) {
        logger.error({ agent: agentUsername, err: (err as Error).message }, 'Agent account: canonical credential backfill failed');
        return null;
      }
    }
    // Trust the JWT itself, not the cred file's denormalized userId field.
    const decodedUid = decodeUserIdFromJwt(stored.accessToken);
    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken || '',
      userId: decodedUid ?? stored.userId ?? 0,
      username: agentUsername,
      email,
    };
  }

  // 2. Login with stored password — legacy path used only until #2 is backfilled
  if (stored?.password) {
    const result = await loginAgent(baseUrl, agentUsername, stored.password);
    if (result.kind === 'success') {
      if (opts.persistCanonicalPassword) {
        try {
          await opts.persistCanonicalPassword(stored.password);
        } catch (err) {
          logger.error({ agent: agentUsername, err: (err as Error).message }, 'Agent account: canonical credential backfill failed');
          return null;
        }
      }
      const updated: AgentCredentials = {
        ...stored,
        userId: result.userId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        tokenExpiresAt: decodeJwtExpiry(result.accessToken),
      };
      saveCredentials(updated);
      logger.info({ agent: agentUsername, userId: result.userId }, 'Agent account: logged in');
      return { ...result, username: agentUsername, email };
    }
    if (result.kind !== 'credential-mismatch') {
      logger.warn(
        {
          agent: agentUsername,
          outcome: result.kind,
          reason: result.reason,
          status: result.status,
          retryAfterMs: result.kind === 'transient' ? result.retryAfterMs : undefined,
        },
        'Agent account: stored-password login is not a confirmed credential mismatch — failing closed without first-time provisioning (PLAT-4573)',
      );
      return null;
    }
    logger.warn({ agent: agentUsername }, 'Agent account: stored password credential mismatch — attempting first-time provision');
  }

  // 3. First-time provision (deliberate, not a fallback for transient login failures)
  return await provisionFirstTime({
    baseUrl, admin, agentUsername, email, firstName, lastName,
    agentRuntimeId: opts.agentRuntimeId,
    storedPassword: stored?.password,
    canonicalPassword: opts.canonicalPassword,
    persistCanonicalPassword: opts.persistCanonicalPassword,
  });
}

/**
 * SCLI-205 (A′): the scoped, STATIC fleet-provisioner token
 * (`X-Fleet-Provisioner-Token`). When present, the daemon provisions agent
 * accounts via the least-privilege `/id/api/internal/fleet/provision-agent/`
 * endpoint instead of the operator's (`hritik`) superuser token — a static token
 * is immune to the refresh-rotation race + operator-session coupling that are the
 * SCLI-205 root cause. Absent (token not yet mounted) → the legacy admin-token
 * path is used. Injected only into the rt-fleet/provisioner runtime (ren guardrail).
 */
function fleetProvisionerToken(): string {
  return (process.env['FLEET_PROVISIONER_TOKEN'] ?? '').trim();
}

/**
 * PLAT-3997: true when the scoped static fleet-provisioner token is mounted.
 *
 * When it is present, account reconciliation (create-or-reconnect + set_password
 * + approve) runs via the least-privilege `/provision-agent/` endpoint, which
 * authenticates with this STATIC token — a different auth path from the daemon's
 * admin JWT family. So even when the admin token family is dead (SCLI-205), the
 * fleet endpoint can still reconcile the account WITHOUT 401-storming shizuha-id.
 * The admin-family-dead provisioning skip must therefore NOT suppress
 * reconciliation while this token is available, or the k8s Secret's
 * `AGENT_PASSWORD` ships un-synced to the account -> login drift -> broken agent
 * SSO after any creds (re)generation (PLAT-3997).
 */
export function hasFleetProvisionerToken(): boolean {
  return fleetProvisionerToken().length > 0;
}

/**
 * SCLI-205 (A′): atomically create-or-reconnect + set_password + approve an agent
 * account via the scoped fleet-provisioner endpoint (agents-only). One call
 * replaces register + approve + admin set-password, and — being a static token —
 * cannot be revoked by the refresh-rotation race or an operator logout/rotation.
 * Returns { userId, action } or null on failure. The token is NEVER logged.
 */
async function provisionViaFleetEndpoint(
  baseUrl: string,
  opts: { username: string; email: string; password: string; runtimeId?: string; displayName?: string },
): Promise<{ userId: number; action: string } | null> {
  const token = fleetProvisionerToken();
  if (!token) return null;
  // SCLI-324: /api/internal/* is (correctly) blocked at the public nginx front
  // since the ID-52 ingress-guard, so the platform URL 404s this endpoint.
  // Call the shizuha-id service directly in-cluster when the internal URL is
  // configured (SHIZUHA_ID_INTERNAL_URL, e.g.
  // http://shizuha-id.shizuha.svc.cluster.local:8001 — direct app URLs carry no
  // /id prefix); fall back to the legacy platform-front path otherwise.
  const endpoint = shizuhaIdApiUrl(baseUrl, 'api/internal/fleet/provision-agent/');
  const call = async (ownerUserId?: number) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fleet-Provisioner-Token': token },
    body: JSON.stringify({
      username: opts.username,
      email: opts.email,
      password: opts.password,
      runtime_id: opts.runtimeId ?? '',
      display_name: opts.displayName ?? opts.username,
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
    }),
    signal: AbortSignal.timeout(10000),
  });
  try {
    let resp = await call();
    if (!resp.ok) {
      let data = await resp.json().catch(() => ({})) as Record<string, unknown>;
      // Unified plane (operator 2026-07-13): a personal-default agent account is
      // locked against ANONYMOUS fleet reconciles, but its OWNER'S daemon may
      // reconcile it — the id endpoint admits when owner_user_id matches the
      // account's created_by. Retry once declaring this daemon's owner; a
      // foreign daemon (different owner_subject) stays locked, and org agents
      // never send owner_user_id (their profiles stay untouched).
      const ownerSubject = parseInt((process.env['SHIZUHA_DAEMON_OWNER_SUBJECT'] || '').trim(), 10);
      if (data['reason'] === 'system_locked_personal_default' && Number.isFinite(ownerSubject) && ownerSubject > 0) {
        resp = await call(ownerSubject);
        if (!resp.ok) data = await resp.json().catch(() => data) as Record<string, unknown>;
      }
      if (!resp.ok) {
        logger.error(
          { agent: opts.username, status: resp.status, reason: data['reason'] ?? data['error'] },
          'Agent account: fleet-provisioner endpoint rejected provisioning',
        );
        return null;
      }
    }
    const data = await resp.json() as { user_id: number; action: string };
    logger.info(
      { agent: opts.username, userId: data.user_id, action: data.action },
      'Agent account: provisioned via scoped fleet endpoint (SCLI-205 A′)',
    );
    return { userId: data.user_id, action: data.action };
  } catch (err) {
    logger.warn({ agent: opts.username, err: (err as Error).message }, 'Agent account: fleet-provisioner fetch error');
    return null;
  }
}

async function provisionFirstTime(opts: {
  baseUrl: string;
  admin: AdminTokenHolder;
  agentUsername: string;
  email: string;
  firstName: string;
  lastName: string;
  agentRuntimeId?: string;
  storedPassword?: string;
  canonicalPassword?: string;
  persistCanonicalPassword?: PersistAgentPassword;
}): Promise<ProvisionResult | null> {
  const { baseUrl, admin, agentUsername, email, firstName, lastName } = opts;
  const adminToken = admin.value;
  // PLAT-558: #2 (broker scoped shizuha-id credential) is canonical for the
  // container side. Prefer it over legacy agent-auth / agent-passwords sources,
  // then write the chosen password to #2 and #5 together.
  const password = opts.canonicalPassword || opts.storedPassword || generatePassword();
  let rollbackCanonicalPassword: PasswordRollback;

  try {
    rollbackCanonicalPassword = await opts.persistCanonicalPassword?.(password);
  } catch (err) {
    logger.error({ agent: agentUsername, err: (err as Error).message }, 'Agent account: canonical credential write failed');
    return null;
  }
  const rollback = async () => {
    if (!rollbackCanonicalPassword) return;
    try {
      await rollbackCanonicalPassword();
    } catch (err) {
      logger.error({ agent: agentUsername, err: (err as Error).message }, 'Agent account: canonical credential rollback failed');
    }
  };

  // SCLI-205 (A′): when the scoped fleet-provisioner token is mounted, provision
  // via the least-privilege endpoint — ONE atomic create-or-reconnect +
  // set_password + approve with a static token, decoupled from the operator's
  // identity. No fallback to the operator-admin path here: if the endpoint
  // rejects, fail (the agent rides its id-login fallback, SCLI-201) rather than
  // silently re-coupling to hritik's superuser token.
  if (fleetProvisionerToken()) {
    const prov = await provisionViaFleetEndpoint(baseUrl, {
      username: agentUsername, email, password,
      runtimeId: opts.agentRuntimeId, displayName: `${firstName} ${lastName}`.trim(),
    });
    if (!prov) {
      await rollback();
      return null;
    }
    const fleetLogin = await loginAgent(baseUrl, agentUsername, password);
    if (fleetLogin.kind !== 'success') {
      logger.error({ agent: agentUsername }, 'Agent account: login after fleet provisioning failed');
      await rollback();
      return null;
    }
    logger.info({ agent: agentUsername, userId: fleetLogin.userId }, 'Agent account: provisioned via fleet endpoint and logged in');
    return saveAgentLogin(agentUsername, email, password, fleetLogin);
  }

  // Register (or no-op if account already exists). We don't trust the userId
  // returned here — we'll get the real one from the login response below.
  const registered = await registerAgent(baseUrl, {
    username: agentUsername, email, password, firstName, lastName,
    createdById: decodeUserIdFromJwt(adminToken),
    runtimeId: opts.agentRuntimeId,
    adminToken,
  });
  if (registered === null) {
    logger.error({ agent: agentUsername }, 'Agent account: registration failed');
    await rollback();
    return null;
  }

  const rollbackAfterIdentityWrite = async () => {
    if (registered.created && registered.userId > 0) {
      await rollbackAgentIdentity(baseUrl, registered.userId);
    }
    await rollback();
  };

  // Approve + force-reset the password to the one we have. We need the userId
  // for these calls — get it from the registration response (only trustworthy
  // source of an id, since shizuha-id created the account in this same call).
  const userId = registered.userId;
  if (userId > 0) {
    const approved = await approveAgent(baseUrl, admin, userId);
    const passwordSet = approved && await setAgentPassword(baseUrl, admin, userId, password);
    if (!passwordSet) {
      await rollbackAfterIdentityWrite();
      return null;
    }
  } else {
    // Account already existed and registration didn't return an id. We do
    // *not* fall back to /users/all/ lookup — those have desync'd identity
    // before. The operator must reset the password via the admin UI and
    // record it in the cred file manually.
    logger.error(
      { agent: agentUsername },
      'Agent account: account exists but registration did not return id; ' +
      'cannot auto-resync. Reset password via admin UI and re-run.',
    );
    await rollback();
    return null;
  }

  // Login is the canonical source of identity. Whatever it returns wins.
  const loginResult = await loginAgent(baseUrl, agentUsername, password);
  if (loginResult.kind !== 'success') {
    logger.error({ agent: agentUsername }, 'Agent account: login after provisioning failed');
    await rollbackAfterIdentityWrite();
    return null;
  }

  logger.info({ agent: agentUsername, userId: loginResult.userId }, 'Agent account: provisioned and logged in');
  return saveAgentLogin(agentUsername, email, password, loginResult);
}

function decodeUserIdFromJwt(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { user_id?: number | string };
    if (typeof payload.user_id === 'number') return payload.user_id;
    if (typeof payload.user_id === 'string') {
      const n = parseInt(payload.user_id, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function registerAgent(
  baseUrl: string,
  opts: {
    username: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    createdById?: number;
    runtimeId?: string;
    adminToken?: string;
  },
): Promise<{ userId: number; created: boolean } | null> {
  if (opts.createdById) {
    try {
      const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.adminToken) authHeaders['Authorization'] = `Bearer ${opts.adminToken}`;
      const resp = await fetch(shizuhaIdApiUrl(baseUrl, 'api/internal/agents/'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          username: opts.username,
          email: opts.email,
          created_by_id: opts.createdById,
          runtime_id: opts.runtimeId || '',
          display_name: opts.firstName,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
      if (resp.ok) {
        const userId = data.user_id as number;
        const action = data.action as string | undefined;
        logger.info(
          { agent: opts.username, userId, action, createdById: opts.createdById },
          'Agent account: internal agent identity reconciled',
        );
        return { userId, created: action === 'created' };
      }
      logger.error({ agent: opts.username, status: resp.status, error: data }, 'Agent account: internal agent identity error');
      return null;
    } catch (err) {
      logger.error({ agent: opts.username, err: (err as Error).message }, 'Agent account: internal agent identity fetch error');
      return null;
    }
  }

  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, 'api/auth/register/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: opts.username,
        email: opts.email,
        password: opts.password,
        password2: opts.password,
        first_name: opts.firstName,
        last_name: opts.lastName,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await resp.json() as Record<string, unknown>;

    if (resp.ok) {
      const userId = (data.user as Record<string, unknown>)?.id as number;
      logger.info({ agent: opts.username, userId }, 'Agent account: registered via legacy endpoint');
      return { userId, created: true };
    }

    const error = (data.error as string) || '';
    if (error.includes('already exists') || error.includes('Username already')) {
      logger.debug({ agent: opts.username }, 'Agent account: already registered');
      return { userId: 0, created: false };
    }

    logger.error({ agent: opts.username, error: data }, 'Agent account: registration error');
    return null;
  } catch (err) {
    logger.error({ agent: opts.username, err: (err as Error).message }, 'Agent account: registration fetch error');
    return null;
  }
}

async function rollbackAgentIdentity(baseUrl: string, userId: number): Promise<boolean> {
  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, `api/internal/users/${userId}/delete/`), {
      method: 'DELETE',
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      logger.info({ userId }, 'Agent account: rolled back newly provisioned identity');
      return true;
    }
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    logger.error({ userId, status: resp.status, error: data }, 'Agent account: identity rollback failed');
    return false;
  } catch (err) {
    logger.error({ userId, err: (err as Error).message }, 'Agent account: identity rollback fetch error');
    return false;
  }
}

async function approveAgent(
  baseUrl: string,
  admin: AdminTokenHolder,
  userId: number,
  _retriedAfterRemint = false,
): Promise<boolean> {
  if (userId === 0) return true;
  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, `api/auth/admin/users/${userId}/approve/`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${admin.value}`,
      },
      body: JSON.stringify({ status: 'approved' }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) return true;
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    if ((data.error as string)?.includes('already been reviewed')) return true;
    // SCLI-202: re-mint the admin token + retry once if it was revoked mid-fleet.
    if (!_retriedAfterRemint && admin.remint && looksRevokedAdminToken(resp.status, data)) {
      const fresh = await admin.remint();
      if (fresh && fresh !== admin.value) {
        admin.value = fresh;
        logger.warn({ userId }, 'Agent account: admin token revoked during approve — re-minted, retrying once');
        return approveAgent(baseUrl, admin, userId, true);
      }
    }
    logger.error({ userId, status: resp.status, error: data }, 'Agent account: approval error');
    return false;
  } catch (err) {
    logger.error({ userId, err: (err as Error).message }, 'Agent account: approval fetch error');
    return false;
  }
}

async function setAgentPassword(
  baseUrl: string,
  admin: AdminTokenHolder,
  userId: number,
  password: string,
  _retriedAfterRemint = false,
): Promise<boolean> {
  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, `api/auth/admin/users/${userId}/set-password/`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${admin.value}`,
      },
      // PLAT-556/558: opt into the agent-account set-password guard. This is the
      // DELIBERATE single-write provisioning path (the legitimate writer of an
      // agent's credential), so shizuha-id allows it; a human security sweep
      // hitting the same endpoint without this flag is refused (no fleet desync).
      body: JSON.stringify({ password, agent_provisioning: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      logger.info({ userId }, 'Agent account: password set');
      return true;
    }
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    // SCLI-202: the admin access token was revoked mid-fleet (an earlier
    // set-password invalidated it). Re-mint via the surviving refresh token and
    // retry ONCE so the rest of the fleet still reconciles instead of cascading.
    if (!_retriedAfterRemint && admin.remint && looksRevokedAdminToken(resp.status, data)) {
      const fresh = await admin.remint();
      if (fresh && fresh !== admin.value) {
        admin.value = fresh;
        logger.warn({ userId }, 'Agent account: admin token revoked during set-password — re-minted, retrying once');
        return setAgentPassword(baseUrl, admin, userId, password, true);
      }
    }
    logger.warn({ userId, status: resp.status, error: data }, 'Agent account: set-password failed');
    return false;
  } catch (err) {
    logger.warn({ userId, err: (err as Error).message }, 'Agent account: set-password error');
    return false;
  }
}

async function loginAgent(
  baseUrl: string,
  username: string,
  password: string,
): Promise<AgentLoginOutcome> {
  const backoffKey = `${baseUrl}\n${username}`;
  const backoff = loginBackoffByAgent.get(backoffKey);
  if (backoff && backoff.retryAt > Date.now()) {
    return {
      kind: 'transient',
      reason: 'backoff',
      retryAfterMs: backoff.retryAt - Date.now(),
    };
  }
  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, 'api/auth/login/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        const body = await readBoundedJsonObject(resp);
        if (!body.ok) {
          logger.debug(
            { agent: username, status: resp.status, contract: body.reason },
            'Agent login auth response did not match the bounded JSON contract',
          );
          return transientAgentLogin(baseUrl, username, {
            reason: 'auth-contract',
            status: resp.status,
          });
        }

        // The current Shizuha-ID contract authorizes privileged credential
        // repair only for this exact status/body pair. Fail closed if the ID
        // service changes the human-readable contract before adopting a stable
        // reviewed machine code with this caller.
        if (resp.status === 401 && body.value['error'] === 'Invalid credentials') {
          clearAgentLoginBackoff(baseUrl, username);
          return { kind: 'credential-mismatch', reason: 'invalid-credentials', status: 401 };
        }
        if (resp.status === 401 && body.value['error'] === 'Account is disabled') {
          clearAgentLoginBackoff(baseUrl, username);
          return { kind: 'auth-state', reason: 'account-disabled', status: 401 };
        }

        if (resp.status === 403) {
          const authStateByCode: Record<string, AgentLoginAuthState['reason']> = {
            pending_approval: 'pending-approval',
            approval_denied: 'approval-denied',
            '2fa_enrollment_required': '2fa-enrollment-required',
          };
          const reason = typeof body.value['code'] === 'string'
            ? authStateByCode[body.value['code']]
            : undefined;
          if (reason) {
            clearAgentLoginBackoff(baseUrl, username);
            return { kind: 'auth-state', reason, status: 403 };
          }
        }

        logger.debug(
          { agent: username, status: resp.status, contract: 'unknown' },
          'Agent login auth response did not match a recognized non-secret contract',
        );
        return transientAgentLogin(baseUrl, username, {
          reason: 'auth-contract',
          status: resp.status,
        });
      }

      logger.debug({ agent: username, status: resp.status, reason: 'http' }, 'Agent login failed');
      return transientAgentLogin(baseUrl, username, {
        reason: 'http',
        status: resp.status,
      });
    }

    const data = await resp.json().catch(() => null) as {
      user?: { id?: unknown };
      tokens?: { access?: unknown; refresh?: unknown };
    } | null;

    if (
      !data
      || typeof data.user?.id !== 'number'
      || typeof data.tokens?.access !== 'string'
      || typeof data.tokens?.refresh !== 'string'
    ) {
      logger.warn({ agent: username }, 'Agent login returned an invalid success payload');
      return transientAgentLogin(baseUrl, username, {
        reason: 'invalid-response',
      });
    }

    clearAgentLoginBackoff(baseUrl, username);
    return {
      kind: 'success',
      accessToken: data.tokens.access,
      refreshToken: data.tokens.refresh,
      userId: data.user.id,
    };
  } catch (err) {
    logger.warn({ agent: username, err: (err as Error).message }, 'Agent login fetch error');
    return transientAgentLogin(baseUrl, username, {
      reason: 'transport',
    });
  }
}

/**
 * Refresh an agent's expired access token using the refresh token.
 * Falls back to a fresh password login if refresh fails.
 */
export async function refreshAgentToken(
  platformUrl: string,
  agentUsername: string,
): Promise<string | null> {
  const stored = loadCredentials(agentUsername);
  if (!stored?.refreshToken) return null;

  const baseUrl = platformUrl.replace(/\/+$/, '');
  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, 'api/auth/refresh/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: stored.refreshToken }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      if (stored.password) {
        const loginResult = await loginAgent(baseUrl, agentUsername, stored.password);
        if (loginResult.kind === 'success') {
          stored.accessToken = loginResult.accessToken;
          stored.refreshToken = loginResult.refreshToken;
          stored.userId = loginResult.userId;
          stored.tokenExpiresAt = decodeJwtExpiry(loginResult.accessToken);
          saveCredentials(stored);
          return loginResult.accessToken;
        }
      }
      return null;
    }

    const data = await resp.json() as { access: string; refresh?: string };
    stored.accessToken = data.access;
    if (data.refresh) stored.refreshToken = data.refresh;
    stored.tokenExpiresAt = decodeJwtExpiry(data.access);
    // Also keep userId in sync with the JWT, in case it ever drifted.
    const decodedUid = decodeUserIdFromJwt(data.access);
    if (decodedUid) stored.userId = decodedUid;
    saveCredentials(stored);
    return data.access;
  } catch {
    return null;
  }
}

/**
 * SCLI-205: set once `refreshDaemonAdminToken` sees the admin REFRESH token
 * itself rejected (401/403) — i.e. the whole admin token FAMILY is dead
 * (access + refresh), which a refresh cannot recover. Provisioning callers
 * check this to STOP hammering set-password (the infinite "refresh rejected;
 * using existing token (best-effort)" loop that stormed shizuha-id and fed the
 * per-IP lockout, SCLI-204) and fail loud instead. Cleared automatically the
 * moment a usable admin access token is obtained again (e.g. auth.json is
 * externally re-provisioned with a fresh credential — SCLI-205 approach A).
 */
let _daemonAdminFamilyDead = false;
let _familyDeadLastLogMs = 0;

/** SCLI-205: true when the daemon's admin token family (access+refresh) is
 * revoked and cannot self-heal via refresh — provisioning should stop-batch and
 * fail loud rather than storm shizuha-id. */
export function isDaemonAdminFamilyDead(): boolean {
  return _daemonAdminFamilyDead;
}

/** Read + parse the daemon auth.json, or null if missing/unreadable. */
function readDaemonAuthFile(authFile: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(authFile)) return null;
    return JSON.parse(fs.readFileSync(authFile, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * PLAT-881: keep the DAEMON's OWN provisioning admin token (the owner account in
 * `~/.shizuha/auth.json`) fresh.
 *
 * `refreshAgentToken` above refreshes per-AGENT credentials; nothing ever
 * refreshed the daemon's own access token, so it silently aged out (~7.5d on
 * 2026-06-26) → every approve/set-password reconcile 401'd → agents couldn't
 * spawn with an identity. This refreshes it owner-scoped, in place, before
 * expiry, persisting the new token back to auth.json (the daemon re-reads it
 * per spawn — no restart needed).
 *
 * Returns a usable access token, or null only when auth.json has nothing usable.
 * Best-effort: a transient refresh failure returns the existing (possibly stale)
 * token so the caller's own retry/backoff still gets a shot, rather than
 * hard-failing provisioning on an id blip.
 */
export async function refreshDaemonAdminToken(opts: {
  platformUrl: string;
  authFile?: string;
  /**
   * SCLI-202: bypass the "fresh enough" early-return and refresh via the refresh
   * token unconditionally. Used when the cached admin ACCESS token was REVOKED
   * (not merely expired) mid-fleet — the JWT still looks unexpired but shizuha-id
   * rejects it, so we must mint a new one from the surviving refresh token.
   */
  force?: boolean;
}): Promise<string | null> {
  const authFile = opts.authFile
    ?? path.join(process.env['HOME'] ?? '~', '.shizuha', 'auth.json');
  const auth = readDaemonAuthFile(authFile);
  if (!auth) return null;

  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] as string : '';
  const refreshToken = typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] as string : '';
  if (!accessToken && !refreshToken) return null;

  // Fresh enough (expiry from auth.json, else decoded from the JWT) → use as-is.
  // SCLI-202: `force` skips this — a revoked token still parses as unexpired.
  const expiresAt = typeof auth['tokenExpiresAt'] === 'string'
    ? auth['tokenExpiresAt'] as string
    : (accessToken ? decodeJwtExpiry(accessToken) : undefined);
  if (!opts.force && accessToken && !isTokenExpired(expiresAt)) {
    _daemonAdminFamilyDead = false; // a usable admin token exists again — clear SCLI-205 halt
    return accessToken;
  }

  // Expired (or within the 5m buffer) and we have a refresh token → refresh it.
  if (!refreshToken) return accessToken || null;
  const baseUrl = opts.platformUrl.replace(/\/+$/, '');
  try {
    const resp = await fetch(shizuhaIdApiUrl(baseUrl, 'api/auth/refresh/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      // SCLI-205: a concurrent spawn may have refreshed + persisted a fresh
      // token between our read and this rejection (ROTATE_REFRESH_TOKENS
      // blacklists the old refresh, so a racing spawn's now-stale refresh 401s).
      // Re-read auth.json and use the newer token if one landed.
      const reread = readDaemonAuthFile(authFile);
      const rereadAccess = typeof reread?.['accessToken'] === 'string' ? reread['accessToken'] as string : '';
      const rereadExp = typeof reread?.['tokenExpiresAt'] === 'string'
        ? reread['tokenExpiresAt'] as string
        : (rereadAccess ? decodeJwtExpiry(rereadAccess) : undefined);
      if (rereadAccess && rereadAccess !== accessToken && rereadAccess !== refreshToken && !isTokenExpired(rereadExp)) {
        _daemonAdminFamilyDead = false;
        logger.info('Daemon admin token: refresh raced a concurrent spawn — using the token it just persisted');
        return rereadAccess;
      }
      // 401/403 = the refresh token itself is revoked/blacklisted → the whole
      // admin token FAMILY is dead (access + refresh) and refresh cannot recover
      // it. FAIL LOUD + mark it dead so provisioning STOPS (stop-batch) instead
      // of looping "using existing token (best-effort)" and storming shizuha-id
      // (SCLI-205 / SCLI-204). Recovery needs a fresh admin credential — SCLI-205
      // approach A: a dedicated daemon-provisioner service identity with a stored
      // password. Meanwhile agents fall back to per-agent id-login (SCLI-201).
      if (resp.status === 401 || resp.status === 403) {
        _daemonAdminFamilyDead = true;
        // SCLI-324: this fires once per provisioning attempt across the whole
        // fleet — dedupe to once a minute so a batch respawn doesn't emit
        // thousands of identical lines.
        const now = Date.now();
        if (now - _familyDeadLastLogMs > 60_000) {
          _familyDeadLastLogMs = now;
          logger.error({ status: resp.status }, 'Daemon admin token: REFRESH revoked — admin token family dead; halting agent provisioning until a fresh admin credential is provisioned (SCLI-205)');
        }
        return null;
      }
      // Transient (5xx / network) — keep the best-effort stale token so the
      // caller's own retry/backoff still gets a shot rather than hard-failing.
      logger.warn({ status: resp.status }, 'Daemon admin token: refresh transient failure; using existing token (best-effort)');
      return accessToken || null;
    }
    const data = await resp.json() as { access: string; refresh?: string };
    if (!data.access) return accessToken || null;
    // Merge into auth.json, preserving all other fields (userId, username, …),
    // and write atomically so an interrupted write never corrupts auth.json.
    auth['accessToken'] = data.access;
    if (data.refresh) auth['refreshToken'] = data.refresh;
    auth['tokenExpiresAt'] = decodeJwtExpiry(data.access);
    const decodedUid = decodeUserIdFromJwt(data.access);
    if (decodedUid) auth['userId'] = decodedUid;
    try {
      const tmp = `${authFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, authFile);
    } catch (err) {
      // Refresh succeeded but persist failed — still return the fresh token so
      // THIS spawn provisions; next spawn will refresh again.
      logger.warn({ err }, 'Daemon admin token: refreshed but failed to persist to auth.json');
    }
    _daemonAdminFamilyDead = false; // fresh family obtained — clear SCLI-205 halt
    logger.info('Daemon admin token: refreshed before expiry');
    return data.access;
  } catch {
    return accessToken || null;
  }
}
