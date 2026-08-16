import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CORTEX_BASE_URL, ProviderRegistry, isCortexModelId, resolveCortexAuthToken, resolveCortexBaseUrl } from '../../src/provider/registry.js';
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
      expect(() => registry.resolve('claude-sonnet-4-20250514')).toThrow('Claude model requires authentication');
    } finally {
      if (savedToken) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedToken;
      if (savedHome) process.env['HOME'] = savedHome;
    }
  });

  it('lists available providers', () => {
    const registry = new ProviderRegistry(mockConfig);
    const list = registry.list();
    expect(list).toContain('ollama');
    expect(list).toContain('cortex');
  });

  it('registers Shizuha Cortex by default', () => {
    const registry = new ProviderRegistry(mockConfig);
    const resolved = registry.resolveWithModel('cortex/GLM-4.7');
    expect(resolved.provider.name).toBe('cortex');
    expect(resolved.resolvedModel).toBe('GLM-4.7');
  });

  it('routes clean Cortex DeepSeek model IDs to Cortex even when DeepSeek API is configured', () => {
    const saved = process.env['DEEPSEEK_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'sk-deepseek-test';
    try {
      const registry = new ProviderRegistry(mockConfig);
      const resolved = registry.resolveWithModel('DeepSeek-V4-Flash');
      expect(resolved.provider.name).toBe('cortex');
      expect(resolved.resolvedModel).toBe('DeepSeek-V4-Flash');
    } finally {
      if (saved !== undefined) process.env['DEEPSEEK_API_KEY'] = saved;
      else delete process.env['DEEPSEEK_API_KEY'];
    }
  });

  it('ignores blank Cortex env overrides', () => {
    const savedHome = process.env['HOME'];
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-registry-'));
    process.env['CORTEX_BASE_URL'] = '';
    process.env['CORTEX_API_KEY'] = '   ';
    process.env['CORTEX_OAUTH_TOKEN'] = '';
    process.env['HOME'] = tmpHome;
    try {
      expect(resolveCortexBaseUrl(mockConfig)).toBe(DEFAULT_CORTEX_BASE_URL);
      expect(resolveCortexAuthToken(mockConfig)).toBeUndefined();
    } finally {
      delete process.env['CORTEX_BASE_URL'];
      delete process.env['CORTEX_API_KEY'];
      delete process.env['CORTEX_OAUTH_TOKEN'];
      if (savedHome !== undefined) process.env['HOME'] = savedHome;
      else delete process.env['HOME'];
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
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

describe('isCortexModelId (CTX-67)', () => {
  it('accepts the legacy cortex/ prefix during migration', () => {
    expect(isCortexModelId('cortex/GLM-4.7')).toBe(true);
    expect(isCortexModelId('cortex/anything')).toBe(true);
  });

  it('accepts clean IDs from every gateway-served family', () => {
    for (const id of [
      'GLM-4.7', 'glm-4.9', 'ChatGLM3',
      'Qwen3.6-27B', 'qwen3-7b',
      'gpt-oss-120b',            // was silently falling to ollama before the rider
      'MiniMax-M2.7',
      'DeepSeek-V3.2',
      'grok-4.6',               // managed xAI via Cortex (fleet agents)
      'grok-4.6-latest',
      'xai/grok-4.6',
      'grok-4.5',               // managed xAI via Cortex (fleet agents)
      'grok-4.5-latest',
      'xai/grok-4.5',           // Cortex vendor-prefixed offer id (not SCLI xai/ routing)
    ]) {
      expect(isCortexModelId(id)).toBe(true);
    }
  });

  it('rejects empty and non-cortex model IDs', () => {
    expect(isCortexModelId('')).toBe(false);
    expect(isCortexModelId('codex-mini-latest')).toBe(false);
    expect(isCortexModelId('claude-opus-4-8')).toBe(false);
    expect(isCortexModelId('gemma2')).toBe(false);
    expect(isCortexModelId('xai/not-a-grok')).toBe(false);
  });

  it('routes Cortex Grok aliases (incl. xai/ prefix) to cortex, not ollama/xai slash', () => {
    const config = {
      providers: {
        cortex: { baseUrl: 'https://cortex.example/v1', apiKey: 'sk-cortex-test' },
      },
    } as ShizuhaConfig;
    const registry = new ProviderRegistry(config);
    for (const id of ['grok-4.6', 'grok-4.6-latest', 'xai/grok-4.6', 'grok-4.5', 'grok-4.5-latest', 'xai/grok-4.5']) {
      const r = registry.resolveWithModel(id);
      expect(r.provider.name).toBe('cortex');
      // Full offer id is preserved for the gateway (do not strip xai/).
      expect(r.resolvedModel).toBe(id);
    }
  });
});
