import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentAccount } from '../../src/daemon/agent-accounts.js';

// SCLI-205 (A′): when FLEET_PROVISIONER_TOKEN is mounted, the daemon provisions
// agents via the scoped static-token endpoint
// (/id/api/internal/fleet/provision-agent/, X-Fleet-Provisioner-Token) — NOT the
// operator's (hritik) superuser token (admin set-password / internal-agents).
// This decouples provisioning from the operator's session (the root cause) and,
// being a static token, is immune to the refresh-rotation race.

let _jti = 0;
function jwt(expSecondsFromNow: number, userId = 42): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId, jti: ++_jti }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';
const AGENT_FRESH = jwt(7200, 42);

describe('SCLI-205 A′: provisioning routes through the scoped fleet endpoint when its token is mounted', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli205a-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha', 'agent-auth'), { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('uses the fleet endpoint with X-Fleet-Provisioner-Token, not the operator admin path', async () => {
    process.env['FLEET_PROVISIONER_TOKEN'] = 'secret-fleet-token';
    let fleetCalls = 0, adminSetPwCalls = 0, internalAgentsCalls = 0, loginCalls = 0;
    let fleetTokenHeader = '';
    let fleetBody: Record<string, unknown> = {};

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: any) => {
      const u = String(url);
      if (u.includes('/id/api/internal/fleet/provision-agent/')) {
        fleetCalls++;
        fleetTokenHeader = init?.headers?.['X-Fleet-Provisioner-Token'] ?? '';
        fleetBody = JSON.parse(init?.body ?? '{}');
        return { ok: true, status: 201, json: async () => ({ user_id: 42, action: 'created', username: 'nova' }) } as any;
      }
      if (u.includes('/set-password/')) { adminSetPwCalls++; return { ok: true, json: async () => ({}) } as any; }
      if (u.includes('/id/api/internal/agents/')) { internalAgentsCalls++; return { ok: true, json: async () => ({ user_id: 42, action: 'created' }) } as any; }
      if (u.includes('/approve/')) return { ok: true, json: async () => ({}) } as any;
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        if (loginCalls === 1) return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any; // canonical probe
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      agentEmail: 'nova@shizuha.com',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3), // hritik superuser token — must NOT be used
      canonicalPassword: 'canon-pw',
    });

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(AGENT_FRESH);
    expect(fleetCalls).toBe(1);
    expect(fleetTokenHeader).toBe('secret-fleet-token');
    expect(fleetBody['username']).toBe('nova');
    expect(fleetBody['email']).toBe('nova@shizuha.com');
    expect(fleetBody['password']).toBe('canon-pw');
    // The operator-superuser provisioning endpoints were NOT touched.
    expect(adminSetPwCalls).toBe(0);
    expect(internalAgentsCalls).toBe(0);
  });

  it('falls back to the legacy admin path when the fleet token is NOT mounted', async () => {
    delete process.env['FLEET_PROVISIONER_TOKEN'];
    let fleetCalls = 0, internalAgentsCalls = 0, loginCalls = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/id/api/internal/fleet/provision-agent/')) { fleetCalls++; return { ok: true, status: 201, json: async () => ({ user_id: 42, action: 'created' }) } as any; }
      if (u.includes('/id/api/internal/agents/')) { internalAgentsCalls++; return { ok: true, json: async () => ({ user_id: 42, action: 'created' }) } as any; }
      if (u.includes('/approve/')) return { ok: true, json: async () => ({}) } as any;
      if (u.includes('/set-password/')) return { ok: true, json: async () => ({}) } as any;
      if (u.includes('/id/api/auth/login/')) {
        loginCalls++;
        // PLAT-4573: legacy provisioning is permitted only after the exact
        // Shizuha-ID credential-mismatch contract, never a generic 401.
        if (loginCalls === 1) return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
        return { ok: true, json: async () => ({ user: { id: 42 }, tokens: { access: AGENT_FRESH, refresh: 'r42' } }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'nova',
      agentEmail: 'nova@agents.shizuha.io',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canon-pw',
    });

    expect(result).not.toBeNull();
    expect(fleetCalls).toBe(0);                            // scoped endpoint NOT used without the token
    expect(internalAgentsCalls).toBeGreaterThanOrEqual(1); // legacy admin register path used
  });
});
