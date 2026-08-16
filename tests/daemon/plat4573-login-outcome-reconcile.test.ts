import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeAgentLoginBackoffMs,
  ensureAgentAccount,
} from '../../src/daemon/agent-accounts.js';

function jwt(expSecondsFromNow: number, userId = 42): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    user_id: userId,
  })).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';

function response(status: number, body: unknown, contentLength?: number): any {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-length'
        ? String(contentLength ?? Buffer.byteLength(payload))
        : null,
    },
    text: async () => payload,
    json: async () => JSON.parse(payload),
  };
}

describe('PLAT-4573: login outcome gates privileged credential reconciliation', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempHome: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat4573-'));
    process.env['HOME'] = tempHome;
    process.env['FLEET_PROVISIONER_TOKEN'] = 'fleet-token';
    fs.mkdirSync(path.join(tempHome, '.shizuha', 'agent-auth'), { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails closed on transport timeout and suppresses an immediate herd retry', async () => {
    let loginCalls = 0;
    let provisionCalls = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        loginCalls++;
        throw new Error('The operation was aborted due to timeout');
      }
      if (value.includes('/id/api/internal/fleet/provision-agent/')) provisionCalls++;
      return { ok: false, status: 500, json: async () => ({}) } as any;
    }));

    const opts = {
      agentUsername: 'plat4573-timeout',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    };
    await expect(ensureAgentAccount(opts)).resolves.toBeNull();
    await expect(ensureAgentAccount(opts)).resolves.toBeNull();

    expect(loginCalls).toBe(1);
    expect(provisionCalls).toBe(0);
  });

  it.each([429, 500, 503])('never reconciles credentials after indeterminate HTTP %s', async (status) => {
    let provisionCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        return { ok: false, status, json: async () => ({ detail: 'transient' }) } as any;
      }
      if (value.includes('/id/api/internal/fleet/provision-agent/')) provisionCalls++;
      return { ok: false, status: 500, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: `plat4573-http-${status}`,
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    });

    expect(result).toBeNull();
    expect(provisionCalls).toBe(0);
  });

  it('still reconciles after the exact 401 Invalid credentials contract', async () => {
    let loginCalls = 0;
    let provisionCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        loginCalls++;
        if (loginCalls === 1) {
          return { ok: false, status: 401, json: async () => ({ error: 'Invalid credentials' }) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { id: 42 },
            tokens: { access: jwt(7200, 42), refresh: 'refresh-42' },
          }),
        } as any;
      }
      if (value.includes('/id/api/internal/fleet/provision-agent/')) {
        provisionCalls++;
        return { ok: true, status: 200, json: async () => ({ user_id: 42, action: 'reconnected' }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'plat4573-rejected',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    });

    expect(result?.userId).toBe(42);
    expect(provisionCalls).toBe(1);
    expect(loginCalls).toBe(2);
  });

  it('does not mutate credentials for a disabled account', async () => {
    let privilegedMutations = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        return response(401, { error: 'Account is disabled' });
      }
      if (value.includes('/provision-agent/') || value.includes('/set-password/')) privilegedMutations++;
      return response(500, {});
    }));

    await expect(ensureAgentAccount({
      agentUsername: 'plat4573-disabled',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    })).resolves.toBeNull();

    expect(privilegedMutations).toBe(0);
  });

  it.each([
    ['pending approval', 'pending_approval'],
    ['approval denied', 'approval_denied'],
    ['2FA enrollment required', '2fa_enrollment_required'],
  ])('does not mutate credentials for 403 %s', async (_label, code) => {
    let privilegedMutations = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        return response(403, { code, error: 'policy state' });
      }
      if (value.includes('/provision-agent/') || value.includes('/set-password/')) privilegedMutations++;
      return response(500, {});
    }));

    await expect(ensureAgentAccount({
      agentUsername: `plat4573-403-${code}`,
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    })).resolves.toBeNull();

    expect(privilegedMutations).toBe(0);
  });

  it.each([
    ['unknown 401', 401, JSON.stringify({ error: 'Unrecognized auth state' }), undefined],
    ['unknown 403', 403, JSON.stringify({ code: 'future_policy_state' }), undefined],
    ['malformed 401', 401, '{not-json', undefined],
    ['malformed 403', 403, '<html>nope</html>', undefined],
    ['oversized 401', 401, JSON.stringify({ error: 'x'.repeat(5_000) }), 5_100],
    ['oversized 403', 403, JSON.stringify({ code: 'x'.repeat(5_000) }), 5_100],
  ])('fails closed for %s contract response', async (_label, status, body, contentLength) => {
    let loginCalls = 0;
    let privilegedMutations = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        loginCalls++;
        return response(status, body, contentLength);
      }
      if (value.includes('/provision-agent/') || value.includes('/set-password/')) privilegedMutations++;
      return response(500, {});
    }));

    const opts = {
      agentUsername: `plat4573-contract-${String(_label).replaceAll(' ', '-')}`,
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    };
    await expect(ensureAgentAccount(opts)).resolves.toBeNull();
    await expect(ensureAgentAccount(opts)).resolves.toBeNull();

    expect(loginCalls).toBe(1);
    expect(privilegedMutations).toBe(0);
  });

  it('fails closed without mutation for an invalid 2xx success payload', async () => {
    let loginCalls = 0;
    let privilegedMutations = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        loginCalls++;
        return response(200, { user: { id: 42 }, tokens: { access: 'missing-refresh' } });
      }
      if (value.includes('/provision-agent/') || value.includes('/set-password/')) privilegedMutations++;
      return response(500, {});
    }));

    const opts = {
      agentUsername: 'plat4573-invalid-success',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    };
    await expect(ensureAgentAccount(opts)).resolves.toBeNull();
    await expect(ensureAgentAccount(opts)).resolves.toBeNull();

    expect(loginCalls).toBe(1);
    expect(privilegedMutations).toBe(0);
  });

  it('keeps successful canonical login unchanged', async () => {
    let provisionCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/id/api/auth/login/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { id: 42 },
            tokens: { access: jwt(7200, 42), refresh: 'refresh-42' },
          }),
        } as any;
      }
      if (value.includes('/id/api/internal/fleet/provision-agent/')) provisionCalls++;
      return { ok: false, status: 500, json: async () => ({}) } as any;
    }));

    const result = await ensureAgentAccount({
      agentUsername: 'plat4573-success',
      platformUrl: PLATFORM,
      adminToken: jwt(3600, 3),
      canonicalPassword: 'canonical-password',
    });

    expect(result?.userId).toBe(42);
    expect(provisionCalls).toBe(0);
  });

  it('bounds exponential retry delay and applies deterministic jitter', () => {
    expect(computeAgentLoginBackoffMs(1, () => 0)).toBe(1_000);
    expect(computeAgentLoginBackoffMs(1, () => 1)).toBe(2_000);
    expect(computeAgentLoginBackoffMs(3, () => 0.5)).toBe(6_000);
    expect(computeAgentLoginBackoffMs(99, () => 1)).toBe(30_000);
  });
});
