import { describe, it, expect } from 'vitest';
import { parse as parseTOML } from 'smol-toml';
import { configSchema } from '../../src/config/schema.js';
import { isSensitiveConfigKey, redactConfigForOutput } from '../../src/config/redaction.js';

describe('configSchema', () => {
  it('provides defaults for empty input', () => {
    const result = configSchema.parse({});
    expect(result.agent.defaultModel).toBe('auto');
    expect(result.agent.maxTurns).toBe(0); // 0 = unlimited
    expect(result.agent.temperature).toBe(0);
    expect(result.permissions.mode).toBe('supervised');
    expect(result.logging.level).toBe('info');
  });

  it('accepts valid overrides', () => {
    const result = configSchema.parse({
      agent: { defaultModel: 'gpt-4o', maxTurns: 100 },
      permissions: { mode: 'autonomous' },
    });
    expect(result.agent.defaultModel).toBe('gpt-4o');
    expect(result.agent.maxTurns).toBe(100);
    expect(result.permissions.mode).toBe('autonomous');
  });

  it('rejects invalid permission mode', () => {
    expect(() =>
      configSchema.parse({ permissions: { mode: 'invalid' } }),
    ).toThrow();
  });

  it('accepts maxTurns 0 (unlimited)', () => {
    const result = configSchema.parse({ agent: { maxTurns: 0 } });
    expect(result.agent.maxTurns).toBe(0);
  });

  it('rejects negative maxTurns', () => {
    expect(() =>
      configSchema.parse({ agent: { maxTurns: -1 } }),
    ).toThrow();
  });

  it('merges MCP servers', () => {
    const result = configSchema.parse({
      mcp: {
        servers: [
          { name: 'test', transport: 'stdio', command: 'node', args: ['server.js'] },
        ],
      },
    });
    expect(result.mcp.servers).toHaveLength(1);
    expect(result.mcp.servers[0]!.name).toBe('test');
  });
});

describe('config output redaction', () => {
  it('recursively redacts provider and MCP secret-name fields while preserving useful JSON', () => {
    const markers = {
      MCP_UPSTREAM_BEARER: 'qa-bearer-marker',
      SERVICE_JWT_TOKEN: 'qa-service-jwt-marker',
      USER_JWT_TOKEN: 'qa-user-jwt-marker',
      API_KEY: 'qa-api-key-marker',
      PASSWORD: 'qa-password-marker',
      CLIENT_SECRET: 'qa-client-secret-marker',
      ACCESS_TOKEN: 'qa-access-token-marker',
      CREDENTIAL: 'qa-credential-marker',
    };
    const input = {
      agent: { defaultModel: 'cortex/DeepSeek-V4-Flash', maxTokens: 4096 },
      providers: { cortex: { apiKey: 'qa-provider-key-marker', baseUrl: 'https://cortex.example' } },
      mcp: { servers: [{ name: 'pulse', env: markers }] },
    };

    const output = redactConfigForOutput(input);
    const serialized = JSON.stringify(output);

    expect(output).toEqual({
      agent: input.agent,
      providers: { cortex: { apiKey: '[REDACTED]', baseUrl: 'https://cortex.example' } },
      mcp: {
        servers: [{
          name: 'pulse',
          env: Object.fromEntries(Object.keys(markers).map((key) => [key, '[REDACTED]'])),
        }],
      },
    });
    for (const marker of ['qa-provider-key-marker', ...Object.values(markers)]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('does not mistake ordinary token-count configuration for a credential', () => {
    expect(isSensitiveConfigKey('maxTokens')).toBe(false);
    expect(isSensitiveConfigKey('inputTokenLimit')).toBe(false);
    expect(isSensitiveConfigKey('token')).toBe(true);
    expect(isSensitiveConfigKey('privateKey')).toBe(true);
  });
});

describe('smol-toml security regression (GHSA-v3rj-xjv7-4jmq)', () => {
  it('parses thousands of consecutive comments without overflowing the stack', () => {
    const document = `${'# comment\n'.repeat(8_000)}key = "value"`;

    expect(parseTOML(document)).toEqual({ key: 'value' });
  });
});
