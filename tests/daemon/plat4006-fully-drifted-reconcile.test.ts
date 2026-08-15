import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentAccount } from '../../src/daemon/agent-accounts.js';

// PLAT-4006: before this fix, ensureAgentAccount only reconciled a drifted
// canonical password when a cached-token OR legacy-password login still worked.
// A FULLY-drifted account (canonical login fails, no valid cached token, legacy
// login fails) fell straight through to the non-canonical fast paths, which
// cannot fix drift, so the account stayed drifted and the agent thrashed (the
// docker-held agents ichi/san/kai/ni post-restart). The fix reconciles
// UNCONDITIONALLY in that case using the persisted cred-file userId.

function jwt(expSecondsFromNow: number, userId = 42): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';
const CANON = 'canonical-secret-pw';

describe('PLAT-4006: fully-drifted agent account self-heals via unconditional reconcile', () => {
  let originalHome: string | undefined;
  let originalFleetTok: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    originalFleetTok = process.env['FLEET_PROVISIONER_TOKEN'];
    delete process.env['FLEET_PROVISIONER_TOKEN']; // force the operator-admin set_password path
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat4006-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha', 'agent-auth'), { recursive: true });
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    if (originalFleetTok === undefined) delete process.env['FLEET_PROVISIONER_TOKEN'];
    else process.env['FLEET_PROVISIONER_TOKEN'] = originalFleetTok;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('reconciles a fully-drifted account (canonical+cached+legacy all fail) instead of falling through', async () => {
    // Persisted cred file: a userId (survives token expiry) + an EXPIRED token
    // + a WRONG legacy password → the account is fully drifted from the secret.
    fs.writeFileSync(
      path.join(tempHome, '.shizuha', 'agent-auth', 'driftbot.json'),
      JSON.stringify({
        userId: 42,
        email: 'driftbot@agents.shizuha.io',
        password: 'stale-wrong-legacy',
        accessToken: jwt(-3600, 42),
        tokenExpiresAt: Date.now() - 3600_000,
      }),
    );

    let setPwCalls = 0;
    let setPwUserId = 0;
    let setPwDone = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: any) => {
      const u = String(url);
      if (u.endsWith('/id/api/auth/login/')) {
        const body = JSON.parse((init?.body as string) ?? '{}');
        // Only the CANONICAL password authenticates, and only AFTER it is set.
        if (setPwDone && body.password === CANON) {
          return { ok: true, status: 200, json: async () => ({ tokens: { access: jwt(7200, 42), refresh: jwt(86400, 42) }, user: { id: 42 } }) } as any;
        }
        return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
      }
      if (u.includes('/set-password/')) {
        setPwCalls++;
        setPwUserId = Number(u.match(/users\/(\d+)\/set-password/)?.[1] ?? 0);
        setPwDone = true;
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }
      if (u.includes('/approve/')) {
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'driftbot',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 999),
      canonicalPassword: CANON,
    });

    // The unconditional reconcile fired: admin set-password on the cred-file
    // userId, then a fresh canonical login → account healed to login=200.
    expect(setPwCalls).toBeGreaterThanOrEqual(1);
    expect(setPwUserId).toBe(42);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(42);
  });
});
