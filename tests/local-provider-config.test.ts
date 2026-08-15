import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ShizuhaConfig } from '../src/config/types.js';
import {
  applyLocalProviderConfigForRequest,
  mergeLocalProviderConfig,
  readLocalProviderConfigState,
  writeLocalProviderConfigState,
} from '../src/local-provider-config.js';

const baseConfig: ShizuhaConfig = {
  agent: { defaultModel: 'auto', maxTurns: 0, maxContextTokens: 128000, temperature: 0, maxOutputTokens: 16384, cwd: '/tmp' },
  providers: { ollama: { baseUrl: 'http://localhost:11434' } },
  permissions: { mode: 'supervised', rules: [] },
  mcp: { servers: [], toolSearch: { mode: 'auto', awareness: 'servers', autoThresholdPercent: 10, maxResults: 5 } },
  hooks: { hooks: [] },
  skills: { trustProjectSkills: false },
  sandbox: { mode: 'unrestricted', writablePaths: [], networkAccess: true, allowedHosts: [], protectedPaths: [] },
  logging: { level: 'info' },
  autoReply: { enabled: false, rules: [] },
  benchmarks: { juryBackend: 'all', swebenchSubset: [], pythonBin: 'python3', benchmarkDir: '', defaultAgent: 'sara' },
} as ShizuhaConfig;

const previousPath = process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'];

afterEach(() => {
  if (previousPath === undefined) delete process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'];
  else process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'] = previousPath;
});

describe('local provider config persistence', () => {
  it('persists restart-durable provider defaults without raw API keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scli-174-provider-'));
    process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'] = path.join(dir, 'provider-config.json');

    const initial = await readLocalProviderConfigState(baseConfig);
    const updated = mergeLocalProviderConfig(initial, {
      provider: 'cortex',
      model: 'glm-4.5',
      base_url: 'https://cortex.shizuha.com/v1',
      api_key_secret_ref: 'vscode:shizuha.provider.cortex.glm-4.5.apiKey',
    });
    await writeLocalProviderConfigState(updated);

    const raw = await fs.readFile(process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'], 'utf-8');
    expect(raw).toContain('vscode:shizuha.provider.cortex.glm-4.5.apiKey');
    expect(raw).not.toContain('sk-cortex-test-not-real');

    await expect(readLocalProviderConfigState(baseConfig)).resolves.toMatchObject({
      default_provider: 'cortex',
      default_model: 'glm-4.5',
      providers: [{ provider: 'cortex', has_api_key: true }],
      capabilities: { config_scope: 'durable-local-core', secret_ref_resolution: 'core-runtime-secret-ref-resolution' },
    });
  });

  it('resolves VS Code secret refs only at provider-call time for Cortex, Anthropic, and OpenAI-compatible providers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scli-174-provider-'));
    process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'] = path.join(dir, 'provider-config.json');
    let state = await readLocalProviderConfigState(baseConfig);
    for (const provider of ['cortex', 'anthropic', 'openai-compatible'] as const) {
      state = mergeLocalProviderConfig(state, {
        provider,
        model: provider === 'anthropic' ? 'claude-sonnet-4-6' : provider === 'cortex' ? 'glm-4.5' : 'gpt-4.1',
        base_url: provider === 'anthropic' ? undefined : `https://${provider}.example/v1`,
        api_key_secret_ref: `vscode:secret.${provider}`,
      });
    }
    await writeLocalProviderConfigState(state);

    const cortex = await applyLocalProviderConfigForRequest(baseConfig, {
      provider: 'cortex',
      provider_secret_values: { 'vscode:secret.cortex': 'sk-cortex-runtime' },
    });
    expect(cortex.model).toBe('glm-4.5');
    expect(cortex.config.providers.cortex).toMatchObject({ apiKey: 'sk-cortex-runtime', baseUrl: 'https://cortex.example/v1' });

    const anthropic = await applyLocalProviderConfigForRequest(baseConfig, {
      provider: 'anthropic',
      provider_secret_values: { 'vscode:secret.anthropic': 'sk-ant-runtime' },
    });
    expect(anthropic.config.providers.anthropic).toMatchObject({ apiKey: 'sk-ant-runtime' });

    const openaiCompatible = await applyLocalProviderConfigForRequest(baseConfig, {
      provider: 'openai-compatible',
      provider_secret_values: { 'vscode:secret.openai-compatible': 'sk-openai-runtime' },
    });
    expect(openaiCompatible.config.providers.openai).toMatchObject({ apiKey: 'sk-openai-runtime', baseUrl: 'https://openai-compatible.example/v1' });

    const persisted = await fs.readFile(process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'], 'utf-8');
    expect(persisted).not.toContain('sk-cortex-runtime');
    expect(persisted).not.toContain('sk-ant-runtime');
    expect(persisted).not.toContain('sk-openai-runtime');
  });
});
