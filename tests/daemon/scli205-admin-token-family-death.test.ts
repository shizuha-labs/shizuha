import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshDaemonAdminToken, isDaemonAdminFamilyDead } from '../../src/daemon/agent-accounts.js';

// SCLI-205: when a full-fleet re-provision revokes the daemon admin's WHOLE token
// family (access + refresh), a refresh cannot recover it. SCLI-202 assumed the
// refresh token survived and, on a rejected refresh, returned the DEAD access
// token ("using existing token (best-effort)") — so set-password 401'd forever,
// storming shizuha-id and feeding the per-IP lockout (SCLI-204). The fix: FAIL
// LOUD — return null + mark the family dead (stop-batch) — while still using a
// concurrently-persisted fresh token (rotation race) and keeping the best-effort
// stale token only on a TRANSIENT (5xx/network) failure.

let _jti = 0;
function jwt(expSecondsFromNow: number, userId = 3): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, user_id: userId, jti: ++_jti }),
  ).toString('base64url');
  return `h.${payload}.s`;
}

const PLATFORM = 'http://id.example';
const futureIso = () => new Date(Date.now() + 3600_000).toISOString();

describe('SCLI-205: daemon admin token FAMILY death fails loud + stops batch', () => {
  let originalHome: string | undefined;
  let tempHome: string;
  let authFile: string;

  function writeAuth(accessToken: string, refreshToken: string) {
    fs.writeFileSync(authFile, JSON.stringify({
      username: 'hritik', userId: 3, accessToken, refreshToken, tokenExpiresAt: futureIso(),
    }, null, 2));
  }

  beforeEach(async () => {
    originalHome = process.env['HOME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli205-'));
    process.env['HOME'] = tempHome;
    fs.mkdirSync(path.join(tempHome, '.shizuha'), { recursive: true });
    authFile = path.join(tempHome, '.shizuha', 'auth.json');
    // Reset the module-level dead flag: a non-force call over a fresh unexpired
    // token returns early (no fetch) and clears it → clean slate per test.
    writeAuth(jwt(3600), 'r-live');
    await refreshDaemonAdminToken({ platformUrl: PLATFORM });
    expect(isDaemonAdminFamilyDead()).toBe(false);
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('returns null + marks family dead when the refresh token is ALSO revoked (401) — no dead-token fallback', async () => {
    writeAuth(jwt(3600), 'r-revoked'); // access parses unexpired but is revoked server-side
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).includes('/id/api/auth/refresh/')
        ? { ok: false, status: 401, json: async () => ({ detail: 'Token is blacklisted' }) } as any
        : { ok: false, status: 404, json: async () => ({}) } as any));

    const token = await refreshDaemonAdminToken({ platformUrl: PLATFORM, force: true });
    expect(token).toBeNull();                     // NOT the dead access token
    expect(isDaemonAdminFamilyDead()).toBe(true); // stop-batch signal set
  });

  it('uses a token a concurrent spawn just persisted when its own refresh 401s (rotation race)', async () => {
    const myRevoked = jwt(3600);
    writeAuth(myRevoked, 'r-mine-stale');
    const siblingFresh = jwt(3600);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).includes('/id/api/auth/refresh/')) {
        // A concurrent spawn won the rotation + persisted a fresh token to
        // auth.json before our (now-stale) refresh is rejected.
        writeAuth(siblingFresh, 'r-sibling');
        return { ok: false, status: 401, json: async () => ({ detail: 'Token is blacklisted' }) } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));

    const token = await refreshDaemonAdminToken({ platformUrl: PLATFORM, force: true });
    expect(token).toBe(siblingFresh);              // recovered via the raced-in token
    expect(isDaemonAdminFamilyDead()).toBe(false); // not dead
  });

  it('keeps the best-effort stale token on a TRANSIENT refresh failure (5xx) without marking dead', async () => {
    const stale = jwt(3600);
    writeAuth(stale, 'r-ok');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).includes('/id/api/auth/refresh/')
        ? { ok: false, status: 503, json: async () => ({}) } as any
        : { ok: false, status: 404, json: async () => ({}) } as any));

    const token = await refreshDaemonAdminToken({ platformUrl: PLATFORM, force: true });
    expect(token).toBe(stale);                     // best-effort keeps the token
    expect(isDaemonAdminFamilyDead()).toBe(false); // transient ≠ dead
  });

  it('clears the dead flag once a fresh admin credential is provisioned again (recovery — approach A)', async () => {
    writeAuth(jwt(3600), 'r-revoked');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).includes('/id/api/auth/refresh/')
        ? { ok: false, status: 401, json: async () => ({ detail: 'blacklisted' }) } as any
        : { ok: false, status: 404, json: async () => ({}) } as any));
    await refreshDaemonAdminToken({ platformUrl: PLATFORM, force: true });
    expect(isDaemonAdminFamilyDead()).toBe(true);

    // auth.json externally re-provisioned with a fresh credential; a normal
    // (non-force) call finds it fresh → returns it + clears the halt.
    const fresh = jwt(3600);
    writeAuth(fresh, 'r-new');
    const token = await refreshDaemonAdminToken({ platformUrl: PLATFORM });
    expect(token).toBe(fresh);
    expect(isDaemonAdminFamilyDead()).toBe(false);
  });
});
