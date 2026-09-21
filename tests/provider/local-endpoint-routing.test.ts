import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProviderRegistry } from '../../src/provider/registry.js';
import { setOpenAIEndpoint } from '../../src/config/credentials.js';
import { configSchema } from '../../src/config/schema.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

function emptyConfig(): ShizuhaConfig {
  return configSchema.parse({}) as ShizuhaConfig;
}

describe('local OpenAI-compatible routing (SCLI-593)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    prevHome = process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-local-ep-'));
    process.env['HOME'] = tmpHome;
    // SCLI-372 gate follow-up: scrub EVERY provider-credential env var the
    // registry reads, not just the OpenAI/Cortex/VLLM ones. This suite's
    // intent is "nothing else is configured" — a vantage carrying e.g.
    // GOOGLE_API_KEY (agent seats) registered the google provider and
    // resolveAutoModel returned 'gemini-2.5-pro', red-lighting the
    // premerge-full-suite gate on environment mismatch instead of code.
    for (const key of [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'CORTEX_API_KEY', 'CORTEX_OAUTH_TOKEN', 'CORTEX_BASE_URL',
      'VLLM_BASE_URL', 'VLLM_API_KEY',
      'GOOGLE_API_KEY', 'GEMINI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
      'XAI_API_KEY',
      'CODEX_API_KEY', 'CODEX_BASE_URL',
      'GITHUB_COPILOT_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'OLLAMA_BASE_URL',
      'LLAMACPP_BASE_URL',
      'LITELLM_PROXY_URL',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('registers openai from a stored base URL with no API key', () => {
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'Qwen3.6-27B' });
    const registry = new ProviderRegistry(emptyConfig());
    expect(registry.list()).toContain('openai');
    const resolved = registry.resolveWithModel('openai:Qwen3.6-27B');
    expect(resolved.provider.name).toBe('openai');
    expect(resolved.resolvedModel).toBe('Qwen3.6-27B');
  });

  it('does not send bare Qwen names to Cortex when a local endpoint is set and there is no Cortex auth', () => {
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:8000/v1' });
    const registry = new ProviderRegistry(emptyConfig());
    const resolved = registry.resolveWithModel('Qwen3.6-27B');
    expect(resolved.provider.name).toBe('openai');
    expect(resolved.resolvedModel).toBe('Qwen3.6-27B');
  });

  it('still honors an explicit cortex/ prefix', () => {
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:8000/v1' });
    const registry = new ProviderRegistry(emptyConfig());
    const resolved = registry.resolveWithModel('cortex/Qwen3.6-27B');
    expect(resolved.provider.name).toBe('cortex');
    expect(resolved.resolvedModel).toBe('Qwen3.6-27B');
  });

  it('resolveAutoModel prefers the local endpoint over Codex/gpt-5.5', () => {
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.2' });
    const registry = new ProviderRegistry(emptyConfig());
    expect(registry.resolveAutoModel()).toBe('openai:llama3.2');
  });

  it('resolveAutoModel uses local Ollama instead of gpt-5.5 when nothing else is configured', () => {
    const registry = new ProviderRegistry(emptyConfig());
    expect(registry.resolveAutoModel()).toBe('llama3.2');
  });
});
