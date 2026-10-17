import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalAgentEmail, ensureAgentAccount } from '../../src/daemon/agent-accounts.js';

// PLAT-8992 — daemon provisioning durable legs, live again 2026-10-14:
//   shizuha seat hit `reconcile-failed` (`admin_set_password_or_login_failed`,
//   no AGENT_ACCESS_TOKEN) at 13:51 IST, and zen has a deterministic 401 from
//   seat-credential drift (PLAT-11800). Every new drift turns into a per-seat
//   operator re-mint ticket; fixing Defects A and B in the daemon ends that.
//
// Defect A proved here: a truthy but non-allowlisted email in drifted daemon
// state (`zen@seat-local`) is sent VERBATIM to `POST /id/api/internal/fleet/
// provision-agent/` and 403s there on EVERY reconcile cycle, forever. The fix
// substitutes the canonical `${username}@agents.shizuha.io` email instead of
// weakening the id-side allowlist (deliberate human-safety invariant).
//
// Defect B minimum proved here: after a successful drift reconciliation, the
// daemon-internal scoped-grant password (#2 in agents.json SSOT — the surface
// k8s injects from) is backfilled to the reconciled value. Without this, a
// reconciliation can succeed while #2 stays stale, so the next pod restart
// re-ships the stale AGENT_PASSWORD and the drift loop reopens. Fail-closed:
// a failed backfill returns null (PLAT-558 single-write).

let _jti = 0;
function jwt(expSecondsFromNow: number, userId = 42): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId, jti: ++_jti }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';
const AGENT_FRESH = jwt(7200, 42);

describe('PLAT-8992: provisioning email allowlist + scoped-grant backfill', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat8999-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha', 'agent-auth'), { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe('canonicalAgentEmail (Defect A)', () => {
    it('substitutes the canonical container-domain email for a non-allowlisted truthy email', () => {
      expect(canonicalAgentEmail('zen', 'zen@seat-local')).toBe('zen@agents.shizuha.io');
      expect(canonicalAgentEmail('zen', 'zen@local')).toBe('zen@agents.shizuha.io');
    });

    it('keeps a verbatim allowlisted email (the verified-live 200 payload shape)', () => {
      expect(canonicalAgentEmail('zen', 'zen@shizuha.com')).toBe('zen@shizuha.com');
      expect(canonicalAgentEmail('zen', 'zen@agents.shizuha.io')).toBe('zen@agents.shizuha.io');
    });

    it('trims and lowercases; blank/absent email falls back to the canonical substitution', () => {
      expect(canonicalAgentEmail('Zen', '  zen@shizuha.com  ')).toBe('zen@shizuha.com');
      expect(canonicalAgentEmail('Zen', '   ')).toBe('zen@agents.shizuha.io');
      expect(canonicalAgentEmail('Zen')).toBe('zen@agents.shizuha.io');
    });

    it('never weakens the allowlist: unknown TLDs fall back instead of passing through', () => {
      expect(canonicalAgentEmail('zen', 'zen@gmail.com')).toBe('zen@agents.shizuha.io');
      expect(canonicalAgentEmail('zen', 'zen@shizuha.evil.com')).toBe('zen@agents.shizuha.io');
    });
  });

  it('drift reconciliation: exactly one fleet reconcile, backfill (#2) runs with the reconciled value, login 200', async () => {
    process.env['FLEET_PROVISIONER_TOKEN'] = 'secret-fleet-token';
    const persistCalls: string[] = [];
    let fleetReconcileCalls = 0;
    let fleetReconciledEmail = '';
    let fleetReconciledPassword = '';
    let loginCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: any) => {
      const u = String(url);
      if (u.includes('/id/api/internal/fleet/provision-agent/')) {
        fleetReconcileCalls++;
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        fleetReconciledEmail = body['email'] as string;
        fleetReconciledPassword = body['password'] as string;
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
      agentEmail: 'nova@seat-local', // drifted daemon state — must never pass verbatim
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canon-pw',
      persistCanonicalPassword: async (password: string) => {
        persistCalls.push(password);
        return () => {
          persistCalls.pop();
        };
      },
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(AGENT_FRESH);            // agent ends with a valid session
    expect(fleetReconcileCalls).toBe(1);                      // drift triggered exactly one reconcile
    expect(fleetReconciledEmail).toBe('nova@agents.shizuha.io'); // drifted state never passes verbatim
    expect(fleetReconciledPassword).toBe('canon-pw');         // account reconciled to the injected secret value
    expect(persistCalls).toEqual(['canon-pw']);               // backfill (#2) ran with the reconciled value
  });

  it('fails closed without provisioning when the scoped-grant backfill fails', async () => {
    process.env['FLEET_PROVISIONER_TOKEN'] = 'secret-fleet-token';
    let loginCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: any) => {
      const u = String(url);
      if (u.includes('/id/api/internal/fleet/provision-agent/')) {
        return { ok: true, status: 200, json: async () => ({ user_id: 42, action: 'reconnected' }) } as any;
      }
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        if (loginCalls === 1) return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      agentEmail: 'nova@seat-local',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canon-pw',
      persistCanonicalPassword: async () => {
        throw new Error('ssot write failed');
      },
    });

    expect(result).toBeNull();
  });
});
