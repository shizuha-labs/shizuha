import type {
  LocalCoreProviderConfig,
  LocalCoreProviderConfigState,
  LocalCoreProviderConfigWrite,
  ProviderConfigKind,
} from '../../../src/local-core-protocol.js';

export interface SecretStorageLike {
  store(key: string, value: string): PromiseLike<void> | Promise<void> | void;
  get?(key: string): PromiseLike<string | undefined> | Promise<string | undefined> | string | undefined;
}

export interface ProviderSettingsInput {
  provider: ProviderConfigKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export const PROVIDER_LABELS: Record<ProviderConfigKind, string> = {
  cortex: 'Cortex',
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI-compatible',
};

const DEFAULT_SECRET_PREFIX = 'shizuha.provider';

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function providerSecretKey(provider: ProviderConfigKind, model: string): string {
  const modelSlug = model.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return `${DEFAULT_SECRET_PREFIX}.${provider}.${modelSlug}.apiKey`;
}

export async function buildProviderConfigWrite(
  input: ProviderSettingsInput,
  secrets: SecretStorageLike,
): Promise<LocalCoreProviderConfigWrite> {
  const model = input.model.trim();
  if (!model) throw new Error('Model id is required.');

  const payload: LocalCoreProviderConfigWrite = {
    provider: input.provider,
    model,
    ...(cleanOptional(input.baseUrl) ? { base_url: cleanOptional(input.baseUrl) } : {}),
  };

  const apiKey = cleanOptional(input.apiKey);
  if (apiKey) {
    const secretKey = providerSecretKey(input.provider, model);
    await secrets.store(secretKey, apiKey);
    payload.api_key_secret_ref = `vscode:${secretKey}`;
  }

  return payload;
}


export function providerSecretStorageKey(secretRef: string | undefined): string | undefined {
  if (!secretRef?.startsWith('vscode:')) return undefined;
  const key = secretRef.slice('vscode:'.length).trim();
  return key || undefined;
}

export async function resolveProviderSecretValues(
  state: LocalCoreProviderConfigState,
  provider: ProviderConfigKind | string | undefined,
  model: string | undefined,
  secrets: Pick<SecretStorageLike, 'get'>,
  workspaceTrusted = true,
): Promise<Record<string, string> | undefined> {
  if (!workspaceTrusted) return undefined;
  const selected = selectProviderConfig(state, provider, model);
  if ((provider && selected?.provider !== provider) || (model && selected?.model !== model)) return undefined;
  const storageKey = providerSecretStorageKey(selected?.api_key_secret_ref);
  if (!selected?.api_key_secret_ref || !storageKey || !secrets.get) return undefined;
  const expectedStorageKey = providerSecretKey(selected.provider, selected.model);
  if (storageKey !== expectedStorageKey || selected.api_key_secret_ref !== `vscode:${expectedStorageKey}`) {
    return undefined;
  }
  const secretValue = await secrets.get(storageKey);
  return secretValue ? { [selected.api_key_secret_ref]: secretValue } : undefined;
}

export function selectProviderConfig(
  state: LocalCoreProviderConfigState,
  provider: ProviderConfigKind | string | undefined,
  model: string | undefined,
): LocalCoreProviderConfig | undefined {
  if (provider && model) {
    const exact = state.providers.find((candidate) => candidate.provider === provider && candidate.model === model);
    if (exact) return exact;
    return undefined;
  }
  if (provider) {
    const byProvider = state.providers.find((candidate) => candidate.provider === provider);
    if (byProvider) return byProvider;
  }
  if (model) {
    const byModel = state.providers.find((candidate) => candidate.model === model);
    if (byModel) return byModel;
  }
  return state.default_provider ? state.providers.find((candidate) => candidate.provider === state.default_provider) : undefined;
}
