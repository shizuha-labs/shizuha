import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentAccount, hasFleetProvisionerToken } from '../../src/daemon/agent-accounts.js';

// PLAT-3997: the fleet daemon writes/rotates AGENT_PASSWORD into <agent>-agent-creds
// but the account's shizuha-id password can drift from it (the secret was
// (re)generated without the account being updated). The injected password then
// fails `POST /id/api/auth/login/` (Invalid credentials) -> agent SSO breaks.
//
// The durable fix has two halves proved here:
//  (1) hasFleetProvisionerToken() exposes whether the static fleet-provisioner
//      reconcile path is available -- the daemon uses it to keep reconciling even
//      when the admin JWT family is dead (manager.ts skip gate), so the secret's
//      password is always synced onto the account.
//  (2) ensureAgentAccount self-heals a detected drift: when the injected
//      canonical password fails login, it reconciles the account to that exact
//      value (via the scoped fleet endpoint) and returns a fresh 200 login -- no
//      manual `set_password` needed.

let _jti = 0;
function jwt(expSecondsFromNow: number, userId = 42): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId, jti: ++_jti }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';
const AGENT_FRESH = jwt(7200, 42);

describe('PLAT-3997: account<->secret AGENT_PASSWORD drift self-heals', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat3997-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha', 'agent-auth'), { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe('hasFleetProvisionerToken()', () => {
    it('is true when FLEET_PROVISIONER_TOKEN is a non-empty (trimmed) value', () => {
      process.env['FLEET_PROVISIONER_TOKEN'] = '  secret-fleet-token  ';
      expect(hasFleetProvisionerToken()).toBe(true);
    });

    it('is false when the token is absent or blank', () => {
      delete process.env['FLEET_PROVISIONER_TOKEN'];
      expect(hasFleetProvisionerToken()).toBe(false);
      process.env['FLEET_PROVISIONER_TOKEN'] = '   ';
      expect(hasFleetProvisionerToken()).toBe(false);
    });
  });

  it('detects drift (injected password fails login) and reconciles the account to the injected value -> login 200', async () => {
    // Simulate the exact incident: the k8s Secret carries `canon-pw`, but the
    // shizuha-id account still has an OLD password, so the first (canonical)
    // login 401s. The fleet-provisioner reconcile then sets the account to
    // `canon-pw`; the post-reconcile login succeeds with a fresh token.
    process.env['FLEET_PROVISIONER_TOKEN'] = 'secret-fleet-token';
    let fleetReconcileCalls = 0;
    let fleetReconciledPassword = '';
    let loginCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: any) => {
      const u = String(url);
      if (u.includes('/id/api/internal/fleet/provision-agent/')) {
        fleetReconcileCalls++;
        fleetReconciledPassword = (JSON.parse(init?.body ?? '{}') as Record<string, unknown>)['password'] as string;
        return { ok: true, status: 200, json: async () => ({ user_id: 42, action: 'reconnected' }) } as any;
      }
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        // 1st login = canonical probe with the injected (drifted) secret -> 401.
        if (loginCalls === 1) return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
        // Post-reconcile login -> 200 with a fresh token (self-healed).
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      agentEmail: 'nova@shizuha.com',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canon-pw',
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(AGENT_FRESH);       // agent ends with a valid session
    expect(fleetReconcileCalls).toBe(1);                 // drift triggered exactly one reconcile
    expect(fleetReconciledPassword).toBe('canon-pw');    // account reconciled to the INJECTED secret value
    expect(loginCalls).toBe(2);                          // canonical probe (401) + post-reconcile login (200)
  });

  it('no drift: injected password already authenticates -> no reconcile, no set-password', async () => {
    process.env['FLEET_PROVISIONER_TOKEN'] = 'secret-fleet-token';
    let fleetReconcileCalls = 0, setPwCalls = 0, loginCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/id/api/internal/fleet/provision-agent/')) { fleetReconcileCalls++; return { ok: true, status: 200, json: async () => ({ user_id: 42, action: 'reconnected' }) } as any; }
      if (u.includes('/set-password/')) { setPwCalls++; return { ok: true, json: async () => ({}) } as any; }
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      agentEmail: 'nova@shizuha.com',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canon-pw',
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(AGENT_FRESH);
    expect(loginCalls).toBe(1);          // canonical login succeeded first try
    expect(fleetReconcileCalls).toBe(0); // no drift -> no reconcile
    expect(setPwCalls).toBe(0);
  });
});
