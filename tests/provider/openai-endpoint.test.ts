import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProviderRegistry } from '../../src/provider/registry.js';
import { setOpenAIEndpoint, readCredentials } from '../../src/config/credentials.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

/**
 * SCLI-594 — `shizuha auth endpoint` persists an OpenAI-compatible base URL +
 * optional key (no `shizuha login` required), and the provider registry
 * registers the `openai` provider against that endpoint even without a real
 * key (Ollama/vLLM often accept any value). `openai:MODEL` then hits the URL.
 */
describe('SCLI-594: OpenAI-compatible endpoint', () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedHome = process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli594-'));
    process.env['HOME'] = tmpHome;
    for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'TOGETHER_API_KEY', 'MISTRAL_API_KEY']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env['HOME'] = savedHome;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const mockConfig = (): ShizuhaConfig => ({
    agent: { defaultModel: 'openai:gpt-4.1-mini', maxTurns: 0, maxContextTokens: 128000, temperature: 0, maxOutputTokens: 16384, cwd: '/tmp' },
    providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    permissions: { mode: 'supervised', rules: [] },
    mcp: { servers: [] },
    skills: { trustProjectSkills: false },
    logging: { level: 'info' },
  } as ShizuhaConfig);

  it('persists baseUrl + key to credentials.openai', () => {
    setOpenAIEndpoint({ baseUrl: 'http://localhost:11434/v1', apiKey: 'local-key' });
    const creds = readCredentials();
    expect(creds.openai?.baseUrl).toBe('http://localhost:11434/v1');
    expect(creds.openai?.apiKey).toBe('local-key');
  });

  it('persists a baseUrl with no key (local server)', () => {
    setOpenAIEndpoint({ baseUrl: 'http://localhost:11434/v1' });
    const creds = readCredentials();
    expect(creds.openai?.baseUrl).toBe('http://localhost:11434/v1');
    expect(creds.openai?.apiKey ?? '').toBe('');
  });

  it('registers the openai provider from a persisted endpoint without a real key', () => {
    setOpenAIEndpoint({ baseUrl: 'http://localhost:11434/v1' });
    const registry = new ProviderRegistry(mockConfig());
    const resolved = registry.resolveWithModel('openai:llama3.1');
    expect(resolved.provider.name).toBe('openai');
    expect(resolved.resolvedModel).toBe('llama3.1');
    expect(registry.list()).toContain('openai');
  });

  it('keeps an existing key when only the URL is updated', () => {
    setOpenAIEndpoint({ baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-first' });
    setOpenAIEndpoint({ baseUrl: 'http://localhost:9999/v1' });
    const creds = readCredentials();
    expect(creds.openai?.baseUrl).toBe('http://localhost:9999/v1');
    expect(creds.openai?.apiKey).toBe('sk-first');
  });
});
