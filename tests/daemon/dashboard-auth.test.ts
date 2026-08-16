import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('dashboard first-run auth hardening', () => {
  let originalHome: string | undefined;
  let originalDashboardPassword: string | undefined;
  let originalDashboardUsername: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    vi.resetModules();
    originalHome = process.env['HOME'];
    originalDashboardPassword = process.env['SHIZUHA_DASHBOARD_PASSWORD'];
    originalDashboardUsername = process.env['SHIZUHA_DASHBOARD_USERNAME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-dashboard-auth-'));
    process.env['HOME'] = tempHome;
    delete process.env['SHIZUHA_DASHBOARD_PASSWORD'];
    delete process.env['SHIZUHA_DASHBOARD_USERNAME'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalDashboardPassword === undefined) delete process.env['SHIZUHA_DASHBOARD_PASSWORD'];
    else process.env['SHIZUHA_DASHBOARD_PASSWORD'] = originalDashboardPassword;
    if (originalDashboardUsername === undefined) delete process.env['SHIZUHA_DASHBOARD_USERNAME'];
    else process.env['SHIZUHA_DASHBOARD_USERNAME'] = originalDashboardUsername;
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  function readStoredCredentials(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(tempHome, '.shizuha', 'dashboard.json'), 'utf8')) as Record<string, unknown>;
  }

  it('generates a random first-run setup password instead of accepting the historical default', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    const auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(true);
    const stored = readStoredCredentials();
    expect(stored.username).toBe('shizuha');
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.provisionedBy).toBe('generated');
    expect(stored.passwordHash).not.toBe('shizuha');
    expect(auth.isDefaultPassword()).toBe(true);
    expect(auth.login('shizuha', 'shizuha').ok).toBe(false);

    const generatedPassword = warnings.join('\n').match(/One-time setup password: ([^\n]+)/)?.[1]?.trim();
    expect(generatedPassword).toBeTruthy();
    expect(generatedPassword).not.toBe('shizuha');
    expect(auth.login('shizuha', generatedPassword!).ok).toBe(true);
  });

  it('uses SHIZUHA_DASHBOARD_PASSWORD when supplied and rejects too-short setup passwords', async () => {
    process.env['SHIZUHA_DASHBOARD_USERNAME'] = 'operator';
    process.env['SHIZUHA_DASHBOARD_PASSWORD'] = 'operator-secret-123';
    const auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(true);
    const stored = readStoredCredentials();
    expect(stored.username).toBe('operator');
    expect(stored.provisionedBy).toBe('env');
    expect(stored.mustChangePassword).toBe(false);
    expect(auth.getDashboardUsername()).toBe('operator');
    expect(auth.isDefaultPassword()).toBe(false);
    expect(auth.login('operator', 'operator-secret-123').ok).toBe(true);
    expect(auth.login('operator', 'shizuha').ok).toBe(false);

    fs.rmSync(path.join(tempHome, '.shizuha'), { recursive: true, force: true });
    process.env['SHIZUHA_DASHBOARD_PASSWORD'] = 'short';
    expect(() => auth.ensureDashboardCredentials()).toThrow(/SHIZUHA_DASHBOARD_PASSWORD must be at least 8 characters/);
  });

  it('rotates an unmodified legacy first-run default credential record', async () => {
    const salt = crypto.randomBytes(32).toString('hex');
    const authDir = path.join(tempHome, '.shizuha');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, 'dashboard.json'), JSON.stringify({
      username: 'shizuha',
      passwordHash: crypto.scryptSync('shizuha', salt, 64).toString('hex'),
      salt,
      createdAt: new Date().toISOString(),
    }));

    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(true);
    const stored = readStoredCredentials();
    expect(stored.provisionedBy).toBe('rotated-legacy-default');
    expect(stored.mustChangePassword).toBe(true);
    expect(auth.login('shizuha', 'shizuha').ok).toBe(false);

    const rotatedPassword = warnings.join('\n').match(/One-time setup password: ([^\n]+)/)?.[1]?.trim();
    expect(rotatedPassword).toBeTruthy();
    expect(auth.login('shizuha', rotatedPassword!).ok).toBe(true);
  });

  it('recovers generated temporary setup credentials with an explicit env password', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    let auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(true);
    const generatedPassword = warnings.join('\n').match(/One-time setup password: ([^\n]+)/)?.[1]?.trim();
    expect(generatedPassword).toBeTruthy();
    expect(auth.login('shizuha', generatedPassword!).ok).toBe(true);

    process.env['SHIZUHA_DASHBOARD_PASSWORD'] = 'operator-recovery-secret';
    vi.resetModules();
    auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(true);
    const stored = readStoredCredentials();
    expect(stored.username).toBe('shizuha');
    expect(stored.provisionedBy).toBe('env');
    expect(stored.mustChangePassword).toBe(false);
    expect(auth.isDefaultPassword()).toBe(false);
    expect(auth.login('shizuha', 'operator-recovery-secret').ok).toBe(true);
    expect(auth.login('shizuha', generatedPassword!).ok).toBe(false);
  });

  it('honors an explicit env password when rotating legacy default credentials', async () => {
    const salt = crypto.randomBytes(32).toString('hex');
    const authDir = path.join(tempHome, '.shizuha');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, 'dashboard.json'), JSON.stringify({
      username: 'shizuha',
      passwordHash: crypto.scryptSync('shizuha', salt, 64).toString('hex'),
      salt,
      createdAt: new Date().toISOString(),
    }));
    process.env['SHIZUHA_DASHBOARD_USERNAME'] = 'operator';
    process.env['SHIZUHA_DASHBOARD_PASSWORD'] = 'operator-upgrade-secret';

    const auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(true);
    const stored = readStoredCredentials();
    expect(stored.username).toBe('operator');
    expect(stored.provisionedBy).toBe('env');
    expect(stored.mustChangePassword).toBe(false);
    expect(auth.login('operator', 'operator-upgrade-secret').ok).toBe(true);
    expect(auth.login('shizuha', 'shizuha').ok).toBe(false);
  });

  it('preserves metadata-less custom credentials instead of treating them as the legacy default', async () => {
    const salt = crypto.randomBytes(32).toString('hex');
    const authDir = path.join(tempHome, '.shizuha');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, 'dashboard.json'), JSON.stringify({
      username: 'operator',
      passwordHash: crypto.scryptSync('operator-known-password', salt, 64).toString('hex'),
      salt,
      createdAt: new Date().toISOString(),
    }));
    process.env['SHIZUHA_DASHBOARD_PASSWORD'] = 'new-env-secret-ignored';

    const auth = await import('../../src/daemon/dashboard-auth.js');

    expect(auth.ensureDashboardCredentials()).toBe(false);
    const stored = readStoredCredentials();
    expect(stored.username).toBe('operator');
    expect(stored.provisionedBy).toBeUndefined();
    expect(stored.mustChangePassword).toBeUndefined();
    expect(auth.login('operator', 'operator-known-password').ok).toBe(true);
    expect(auth.login('operator', 'new-env-secret-ignored').ok).toBe(false);
  });

  it('shares mini-Connect state across multiple daemon bind listeners', async () => {
    const dashboard = await import('../../src/daemon/dashboard.js');

    const browserFacing = dashboard.getSharedMiniConnectState();
    const containerFacing = dashboard.getSharedMiniConnectState();

    expect(containerFacing.store).toBe(browserFacing.store);
    expect(containerFacing.auth).toBe(browserFacing.auth);
    expect(containerFacing.channelLayer).toBe(browserFacing.channelLayer);

    browserFacing.auth.ensureAgentUser({
      username: 'ryo',
      agentId: 'agent-ryo',
      email: 'ryo@shizuha.com',
      displayName: 'Ryo',
      password: 'agent-secret',
    });

    const agentUser = containerFacing.store.getUserByUsername('ryo');
    expect(agentUser?.isAgent).toBe(true);
    expect(agentUser?.agentId).toBe('agent-ryo');

    const channel = { channelName: 'browser-loopback', onEvent: vi.fn() };
    browserFacing.channelLayer.groupAdd('connect.user.ryo', channel);
    expect(containerFacing.channelLayer.groupSize('connect.user.ryo')).toBe(1);

    dashboard.resetSharedMiniConnectStateForTest();
  });
});

describe('daemon dashboard host exposure', () => {
  let originalDashboardHost: string | undefined;
  let originalDashboardRemote: string | undefined;
  let originalBackendUrl: string | undefined;

  beforeEach(() => {
    originalDashboardHost = process.env['SHIZUHA_DASHBOARD_HOST'];
    originalDashboardRemote = process.env['SHIZUHA_DASHBOARD_REMOTE'];
    originalBackendUrl = process.env['SHIZUHA_BACKEND_URL'];
    delete process.env['SHIZUHA_DASHBOARD_HOST'];
    delete process.env['SHIZUHA_DASHBOARD_REMOTE'];
    delete process.env['SHIZUHA_BACKEND_URL'];
  });

  afterEach(() => {
    if (originalDashboardHost === undefined) delete process.env['SHIZUHA_DASHBOARD_HOST'];
    else process.env['SHIZUHA_DASHBOARD_HOST'] = originalDashboardHost;
    if (originalDashboardRemote === undefined) delete process.env['SHIZUHA_DASHBOARD_REMOTE'];
    else process.env['SHIZUHA_DASHBOARD_REMOTE'] = originalDashboardRemote;
    if (originalBackendUrl === undefined) delete process.env['SHIZUHA_BACKEND_URL'];
    else process.env['SHIZUHA_BACKEND_URL'] = originalBackendUrl;
  });

  it('defaults to localhost and uses a side-effect-free container bridge alias', async () => {
    const {
      resolveBareMetalBackendUrl,
      resolveBareMetalCodexBrokerUrl,
      resolveBareMetalDaemonHost,
      resolveContainerCodexBrokerUrl,
      resolveDashboardHost,
      resolveDashboardBindHosts,
      resolveDashboardListenerPlan,
    } = await import('../../src/daemon/manager.js');
    const daemonHttpPort = '8015';

    expect(resolveDashboardHost()).toBe('localhost');
    expect(resolveBareMetalDaemonHost()).toBe('localhost');
    expect(resolveBareMetalBackendUrl(`http://host.docker.internal:${daemonHttpPort}`))
      .toBe(`http://localhost:${daemonHttpPort}`);
    expect(resolveBareMetalCodexBrokerUrl()).toBe(`http://localhost:${daemonHttpPort}/v1/codex/token`);
    expect(resolveContainerCodexBrokerUrl()).toBe(`http://host.docker.internal:${daemonHttpPort}/v1/codex/token`);
    expect(resolveDashboardBindHosts()).toEqual(['localhost']);
    expect(resolveDashboardBindHosts({ containerMode: true, hostGateway: '172.18.0.1' })).toEqual([
      'localhost',
      '172.18.0.1',
    ]);
    expect(resolveDashboardListenerPlan({ containerMode: true, hostGateway: '172.18.0.1' })).toEqual({
      primaryHost: 'localhost',
      proxyHosts: ['172.18.0.1'],
    });

    process.env['SHIZUHA_DASHBOARD_REMOTE'] = '1';
    expect(resolveDashboardHost()).toBe('0.0.0.0');
    expect(resolveBareMetalDaemonHost()).toBe('127.0.0.1');
    expect(resolveBareMetalBackendUrl(`http://host.docker.internal:${daemonHttpPort}`))
      .toBe(`http://127.0.0.1:${daemonHttpPort}`);
    expect(resolveBareMetalCodexBrokerUrl()).toBe(`http://127.0.0.1:${daemonHttpPort}/v1/codex/token`);
    expect(resolveDashboardBindHosts({ containerMode: true, hostGateway: '172.18.0.1' })).toEqual(['0.0.0.0']);
    expect(resolveDashboardListenerPlan({ containerMode: true, hostGateway: '172.18.0.1' })).toEqual({
      primaryHost: '0.0.0.0',
      proxyHosts: [],
    });

    delete process.env['SHIZUHA_DASHBOARD_REMOTE'];
    process.env['SHIZUHA_DASHBOARD_HOST'] = '192.0.2.10';
    expect(resolveDashboardHost()).toBe('192.0.2.10');
    expect(resolveBareMetalDaemonHost()).toBe('192.0.2.10');
    expect(resolveBareMetalBackendUrl(`http://host.docker.internal:${daemonHttpPort}`))
      .toBe(`http://192.0.2.10:${daemonHttpPort}`);
    expect(resolveBareMetalCodexBrokerUrl()).toBe(`http://192.0.2.10:${daemonHttpPort}/v1/codex/token`);
    expect(resolveDashboardBindHosts({ containerMode: true, hostGateway: '172.18.0.1' })).toEqual(['192.0.2.10']);
    expect(resolveDashboardListenerPlan({ containerMode: true, hostGateway: '172.18.0.1' })).toEqual({
      primaryHost: '192.0.2.10',
      proxyHosts: [],
    });
  });

  it('proxies TLS HTTP fallback to the actual primary bind target', async () => {
    const { dashboardProxyTargetHost } = await import('../../src/daemon/dashboard.js');

    expect(dashboardProxyTargetHost('127.0.0.1')).toBe('127.0.0.1');
    expect(dashboardProxyTargetHost('192.0.2.10')).toBe('192.0.2.10');
    expect(dashboardProxyTargetHost('0.0.0.0')).toBe('127.0.0.1');
  });

  it('treats Docker bridge proxy headers as trusted only from loopback', async () => {
    const { isDashboardBridgeRequest, isTrustedDashboardBridgeRequest } = await import('../../src/daemon/dashboard.js');
    const bridgeHeaders = { 'x-shizuha-dashboard-bridge': 'docker-gateway' };

    expect(isDashboardBridgeRequest(bridgeHeaders)).toBe(true);
    expect(isTrustedDashboardBridgeRequest(bridgeHeaders, '127.0.0.1')).toBe(true);
    expect(isTrustedDashboardBridgeRequest(bridgeHeaders, '::ffff:127.0.0.1')).toBe(true);
    expect(isTrustedDashboardBridgeRequest(bridgeHeaders, '203.0.113.10')).toBe(false);
    expect(isTrustedDashboardBridgeRequest({}, '127.0.0.1')).toBe(false);
  });
});
