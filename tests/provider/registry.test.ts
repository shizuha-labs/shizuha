import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/provider/registry.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

const mockConfig: ShizuhaConfig = {
  agent: { defaultModel: 'codex-mini-latest', maxTurns: 0, maxContextTokens: 128000, temperature: 0, maxOutputTokens: 16384, cwd: '/tmp' },
  providers: { ollama: { baseUrl: 'http://localhost:11434' } },
  permissions: { mode: 'supervised', rules: [] },
  mcp: { servers: [] },
  skills: { trustProjectSkills: false },
  logging: { level: 'info' },
} as ShizuhaConfig;

describe('ProviderRegistry', () => {
  it('resolves Ollama for unknown models', () => {
    const registry = new ProviderRegistry(mockConfig);
    const provider = registry.resolve('my-custom-model');
    expect(provider.name).toBe('ollama');
  });

  it('resolves Ollama for known Ollama models', () => {
    const registry = new ProviderRegistry(mockConfig);
    const provider = registry.resolve('qwen3-coder-next:q4_K_M');
    expect(provider.name).toBe('ollama');
  });

  it('throws for Claude without API key', () => {
    const savedToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    const savedHome = process.env['HOME'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    // Point HOME to a non-existent dir so credential store auto-import finds nothing
    process.env['HOME'] = '/tmp/.shizuha-test-nonexistent';
    try {
      const config = { ...mockConfig, providers: { ollama: { baseUrl: 'http://localhost:11434' } } };
      const registry = new ProviderRegistry(config);
      expect(() => registry.resolve('claude-sonnet-4-20250514')).toThrow('not configured');
    } finally {
      if (savedToken) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedToken;
      if (savedHome) process.env['HOME'] = savedHome;
    }
  });

  it('lists available providers', () => {
    const registry = new ProviderRegistry(mockConfig);
    const list = registry.list();
    expect(list).toContain('ollama');
  });

  it('registers OpenRouter when API key is in config', () => {
    const config = {
      ...mockConfig,
      providers: {
        ollama: { baseUrl: 'http://localhost:11434' },
        openrouter: { apiKey: 'sk-or-test-key' },
      },
    } as ShizuhaConfig;
    const registry = new ProviderRegistry(config);
    expect(registry.list()).toContain('openrouter');
    const provider = registry.resolve('anthropic/claude-opus-4-6');
    expect(provider.name).toBe('openrouter');
  });

  it('registers OpenRouter when OPENROUTER_API_KEY env is set', () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test-env';
    try {
      const registry = new ProviderRegistry(mockConfig);
      expect(registry.list()).toContain('openrouter');
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
  });

  it('routes org/model patterns to OpenRouter', () => {
    const config = {
      ...mockConfig,
      providers: {
        ollama: { baseUrl: 'http://localhost:11434' },
        openrouter: { apiKey: 'sk-or-test-key' },
      },
    } as ShizuhaConfig;
    const registry = new ProviderRegistry(config);
    // org/model syntax should route to openrouter
    expect(registry.resolve('deepseek/deepseek-chat').name).toBe('openrouter');
    expect(registry.resolve('meta-llama/llama-3.3-70b').name).toBe('openrouter');
    expect(registry.resolve('mistralai/mistral-large').name).toBe('openrouter');
  });

  it('routes explicit openrouter/ prefix to OpenRouter', () => {
    const config = {
      ...mockConfig,
      providers: {
        ollama: { baseUrl: 'http://localhost:11434' },
        openrouter: { apiKey: 'sk-or-test-key' },
      },
    } as ShizuhaConfig;
    const registry = new ProviderRegistry(config);
    expect(registry.resolve('openrouter/anthropic/claude-sonnet-4-6').name).toBe('openrouter');
  });
});
