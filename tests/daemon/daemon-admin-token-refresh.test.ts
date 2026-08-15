import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshDaemonAdminToken } from '../../src/daemon/agent-accounts.js';

// PLAT-881: the daemon must refresh its OWN provisioning admin token (the owner
// account in ~/.shizuha/auth.json) before it ages out, persisting the new token
// back so the next spawn re-reads it. Previously it read auth.accessToken
// verbatim with no expiry check → it silently aged out and provisioning 401'd.

// Minimal unsigned JWT with a controllable exp (seconds) + user_id; this is all
// decodeJwtExpiry / decodeUserIdFromJwt parse (payload only, no signature check).
function jwt(expSecondsFromNow: number, userId = 7): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

describe('refreshDaemonAdminToken (PLAT-881)', () => {
  let originalHome: string | undefined;
  let tempHome: string;
  let authFile: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-daemon-admin-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha'), { recursive: true });
    authFile = path.join(tempHome, '.shizuha', 'auth.json');
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('returns the existing token unchanged when it is still fresh (no refresh call)', async () => {
    const fresh = jwt(3600);
    fs.writeFileSync(authFile, JSON.stringify({ accessToken: fresh, refreshToken: 'r1', userId: 7 }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const token = await refreshDaemonAdminToken({ platformUrl: 'https://id.example' });
    expect(token).toBe(fresh);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the new one, preserving other fields', async () => {
    const expired = jwt(-3600);
    const renewed = jwt(3600, 7);
    fs.writeFileSync(authFile, JSON.stringify({
      accessToken: expired, refreshToken: 'r1', userId: 7, username: 'ownerco',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access: renewed, refresh: 'r2' }),
    })));

    const token = await refreshDaemonAdminToken({ platformUrl: 'https://id.example/' });
    expect(token).toBe(renewed);

    const persisted = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    expect(persisted.accessToken).toBe(renewed);
    expect(persisted.refreshToken).toBe('r2');     // rotated refresh persisted
    expect(persisted.username).toBe('ownerco');    // unrelated fields preserved
    expect(typeof persisted.tokenExpiresAt).toBe('string');
  });

  it('fails loud (null) when refresh is REJECTED 401 — whole token family dead (SCLI-205)', async () => {
    const expired = jwt(-3600);
    fs.writeFileSync(authFile, JSON.stringify({ accessToken: expired, refreshToken: 'r1' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));

    const token = await refreshDaemonAdminToken({ platformUrl: 'https://id.example' });
    // SCLI-205: a 401 means the refresh token itself is revoked/blacklisted (not a
    // transient blip) — the admin token family is dead and refresh cannot recover
    // it. Return null + mark it dead (stop-batch) rather than hand back the dead
    // access token and loop "using existing token (best-effort)" forever.
    expect(token).toBeNull();
  });

  it('keeps the existing token (best-effort) on a TRANSIENT refresh failure (5xx id blip)', async () => {
    const expired = jwt(-3600);
    fs.writeFileSync(authFile, JSON.stringify({ accessToken: expired, refreshToken: 'r1' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));

    const token = await refreshDaemonAdminToken({ platformUrl: 'https://id.example' });
    expect(token).toBe(expired); // never hard-fails provisioning on a transient id blip
  });

  it('returns null when auth.json does not exist', async () => {
    const token = await refreshDaemonAdminToken({ platformUrl: 'https://id.example' });
    expect(token).toBeNull();
  });
});
