import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildBrokerCodexAuthFile,
  CodexBridge,
  parseBrokerCodexPayload,
} from '../../src/codex-bridge/index.js';
import * as brokerTokenModule from '../../src/auth/broker-token.js';

describe('Hive-managed Codex external auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('accepts the legacy full bundle but never carries its refresh token into auth.json', () => {
    const payload = parseBrokerCodexPayload(JSON.stringify({
      access_token: 'access.jwt.token',
      refresh_token: 'single-use-refresh-must-stay-in-hive',
      id_token: 'legacy-id-token',
      account_id: 'acct-1',
      email: 'codex@example.com',
      plan_type: 'pro',
    }));

    expect(payload).toEqual({
      accessToken: 'access.jwt.token',
      accountId: 'acct-1',
      email: 'codex@example.com',
      chatgptPlanType: 'pro',
    });

    const auth = buildBrokerCodexAuthFile(payload!, new Date('2026-07-16T12:00:00Z'));
    expect(auth).toEqual({
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        id_token: 'access.jwt.token',
        access_token: 'access.jwt.token',
        refresh_token: '',
        account_id: 'acct-1',
      },
      last_refresh: '2026-07-16T12:00:00.000Z',
    });
    expect(JSON.stringify(auth)).not.toContain('single-use-refresh-must-stay-in-hive');
    expect(JSON.stringify(auth)).not.toContain('legacy-id-token');
  });

  it('accepts Hive access-only leases and rejects bundles without an account id', () => {
    expect(parseBrokerCodexPayload(JSON.stringify({
      access_token: 'access.jwt.token',
      account_id: 'acct-2',
      email: 'managed@example.com',
    }))).toEqual({
      accessToken: 'access.jwt.token',
      accountId: 'acct-2',
      email: 'managed@example.com',
    });

    expect(parseBrokerCodexPayload(JSON.stringify({
      access_token: 'access.jwt.token',
      email: 'missing-account@example.com',
    }))).toBeNull();
    expect(parseBrokerCodexPayload(JSON.stringify({
      access_token: 'access.jwt.token',
      account_id: null,
    }))).toBeNull();
  });

  it('installs external auth only after enabling the experimental app-server API', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-external-init-'));
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.brokerCodexAuth = {
      accessToken: 'access.jwt.token',
      accountId: 'acct-init',
      email: 'managed@example.com',
      chatgptPlanType: 'pro',
    };
    bridge.rpcNotify = vi.fn();
    bridge.processQueue = vi.fn();
    bridge.rpcRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'initialize') {
        expect(params).toMatchObject({
          capabilities: { experimentalApi: true },
        });
        return {};
      }
      if (method === 'account/login/start') {
        expect(params).toEqual({
          type: 'chatgptAuthTokens',
          accessToken: 'access.jwt.token',
          chatgptAccountId: 'acct-init',
          chatgptPlanType: 'pro',
        });
        return { type: 'chatgptAuthTokens' };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    await bridge.initialize();

    expect(bridge.rpcRequest.mock.calls.map(([method]: [string]) => method)).toEqual([
      'initialize',
      'account/login/start',
    ]);
    expect(bridge.rpcNotify).toHaveBeenCalledWith('initialized', {});
    expect(bridge.serverReady).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('answers Codex 401 refresh requests with a new access-only Hive lease', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-external-refresh-'));
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'sora',
      cwd,
    } as any) as any;
    bridge.activeBrokerModelToken = {
      token: 'old',
      label: 'primary',
      entryId: 'entry-current',
      leaseId: 'lease-old',
      expiresAt: '2026-07-16T12:15:00Z',
    };
    bridge.writeBrokerCodexAuth = vi.fn();
    const sent: Array<Record<string, unknown>> = [];
    bridge.sendToServer = vi.fn((raw: string) => sent.push(JSON.parse(raw)));
    vi.spyOn(brokerTokenModule, 'fetchBrokerModelToken').mockResolvedValue({
      token: JSON.stringify({
        access_token: 'new.access.jwt',
        account_id: 'acct-refresh',
        email: 'managed@example.com',
        plan_type: 'pro',
      }),
      label: 'primary',
      entryId: 'entry-current',
      leaseId: 'lease-new',
      expiresAt: '2026-07-16T12:30:00Z',
    });

    await bridge.handleServerRequest({
      jsonrpc: '2.0',
      id: 'refresh-1',
      method: 'account/chatgptAuthTokens/refresh',
      params: {
        reason: 'unauthorized',
        previousAccountId: 'acct-refresh',
      },
    });

    expect(brokerTokenModule.fetchBrokerModelToken).toHaveBeenCalledWith(
      'openai',
      8000,
      {
        forceRefresh: true,
        preferredEntryId: 'entry-current',
        stickyKey: 'agent:sora',
      },
    );
    expect(sent).toEqual([{
      jsonrpc: '2.0',
      id: 'refresh-1',
      result: {
        accessToken: 'new.access.jwt',
        chatgptAccountId: 'acct-refresh',
        chatgptPlanType: 'pro',
      },
    }]);
    expect(bridge.writeBrokerCodexAuth).toHaveBeenCalledOnce();
    expect(bridge.brokerCodexAuth).not.toHaveProperty('refreshToken');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('excludes the exhausted broker lease during deliberate account rotation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-external-rotate-'));
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'sora',
      cwd,
    } as any) as any;
    process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(cwd, 'broker.sock');
    bridge.writeBrokerCodexAuth = vi.fn();
    vi.spyOn(brokerTokenModule, 'fetchBrokerModelToken').mockResolvedValue({
      token: JSON.stringify({
        access_token: 'replacement.access.jwt',
        account_id: 'acct-replacement',
        email: 'replacement@example.com',
      }),
      label: 'replacement',
      entryId: 'entry-replacement',
      leaseId: 'lease-replacement',
      expiresAt: '2026-07-17T12:30:00Z',
    });

    try {
      await expect(bridge.activateBrokerCodexAccount(
        bridge.getAgentCodexHome(),
        path.join(bridge.getAgentCodexHome(), 'auth.json'),
        false,
        'entry-exhausted',
      )).resolves.toBe(true);
      expect(brokerTokenModule.fetchBrokerModelToken).toHaveBeenCalledWith(
        'openai',
        5000,
        {
          excludeEntryId: 'entry-exhausted',
          stickyKey: 'agent:sora',
        },
      );
      expect(bridge.activeBrokerModelToken.entryId).toBe('entry-replacement');
    } finally {
      delete process.env['MCP_AUTH_PROXY_SOCKET'];
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('passes the current lease id into exhaustion rotation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exhaustion-rotate-'));
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'sora',
      cwd,
    } as any) as any;
    process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(cwd, 'broker.sock');
    bridge.activeBrokerModelToken = {
      token: 'old',
      label: 'exhausted',
      entryId: 'entry-exhausted',
      leaseId: 'lease-exhausted',
      expiresAt: '2026-07-17T12:00:00Z',
    };
    bridge.codexActiveAccountEmail = 'exhausted@example.com';
    bridge.activateBrokerCodexAccount = vi.fn(async (..._args: unknown[]) => {
      bridge.codexActiveAccountEmail = 'replacement@example.com';
      bridge.activeBrokerModelToken = {
        token: 'replacement',
        label: 'replacement',
        entryId: 'entry-replacement',
        leaseId: 'lease-replacement',
        expiresAt: '2026-07-17T12:15:00Z',
      };
      return true;
    });
    bridge.restartAppServerForAuthRotation = vi.fn();
    bridge.requestHeartbeatCheckpoint = vi.fn();

    try {
      await bridge.rotateCodexAccountOnExhaustion();
      expect(bridge.activateBrokerCodexAccount).toHaveBeenCalledWith(
        bridge.getAgentCodexHome(),
        path.join(bridge.getAgentCodexHome(), 'auth.json'),
        process.getuid?.() === 0,
        'entry-exhausted',
      );
      expect(bridge.restartAppServerForAuthRotation).toHaveBeenCalledOnce();
      expect(bridge.requestHeartbeatCheckpoint).toHaveBeenCalledWith({
        resetThread: true,
        delayMs: 1_000,
        reason: 'empty-turn account rotation recovery',
      });
    } finally {
      delete process.env['MCP_AUTH_PROXY_SOCKET'];
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('stops rotating when the broker cycles back to an already-empty account', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exhaustion-cycle-'));
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'sora',
      cwd,
    } as any) as any;
    process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(cwd, 'broker.sock');
    bridge.activeBrokerModelToken = {
      token: 'a', label: 'a', entryId: 'entry-a', leaseId: 'lease-a', expiresAt: '',
    };
    bridge.codexActiveAccountEmail = 'a@example.com';
    bridge.activateBrokerCodexAccount = vi.fn(async () => {
      if (bridge.activeBrokerModelToken.entryId === 'entry-a') {
        bridge.activeBrokerModelToken = {
          token: 'b', label: 'b', entryId: 'entry-b', leaseId: 'lease-b', expiresAt: '',
        };
        bridge.codexActiveAccountEmail = 'b@example.com';
      } else {
        bridge.activeBrokerModelToken = {
          token: 'a', label: 'a', entryId: 'entry-a', leaseId: 'lease-a2', expiresAt: '',
        };
        bridge.codexActiveAccountEmail = 'a@example.com';
      }
      return true;
    });
    bridge.restartAppServerForAuthRotation = vi.fn();
    bridge.requestHeartbeatCheckpoint = vi.fn();
    bridge.failoverToConfiguredFallbackOnExhaustion = vi.fn();

    try {
      await bridge.rotateCodexAccountOnExhaustion();
      expect(bridge.restartAppServerForAuthRotation).toHaveBeenCalledOnce();
      expect(bridge.requestHeartbeatCheckpoint).toHaveBeenCalledOnce();
      expect(bridge.failoverToConfiguredFallbackOnExhaustion).not.toHaveBeenCalled();

      await bridge.rotateCodexAccountOnExhaustion();
      expect(bridge.restartAppServerForAuthRotation).toHaveBeenCalledOnce();
      expect(bridge.requestHeartbeatCheckpoint).toHaveBeenCalledOnce();
      expect(bridge.failoverToConfiguredFallbackOnExhaustion).toHaveBeenCalledOnce();
    } finally {
      delete process.env['MCP_AUTH_PROXY_SOCKET'];
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('soft stay-alive on empty-turn exhaustion without fallback (no sticky unavailable / exit 43)', () => {
    vi.useFakeTimers();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-no-fallback-health-'));
    const marker = path.join(cwd, 'provider-unavailable');
    process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'] = marker;
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'revi',
      cwd,
    } as any) as any;
    const previousFallbacks = process.env['SHIZUHA_MODEL_FALLBACKS'];
    delete process.env['SHIZUHA_MODEL_FALLBACKS'];
    bridge.connectClient = { sendTelemetry: vi.fn() };
    bridge.markAgentAvailability = vi.fn(async () => undefined);
    bridge.requestHeartbeatCheckpoint = vi.fn();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      bridge.failoverToConfiguredFallbackOnExhaustion();

      expect(bridge.connectClient.sendTelemetry).toHaveBeenCalledOnce();
      expect(bridge.buildTelemetry().health).toMatchObject({
        provider_unavailable: false,
        provider_unavailable_reason: null,
      });
      expect(bridge.markAgentAvailability).toHaveBeenCalledWith(true, '');
      expect(fs.existsSync(marker)).toBe(false);
      expect(bridge.requestHeartbeatCheckpoint).toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      if (previousFallbacks === undefined) delete process.env['SHIZUHA_MODEL_FALLBACKS'];
      else process.env['SHIZUHA_MODEL_FALLBACKS'] = previousFallbacks;
      delete process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'];
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('clears legacy empty-turn sticky markers on boot (not a real outage)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-retry-health-'));
    const marker = path.join(cwd, 'provider-unavailable');
    const reason = 'empty-turn exhausted on gpt-test; no distinct fallback configured';
    fs.writeFileSync(marker, reason);
    process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'] = marker;
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'revi',
      cwd,
    } as any) as any;

    try {
      // Empty-turn markers are non-sticky: cleared on construction.
      expect(fs.existsSync(marker)).toBe(false);
      expect(bridge.buildTelemetry().health).toMatchObject({
        provider_unavailable: false,
        provider_unavailable_reason: null,
      });
    } finally {
      delete process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'];
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves real rate-limit sticky markers across retries until a productive turn', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-ratelimit-health-'));
    const marker = path.join(cwd, 'provider-unavailable');
    const reason = 'rate_limit: usage limit reached';
    fs.writeFileSync(marker, reason);
    process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'] = marker;
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'revi',
      cwd,
    } as any) as any;
    bridge.markAgentAvailability = vi.fn(async () => undefined);

    try {
      expect(bridge.buildTelemetry().health).toMatchObject({
        ok: false,
        provider_unavailable: true,
        provider_unavailable_reason: reason,
      });

      bridge.activeThreadId = 'productive-recovery';
      bridge.activeThreadStartedAt = Date.now();
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/started', params: {} });
      bridge.currentTurnHasOutput = true;
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });

      expect(fs.existsSync(marker)).toBe(false);
      expect(bridge.buildTelemetry().health).toMatchObject({
        provider_unavailable: false,
        provider_unavailable_reason: null,
      });
      expect(bridge.markAgentAvailability).toHaveBeenCalledWith(true, '');
    } finally {
      delete process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'];
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('restores routing availability only after the first productive turn', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-productive-health-'));
    const bridge = new CodexBridge({
      model: 'gpt-test',
      agentUsername: 'revi',
      cwd,
    } as any) as any;
    bridge.markAgentAvailability = vi.fn(async () => undefined);

    try {
      expect(bridge.markAgentAvailability).not.toHaveBeenCalled();

      bridge.activeThreadId = 'productive-turn-1';
      bridge.activeThreadStartedAt = Date.now();
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/started', params: {} });
      bridge.currentTurnHasOutput = true;
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      expect(bridge.markAgentAvailability).toHaveBeenCalledOnce();
      expect(bridge.markAgentAvailability).toHaveBeenCalledWith(true, '');

      bridge.activeThreadId = 'productive-turn-2';
      bridge.activeThreadStartedAt = Date.now();
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/started', params: {} });
      bridge.currentTurnHasOutput = true;
      bridge.handleServerNotification({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
      expect(bridge.markAgentAvailability).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('removes stale per-agent auth when the Hive broker is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-auth-'));
    const authFile = path.join(dir, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'stale-local-authority' },
    }));
    const bridge = new CodexBridge({ model: 'gpt-test', cwd: dir }) as any;

    bridge.clearBrokerCodexAuthCache(authFile);

    expect(fs.existsSync(authFile)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
