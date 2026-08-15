import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ProviderRegistry } from '../../src/provider/registry.js';
import { configSchema } from '../../src/config/schema.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

/**
 * SCLI-23: explicit `provider:model` routing override.
 *
 * The colon form pins a model to a specific provider, bypassing the implicit
 * heuristics (prefix map, Copilot-format detection). It must coexist with
 * Ollama's `model:tag` syntax and not regress the existing `provider/model`
 * slash form or implicit resolution.
 */

// Provider env vars that would otherwise non-deterministically register providers.
const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
  'GITHUB_COPILOT_TOKEN', 'LITELLM_PROXY_URL', 'VLLM_BASE_URL', 'LLAMACPP_BASE_URL',
  'CORTEX_API_KEY', 'CORTEX_OAUTH_TOKEN', 'CORTEX_BASE_URL',
  'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'TOGETHER_API_KEY',
];

let saved: Record<string, string | undefined> = {};

function buildConfig(): ShizuhaConfig {
  return configSchema.parse({
    providers: {
      anthropic: { apiKey: 'sk-ant-test' },
      openai: { apiKey: 'sk-oai-test' },
      openrouter: { apiKey: 'sk-or-test' },
    },
  }) as ShizuhaConfig;
}

describe('ProviderRegistry — explicit provider:model override (SCLI-23)', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    saved = {};
    for (const k of PROVIDER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    registry = new ProviderRegistry(buildConfig());
  });

  afterEach(() => {
    for (const k of PROVIDER_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('routes provider:model to the named provider and strips the prefix', () => {
    const r = registry.resolveWithModel('anthropic:claude-opus-4-7');
    expect(r.provider).toBe(registry.get('anthropic'));
    expect(r.resolvedModel).toBe('claude-opus-4-7');
  });

  it('routes a different provider for the same-shaped model name', () => {
    const r = registry.resolveWithModel('openai:gpt-4.1');
    expect(r.provider).toBe(registry.get('openai'));
    expect(r.resolvedModel).toBe('gpt-4.1');
  });

  it('override beats the Copilot-format heuristic (pins dot-version model to Anthropic)', () => {
    // Without the override, claude-opus-4.6 (dot-version) routes to copilot/litellm.
    const r = registry.resolveWithModel('anthropic:claude-opus-4.6');
    expect(r.provider).toBe(registry.get('anthropic'));
    expect(r.resolvedModel).toBe('claude-opus-4.6');
  });

  it('alias-resolves the model after the colon', () => {
    const r = registry.resolveWithModel('anthropic:opus');
    expect(r.provider).toBe(registry.get('anthropic'));
    expect(r.resolvedModel).toBe('claude-opus-5');
  });

  it('errors helpfully for a recognized-but-unconfigured provider', () => {
    expect(registry.get('vllm')).toBeUndefined(); // not configured in this test env
    let err: Error | undefined;
    try { registry.resolveWithModel('vllm:some-model'); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/Provider "vllm" is not configured/);
    expect(err!.message).toMatch(/VLLM_BASE_URL/);            // strict hint included
    expect(err!.message).toMatch(/Configured providers:/);    // lists what IS available
    expect(err!.message).toContain('anthropic');              // a configured one is listed
  });

  it('errors when no model is given after the provider colon', () => {
    expect(() => registry.resolveWithModel('anthropic:')).toThrow(/No model specified after "anthropic:"/);
  });

  it('does NOT treat an unknown prefix as an override — preserves Ollama model:tag', () => {
    const r = registry.resolveWithModel('llama3.1:8b');
    expect(r.provider).toBe(registry.get('ollama'));
    expect(r.resolvedModel).toBe('llama3.1:8b'); // full tag preserved, not split
  });

  it('splits only on the first colon (ollama:model:tag)', () => {
    const r = registry.resolveWithModel('ollama:llama3.1:8b');
    expect(r.provider).toBe(registry.get('ollama'));
    expect(r.resolvedModel).toBe('llama3.1:8b');
  });

  it('back-compat: provider/model slash form still works', () => {
    const r = registry.resolveWithModel('openrouter/anthropic/claude-3-opus');
    expect(r.provider).toBe(registry.get('openrouter'));
    expect(r.resolvedModel).toBe('anthropic/claude-3-opus');
  });

  it('back-compat: implicit prefix-map resolution unchanged', () => {
    expect(registry.resolveWithModel('claude-opus-4-7').provider).toBe(registry.get('anthropic'));
    expect(registry.resolveWithModel('gpt-4.1').provider).toBe(registry.get('openai'));
  });
});
