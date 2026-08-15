import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlatformClient } from '../../src/daemon/platform-client.js';

describe('PlatformClient effective-capability daemon authentication', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  it('uses the daemon-authenticated runtime-lane contract without the retained bearer', async () => {
    process.env['SHIZUHA_DAEMON_ID'] = 'daemon-fleet';
    process.env['SHIZUHA_DAEMON_LINK_TOKEN'] = 'daemon-secret';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(String(url)).toContain('/hive/api/v1/fleet/agents/agent-id/runtime-lane');
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['X-Hive-Daemon-Id']).toBe('daemon-fleet');
      expect(headers['X-Hive-Daemon-Token']).toBe('daemon-secret');
      return new Response(JSON.stringify({
        model: 'gpt-5.6-sol',
        execution_method: 'codex_app_server',
        model_fallbacks: [{ method: 'codex_app_server', model: 'gpt-5.6-sol' }],
        model_overrides: { codex_app_server: 'gpt-5.6-sol' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PlatformClient('https://shizuha.com', 'expired-user-jwt');
    await expect(client.getFleetAgent('agent-id')).resolves.toEqual({
      model: 'gpt-5.6-sol',
      executionMethod: 'codex_app_server',
      modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.6-sol' }],
      modelOverrides: { codex_app_server: 'gpt-5.6-sol' },
    });
  });

  it('fails loud instead of treating runtime-lane authentication failure as no drift', async () => {
    process.env['SHIZUHA_DAEMON_ID'] = 'daemon-fleet';
    process.env['SHIZUHA_DAEMON_LINK_TOKEN'] = 'wrong-daemon-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Staff access required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )));

    const client = new PlatformClient('https://shizuha.com', 'expired-user-jwt');
    await expect(client.getFleetAgent('agent-id')).rejects.toThrow(
      'Failed to fetch runtime lane for agent-id: 403',
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('omits an expired user bearer when the scoped daemon credential is present', async () => {
    process.env['SHIZUHA_DAEMON_ID'] = 'daemon-fleet';
    process.env['SHIZUHA_DAEMON_LINK_TOKEN'] = 'daemon-secret';
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['X-Hive-Daemon-Id']).toBe('daemon-fleet');
      expect(headers['X-Hive-Daemon-Token']).toBe('daemon-secret');
      return new Response(JSON.stringify({ effective_capabilities: { version: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PlatformClient('https://shizuha.com', 'expired-user-jwt');
    await expect(client.getEffectiveCapabilities('agent-id')).resolves.toEqual({ version: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps bearer authentication when no daemon credential is available', async () => {
    delete process.env['SHIZUHA_DAEMON_ID'];
    delete process.env['SHIZUHA_DAEMON_LINK_TOKEN'];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer current-user-jwt');
      expect(headers['X-Hive-Daemon-Id']).toBeUndefined();
      return new Response(JSON.stringify({ effective_capabilities: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PlatformClient('https://shizuha.com', 'current-user-jwt');
    await expect(client.getEffectiveCapabilities('agent-id')).resolves.toBeNull();
  });
});
