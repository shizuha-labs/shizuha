import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentAccount } from '../../src/daemon/agent-accounts.js';

// SCLI-202: the rt-fleet provisioner reuses ONE admin token across every agent's
// approve + set-password. set-password invalidates access tokens, so during a
// full-fleet re-provision the daemon's own admin ACCESS token gets revoked
// partway through and every REMAINING approve/set-password 401s with "User
// access token revoked" → those agents' passwords never reconcile → they can't
// log in → the broker can't mint Connect tokens → id-login storm. The fix:
// re-mint the admin token via the surviving refresh token and retry once, and
// always hand out a login token minted AFTER set-password.

let _jti = 0;
function jwt(expSecondsFromNow: number, userId = 7): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId, jti: ++_jti }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';
const STALE_ADMIN = jwt(3600, 999);      // parses as unexpired but is revoked server-side
const REMINTED_ADMIN = jwt(3600, 999);   // fresh admin token from the refresh flow (distinct token)
const AGENT_FRESH = jwt(7200, 42);       // the agent's post-set-password login token
const PRE_SETPW = jwt(7200, 42);         // a stale pre-set-password agent token (must NOT be handed out)

describe('SCLI-202: provisioner self-heals a revoked admin token + hands out a post-set-password login', () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli202-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha', 'agent-auth'), { recursive: true });
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('re-mints the admin token on a revoked set-password and retries with the fresh token', async () => {
    let setPwCalls = 0;
    let loginCalls = 0;
    const setPwAuthHeaders: string[] = [];
    let reminted = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: any) => {
      const u = String(url);
      const auth = init?.headers?.['Authorization'] as string | undefined;
      if (u.includes('/id/api/internal/agents/')) {
        return { ok: true, json: async () => ({ user_id: 42, action: 'created' }) } as any;
      }
      if (u.includes('/approve/')) {
        return { ok: true, json: async () => ({}) } as any;
      }
      if (u.includes('/set-password/')) {
        setPwCalls++;
        setPwAuthHeaders.push(auth ?? '');
        if (setPwCalls === 1) {
          // Admin access token revoked mid-fleet.
          return { ok: false, status: 401, json: async () => ({ error: 'User access token revoked' }) } as any;
        }
        return { ok: true, json: async () => ({}) } as any;
      }
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        // 1st login is the canonical-credential probe → fail so we reach first-time provision.
        if (loginCalls === 1) {
          return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
        }
        // Login AFTER set-password → the fresh, valid token.
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      platformUrl: PLATFORM,
      adminToken: STALE_ADMIN,
      canonicalPassword: 'canon-pw',
      remintAdminToken: async () => { reminted = true; return REMINTED_ADMIN; },
    });

    expect(result).not.toBeNull();
    // Handed out the post-set-password login token, never a pre-set-password one.
    expect(result!.accessToken).toBe(AGENT_FRESH);
    expect(result!.accessToken).not.toBe(PRE_SETPW);
    expect(result!.userId).toBe(42);
    // set-password was retried once, and the retry carried the RE-MINTED admin token.
    expect(reminted).toBe(true);
    expect(setPwCalls).toBe(2);
    expect(setPwAuthHeaders[0]).toBe(`Bearer ${STALE_ADMIN}`);
    expect(setPwAuthHeaders[1]).toBe(`Bearer ${REMINTED_ADMIN}`);
  });

  it('does not infinite-loop when the admin token cannot be re-minted (fails cleanly)', async () => {
    let setPwCalls = 0;
    let loginCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/id/api/internal/agents/')) {
        return { ok: true, json: async () => ({ user_id: 42, action: 'created' }) } as any;
      }
      if (u.includes('/approve/')) return { ok: true, json: async () => ({}) } as any;
      if (u.includes('/set-password/')) {
        setPwCalls++;
        return { ok: false, status: 401, json: async () => ({ error: 'User access token revoked' }) } as any;
      }
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      platformUrl: PLATFORM,
      adminToken: STALE_ADMIN,
      canonicalPassword: 'canon-pw',
      remintAdminToken: async () => null, // cannot re-mint (refresh token also gone)
    });

    expect(result).toBeNull();
    // set-password attempted once; remint returned null so it did NOT retry.
    expect(setPwCalls).toBe(1);
  });

  it('reconcile path returns a login token minted AFTER set-password (never the cached one)', async () => {
    // Seed a stored cred file with a still-valid (but soon-to-be-revoked) token so
    // ensureAgentAccount takes the reconcile branch.
    fs.writeFileSync(
      path.join(tempHome, '.shizuha', 'agent-auth', 'nova.json'),
      JSON.stringify({
        username: 'nova', email: 'nova@agents.shizuha.io', password: 'old-pw',
        userId: 42, accessToken: PRE_SETPW, refreshToken: 'stale-r',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        createdAt: new Date().toISOString(),
      }),
    );
    let loginCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/set-password/')) return { ok: true, json: async () => ({}) } as any;
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        // 1st = canonical probe (fails → reconcile); 2nd = post-set-password login (fresh).
        if (loginCalls === 1) return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      platformUrl: PLATFORM,
      adminToken: STALE_ADMIN,
      canonicalPassword: 'canon-pw',
      remintAdminToken: async () => REMINTED_ADMIN,
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(AGENT_FRESH);   // post-set-password
    expect(result!.accessToken).not.toBe(PRE_SETPW); // never the stale cached token
  });
});
