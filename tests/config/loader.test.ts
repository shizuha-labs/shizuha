import { describe, it, expect } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

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
