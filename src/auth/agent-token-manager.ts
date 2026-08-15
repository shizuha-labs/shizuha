/**
 * Agent Token Manager — single source of truth for an agent's shizuha-id JWT.
 *
 * Each agent authenticates against shizuha-id like any other user (username +
 * password) and uses the resulting JWT for all platform service calls (MCP,
 * Connect REST, etc.). No local HMAC minting — shizuha-id is the only signer.
 *
 * Token lifecycle:
 *   1. In-memory cache  → return if not near expiry
 *   2. On-disk cache    → return if not near expiry
 *   3. Refresh endpoint → if refresh token still valid
 *   4. Fresh login      → POST /id/api/auth/login/ with AGENT_USERNAME/AGENT_PASSWORD
 *   5. Persist to disk  → so we survive process restarts
 *
 * Disk cache is keyed per agent username so multiple agents sharing the same
 * HOME (e.g. daemon-side calls) do not clobber each other's tokens.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { brokerPresent, fetchBrokerToken } from './broker-token.js';
import { readAgentCredential } from './credential-resolver.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO timestamp
  userId: number;
  email: string;
  organizationId: number;
  obtainedAt: string;
}

export interface AgentTokenManagerOptions {
  agentUsername: string;
  agentEmail?: string;
  /** Backend base (e.g. http://s1.tail.shizuha.com or http://host.docker.internal:8016). */
  platformUrl: string;
  /** Override the directory where token files live. Defaults to $HOME/.shizuha/auth. */
  tokenDir?: string;
  /** Ignore AGENT_ACCESS_TOKEN env fallback; used after a token was rejected by the platform. */
  ignoreEnvToken?: boolean;
  /** Optional daemon-side password override for supervised agent-as-sender calls. */
  agentPassword?: string;
}

export class AgentTokenManager {
  private tokenFile: string;
  private legacyTokenFile: string;
  private token: TokenData | null = null;
  private platformUrl: string;
  private agentEmail: string;
  private agentUsername: string;
  private ignoreEnvToken: boolean;
  private agentPassword?: string;

  constructor(opts: AgentTokenManagerOptions) {
    this.agentUsername = opts.agentUsername;
    this.agentEmail = opts.agentEmail || `${opts.agentUsername}@agents.shizuha.io`;
    this.ignoreEnvToken = opts.ignoreEnvToken === true;
    this.agentPassword = opts.agentPassword;
    // Use HTTP for internal service calls — Tailscale handles encryption and
    // self-signed nginx certs would otherwise trip TLS validation from inside
    // containers.
    this.platformUrl = opts.platformUrl.replace(/\/+$/, '').replace('https://', 'http://');
    const tokenDir = opts.tokenDir || path.join(process.env['HOME'] ?? '/root', '.shizuha', 'auth');
    fs.mkdirSync(tokenDir, { recursive: true });
    this.tokenFile = path.join(tokenDir, `token-${opts.agentUsername}.json`);
    // Pre-rename layout used a single token.json shared across all agents.
    this.legacyTokenFile = path.join(tokenDir, 'token.json');
  }

  /**
   * Return a valid access token, refreshing or re-logging in as needed.
   * Returns null only when shizuha-id is unreachable or credentials are wrong.
   */
  async getToken(): Promise<string | null> {
    if (this.token && !this.isExpired(this.token.expiresAt)) {
      return this.token.accessToken;
    }
    const envToken = this.ignoreEnvToken ? null : this.tokenFromEnv();
    if (envToken && !this.isExpired(envToken.expiresAt)) {
      this.token = envToken;
      this.persistToDisk(envToken);
      return envToken.accessToken;
    }
    if (!this.token) this.token = this.loadFromDisk();
    if (this.token && !this.isExpired(this.token.expiresAt)) {
      return this.token.accessToken;
    }
    // PLAT-169: per-agent broker sidecar path. When the broker UDS is present,
    // AGENT_PASSWORD lives only in the sidecar — it mints/refreshes the JWT and
    // serves the current token over GET /token. Source it from there instead of
    // the in-container password login. The broker performs the shizuha-id
    // refresh internally, so on expiry we simply re-fetch rather than
    // refresh/login here. No password fallback in broker mode (the password is
    // absent by design) — return null so the caller retries once the broker is
    // ready (the agent's readiness is gated on the broker's /readyz).
    if (brokerPresent()) {
      const brokered = await this.tokenFromBroker();
      if (brokered) {
        this.token = brokered;
        this.persistToDisk(brokered);
        return brokered.accessToken;
      }
      if (!readAgentCredential('AGENT_PASSWORD')) {
        console.warn(`[${this.agentUsername}] Agent token: broker /token not ready and AGENT_PASSWORD absent — will retry`);
        return null;
      }
      console.warn(`[${this.agentUsername}] Agent token: broker /token unavailable — falling back to own shizuha-id credential`);
    }
    if (this.token?.refreshToken) {
      const refreshed = await this.refreshToken(this.token.refreshToken);
      if (refreshed) {
        this.token = refreshed;
        this.persistToDisk(refreshed);
        return refreshed.accessToken;
      }
    }
    const fresh = await this.loginToShizuhaId();
    if (fresh) {
      this.token = fresh;
      this.persistToDisk(fresh);
      return fresh.accessToken;
    }
    console.error(`[${this.agentUsername}] Agent token: shizuha-id login failed`);
    return null;
  }

  async ensureAuthenticated(): Promise<boolean> {
    const t = await this.getToken();
    if (t) {
      console.log(`[${this.agentUsername}] Agent token: ready (expires ${this.token?.expiresAt})`);
      return true;
    }
    return false;
  }

  /**
   * Like getToken() but RETRIES transient failures with exponential backoff +
   * jitter instead of giving up. This is what makes agents self-heal from a
   * temporary shizuha-id outage (e.g. the post-reboot stale-DB-pool window):
   * getToken() returning null once must never permanently wedge an agent into
   * running unauthenticated. The agent simply waits and keeps trying until
   * shizuha-id is back.
   *
   * Backoff: baseDelayMs doubling up to maxDelayMs (default 1s → 30s) plus
   * jitter. Retries until a token is obtained or maxWaitMs elapses (default
   * 10 min — long enough to ride out any normal cluster/service restart while
   * still giving up eventually if creds are genuinely broken, so the caller can
   * surface it / the daemon can recycle the container). Pass maxWaitMs:0 for
   * indefinite. Never throws.
   */
  async getTokenWithRetry(opts?: { maxWaitMs?: number; baseDelayMs?: number; maxDelayMs?: number }): Promise<string | null> {
    const baseDelay = opts?.baseDelayMs ?? 1000;
    const maxDelay = opts?.maxDelayMs ?? 30_000;
    const maxWaitMs = opts?.maxWaitMs ?? 10 * 60_000;
    const deadline = maxWaitMs > 0 ? Date.now() + maxWaitMs : Number.POSITIVE_INFINITY;
    let attempt = 0;
    for (;;) {
      let token: string | null = null;
      try {
        token = await this.getToken();
      } catch (err) {
        console.warn(`[${this.agentUsername}] Agent token: mint threw — ${(err as Error).message}`);
      }
      if (token) {
        if (attempt > 0) {
          console.log(`[${this.agentUsername}] Agent token: recovered after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
        }
        return token;
      }
      attempt++;
      if (Date.now() >= deadline) {
        console.error(`[${this.agentUsername}] Agent token: still failing after ${attempt} attempts — giving up (maxWaitMs reached)`);
        return null;
      }
      const exp = Math.min(maxDelay, baseDelay * 2 ** Math.min(attempt - 1, 16));
      const delay = exp + Math.floor(Math.random() * Math.min(1000, exp));
      console.warn(`[${this.agentUsername}] Agent token: mint failed (attempt ${attempt}) — retrying in ${Math.round(delay / 1000)}s (backoff)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** Decode the platform user_id claim from the cached token (after getToken). */
  getUserId(): number | undefined {
    return this.token?.userId;
  }

  private isExpired(expiresAt: string): boolean {
    const expiry = new Date(expiresAt).getTime();
    // Legacy access-only cache files may have an empty/malformed expiresAt.
    // `Date#getTime()` returns NaN for those values, and every comparison with
    // NaN is false, so the old implementation treated an already-expired JWT
    // as valid forever and never consulted the live broker. Fail closed on
    // invalid metadata so the broker can replace the stale durable cache.
    if (!Number.isFinite(expiry)) return true;
    return Date.now() > (expiry - TOKEN_REFRESH_BUFFER_MS);
  }

  private loadFromDisk(): TokenData | null {
    for (const file of [this.tokenFile, this.legacyTokenFile]) {
      try {
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as TokenData;
          if (data?.accessToken) return data;
        }
      } catch (err) {
        console.warn(`[${this.agentUsername}] Agent token: failed to read ${file}: ${(err as Error).message}`);
      }
    }
    return null;
  }

  private persistToDisk(token: TokenData): void {
    try {
      fs.writeFileSync(this.tokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn(`[${this.agentUsername}] Agent token: failed to write ${this.tokenFile}: ${(err as Error).message}`);
    }
  }

  private tokenFromEnv(): TokenData | null {
    const accessToken = process.env['AGENT_ACCESS_TOKEN'];
    if (!accessToken) return null;
    const decoded = this.decodeTokenPayload(accessToken) ?? {};
    const expiresAt = this.decodeTokenExpiry(accessToken);
    console.log(`[${this.agentUsername}] Agent token: using daemon-provisioned AGENT_ACCESS_TOKEN (expires ${expiresAt})`);
    return {
      accessToken,
      refreshToken: this.token?.refreshToken ?? '',
      expiresAt,
      userId: decoded['user_id'] ?? this.token?.userId ?? Number(process.env['AGENT_USER_ID'] || 0),
      email: decoded['email'] ?? this.agentEmail,
      organizationId: decoded['organization_id'] ?? this.token?.organizationId ?? 1,
      obtainedAt: new Date().toISOString(),
    };
  }

  private async refreshToken(refreshToken: string): Promise<TokenData | null> {
    try {
      const url = `${this.platformUrl}/id/api/auth/refresh/`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: refreshToken }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        console.warn(`[${this.agentUsername}] Agent token refresh failed: ${resp.status}`);
        return null;
      }
      const data = await resp.json() as { access: string; refresh?: string };
      const expiry = this.decodeTokenExpiry(data.access);
      const decoded = this.decodeTokenPayload(data.access) ?? {};
      console.log(`[${this.agentUsername}] Agent token refreshed (expires ${expiry})`);
      return {
        accessToken: data.access,
        refreshToken: data.refresh || refreshToken,
        expiresAt: expiry,
        userId: decoded['user_id'] ?? this.token?.userId ?? 0,
        email: decoded['email'] ?? this.agentEmail,
        organizationId: decoded['organization_id'] ?? this.token?.organizationId ?? 1,
        obtainedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`[${this.agentUsername}] Agent token refresh error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * PLAT-169: fetch the JWT from the per-agent broker sidecar over its UDS and
   * map it to TokenData. The broker owns the refresh (its AGENT_PASSWORD), so we
   * hold no refresh token — on expiry getToken() re-fetches the current token.
   */
  private async tokenFromBroker(): Promise<TokenData | null> {
    const bt = await fetchBrokerToken();
    if (!bt?.accessToken) return null;
    const decoded = this.decodeTokenPayload(bt.accessToken) ?? {};
    const expiresAt = bt.expiresAt || this.decodeTokenExpiry(bt.accessToken);
    console.log(`[${this.agentUsername}] Agent token: minted by broker sidecar (expires ${expiresAt})`);
    return {
      accessToken: bt.accessToken,
      refreshToken: '', // broker owns refresh; the agent never holds it
      expiresAt,
      userId: decoded['user_id'] ?? this.token?.userId ?? 0,
      email: decoded['email'] ?? this.agentEmail,
      organizationId: decoded['organization_id'] ?? this.token?.organizationId ?? 1,
      obtainedAt: new Date().toISOString(),
    };
  }

  /**
   * Authenticate the agent against shizuha-id with the credentials its
   * container was provisioned with (AGENT_PASSWORD env). Optionally upgrades
   * the resulting login JWT to a long-lived API token via the api-token
   * endpoint when available.
   */
  private async loginToShizuhaId(): Promise<TokenData | null> {
    const password = this.agentPassword || readAgentCredential('AGENT_PASSWORD') || '';
    if (!password) {
      console.error(`[${this.agentUsername}] Agent token: AGENT_PASSWORD not set — cannot log in`);
      return null;
    }
    try {
      const loginUrl = `${this.platformUrl}/id/api/auth/login/`;
      const doLogin = () => fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.agentUsername, password }),
        signal: AbortSignal.timeout(10000),
      });
      const loginResp = await doLogin();
      // SECURITY: agents do NOT hold an admin token and do NOT self-heal password
      // drift. Injecting DAEMON_ADMIN_TOKEN into every runtime was a privilege-
      // escalation risk (any agent could reset any user's password). The daemon
      // provisions each account's password reliably at spawn (with retry), so
      // drift should not occur; if it ever does, recovery is OWNER-SCOPED (the
      // user that owns the agent re-provisions it), not agent-self via admin.
      if (!loginResp.ok) {
        const errText = await loginResp.text();
        console.error(`[${this.agentUsername}] shizuha-id login failed: ${loginResp.status} ${errText.slice(0, 200)}`);
        return null;
      }
      const loginData = await loginResp.json() as {
        tokens?: { access: string; refresh: string };
        access?: string;
        refresh?: string;
        user?: { id: number; email: string };
      };
      const accessToken = loginData.tokens?.access ?? loginData.access ?? '';
      const refreshToken = loginData.tokens?.refresh ?? loginData.refresh ?? '';
      if (!accessToken) {
        console.error(`[${this.agentUsername}] shizuha-id login: no access token in response`);
        return null;
      }

      // Try to upgrade to a long-lived API token (like a GitHub PAT) so we
      // do not have to refresh on every restart. If the endpoint isn't
      // available we just keep the short-lived login token — the refresh
      // flow above handles continuation.
      // The upgrade is a best-effort OPTIMIZATION. It MUST NOT be able to fail
      // the login: keep it in its own try/catch with a short timeout so a slow/
      // hanging api-token call (observed over the public edge from off-cluster
      // runtimes) falls back to the already-valid login token instead of
      // nulling the whole mint. (Previously this fetch shared the outer try, so
      // its 10s abort threw past the fallback → "login error: aborted".)
      const apiTokenUrl = `${this.platformUrl}/id/api/auth/api-token/`;
      try {
        const apiResp = await fetch(apiTokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ ttl_days: 365, label: `agent-${this.agentUsername}-mcp`, organization_id: 1 }),
          signal: AbortSignal.timeout(5000),
        });
        if (apiResp.ok) {
          const apiData = await apiResp.json() as {
            access: string; refresh: string;
            user: { id: number; email: string };
            expires_in_days: number;
          };
          const expiry = this.decodeTokenExpiry(apiData.access);
          console.log(`[${this.agentUsername}] Authenticated via shizuha-id (API token: ${apiData.expires_in_days}d, expires ${expiry})`);
          return {
            accessToken: apiData.access,
            refreshToken: apiData.refresh,
            expiresAt: expiry,
            userId: apiData.user.id,
            email: apiData.user.email,
            organizationId: 1,
            obtainedAt: new Date().toISOString(),
          };
        }
      } catch (e) {
        console.warn(`[${this.agentUsername}] api-token upgrade failed (${(e as Error).message}) — using login token`);
      }
      const expiry = this.decodeTokenExpiry(accessToken);
      const decoded = this.decodeTokenPayload(accessToken) ?? {};
      console.log(`[${this.agentUsername}] Authenticated via shizuha-id (login token, expires ${expiry})`);
      return {
        accessToken,
        refreshToken,
        expiresAt: expiry,
        userId: decoded['user_id'] ?? loginData.user?.id ?? 0,
        email: decoded['email'] ?? loginData.user?.email ?? this.agentEmail,
        organizationId: decoded['organization_id'] ?? 1,
        obtainedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[${this.agentUsername}] shizuha-id login error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Reset this agent's shizuha-id password back to `password` using the
   * daemon's admin token. Only possible when DAEMON_ADMIN_TOKEN + AGENT_USER_ID
   * are present in the environment (injected by the daemon at container spawn).
   * Returns true if the reset succeeded. Best-effort; never throws.
   */
  private async resyncPassword(password: string): Promise<boolean> {
    const adminToken = process.env['DAEMON_ADMIN_TOKEN'] || '';
    const userId = process.env['AGENT_USER_ID'] || '';
    if (!adminToken || !userId) return false;
    try {
      const url = `${this.platformUrl}/id/api/auth/admin/users/${userId}/set-password/`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        // PLAT-556/558: the drift self-heal resets the account back to the
        // canonical container credential — a legitimate single-write, so it opts
        // into the agent-account set-password guard (a human sweep without the
        // flag is refused).
        body: JSON.stringify({ password, agent_provisioning: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        console.warn(`[${this.agentUsername}] password resync failed: ${resp.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[${this.agentUsername}] password resync error: ${(err as Error).message}`);
      return false;
    }
  }

  private decodeTokenPayload(token: string): Record<string, any> | null {
    try {
      const parts = token.split('.');
      if (parts.length >= 2) {
        let payload = parts[1]!;
        payload += '='.repeat((4 - payload.length % 4) % 4);
        return JSON.parse(Buffer.from(payload, 'base64url').toString());
      }
    } catch { /* ignore */ }
    return null;
  }

  private decodeTokenExpiry(token: string): string {
    const decoded = this.decodeTokenPayload(token);
    if (decoded?.['exp']) return new Date(decoded['exp'] * 1000).toISOString();
    return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }
}
