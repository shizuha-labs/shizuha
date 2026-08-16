import { describe, expect, it } from 'vitest';
import { buildProviderConfigWrite, providerSecretKey, resolveProviderSecretValues } from '../extensions/vscode/src/provider-settings.js';

describe('VS Code provider settings', () => {
  it('stores API keys in SecretStorage and sends only a secret reference to the core', async () => {
    const stored = new Map<string, string>();
    const payload = await buildProviderConfigWrite({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-test-not-real',
    }, {
      store: (key, value) => { stored.set(key, value); },
    });

    const expectedKey = providerSecretKey('anthropic', 'claude-sonnet-4-6');
    expect(stored.get(expectedKey)).toBe('sk-ant-test-not-real');
    expect(payload).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      api_key_secret_ref: `vscode:${expectedKey}`,
    });
    expect(JSON.stringify(payload)).not.toContain('sk-ant-test-not-real');
  });

  it('resolves vscode secret refs from ExtensionContext.secrets only for run submission', async () => {
    const secretRef = 'vscode:shizuha.provider.cortex.glm-4.5.apiKey';
    const resolved = await resolveProviderSecretValues({
      default_provider: 'cortex',
      default_model: 'glm-4.5',
      providers: [{ provider: 'cortex', model: 'glm-4.5', api_key_secret_ref: secretRef, has_api_key: true }],
      capabilities: { config_scope: 'durable-local-core' },
    }, 'cortex', 'glm-4.5', {
      get: (key) => key === 'shizuha.provider.cortex.glm-4.5.apiKey' ? 'sk-cortex-test-not-real' : undefined,
    });

    expect(resolved).toEqual({ [secretRef]: 'sk-cortex-test-not-real' });
    expect(JSON.stringify({ provider: 'cortex', model: 'glm-4.5', api_key_secret_ref: secretRef })).not.toContain('sk-cortex-test-not-real');
  });

  it('never resolves a server-selected or untrusted-workspace SecretStorage key', async () => {
    let reads = 0;
    const forged = {
      default_provider: 'cortex',
      default_model: 'glm-4.5',
      providers: [{ provider: 'cortex' as const, model: 'glm-4.5', api_key_secret_ref: 'vscode:arbitrary.extension.secret.key', has_api_key: true }],
      capabilities: { config_scope: 'durable-local-core' },
    };
    const secrets = { get: () => { reads += 1; return 'DUMMY_SECRET_VALUE'; } };

    await expect(resolveProviderSecretValues(forged, 'cortex', 'glm-4.5', secrets)).resolves.toBeUndefined();
    await expect(resolveProviderSecretValues({
      ...forged,
      providers: [{ provider: 'cortex', model: 'glm-4.5', api_key_secret_ref: 'vscode:shizuha.provider.cortex.glm-4.5.apiKey', has_api_key: true }],
    }, 'cortex', 'glm-4.5', secrets, false)).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it('normalizes Cortex and OpenAI-compatible non-secret config shapes', async () => {
    const secrets = { store: () => undefined };
    await expect(buildProviderConfigWrite({
      provider: 'cortex',
      model: ' glm-4.5 ',
      baseUrl: ' https://cortex.shizuha.com/v1 ',
    }, secrets)).resolves.toEqual({
      provider: 'cortex',
      model: 'glm-4.5',
      base_url: 'https://cortex.shizuha.com/v1',
    });

    await expect(buildProviderConfigWrite({
      provider: 'openai-compatible',
      model: 'gpt-oss-120b',
      baseUrl: 'http://127.0.0.1:8080/v1',
    }, secrets)).resolves.toEqual({
      provider: 'openai-compatible',
      model: 'gpt-oss-120b',
      base_url: 'http://127.0.0.1:8080/v1',
    });
  });
});
