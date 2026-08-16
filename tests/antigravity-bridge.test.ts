import { describe, expect, it } from 'vitest';
import {
  buildAntigravityMcpConfig,
  buildAntigravitySpawnArgs,
  buildAntigravityStoredToken,
} from '../src/antigravity-bridge/index.js';

describe('Antigravity bridge configuration', () => {
  it('converts a Hive Google OAuth lease to Antigravity headless storage', () => {
    expect(buildAntigravityStoredToken(JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_date: 1_800_000_000_000,
      id_token: 'not persisted',
    }))).toEqual({
      token: {
        access_token: 'access',
        token_type: 'Bearer',
        refresh_token: 'refresh',
        expiry: '2027-01-15T08:00:00.000Z',
      },
      auth_method: 'consumer',
    });
  });

  it('rejects incomplete broker credentials', () => {
    expect(() => buildAntigravityStoredToken(JSON.stringify({
      access_token: 'access',
    }))).toThrow(/lacks access_token, refresh_token, or expiry/);
  });

  it('writes Antigravity native MCP server entries', () => {
    expect(buildAntigravityMcpConfig({
      'shizuha-pulse': {
        command: 'node',
        args: ['/app/mcp-proxy.mjs'],
        env: { MCP_UPSTREAM_URL: 'https://shizuha.com/pulse/mcp' },
      },
      browser: {
        url: 'http://browser-mcp:8931/mcp',
        headers: { authorization: 'Bearer test' },
      },
      invalid: { args: ['missing-command'] },
    })).toEqual({
      mcpServers: {
        'shizuha-pulse': {
          command: 'node',
          args: ['/app/mcp-proxy.mjs'],
          env: { MCP_UPSTREAM_URL: 'https://shizuha.com/pulse/mcp' },
        },
        browser: {
          serverUrl: 'http://browser-mcp:8931/mcp',
          headers: { authorization: 'Bearer test' },
        },
      },
    });
  });

  it('resumes direct turns by explicit conversation ID', () => {
    expect(buildAntigravitySpawnArgs({
      model: 'gemini-3.6-flash-high',
      prompt: 'continue',
      conversationId: 'conversation-123',
    })).toEqual([
      '--print',
      'continue',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3.6-flash-high',
      '--conversation',
      'conversation-123',
    ]);
  });

  it('keeps autonomous turns fresh when no conversation ID is supplied', () => {
    const args = buildAntigravitySpawnArgs({
      model: 'gemini-3.6-flash-high',
      prompt: '[HEARTBEAT]',
    });
    expect(args).not.toContain('--conversation');
    expect(args).not.toContain('--continue');
  });
});
