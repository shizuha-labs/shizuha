import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ShizuhaConfig } from './config/types.js';
import type {
  LocalCoreProviderConfig,
  LocalCoreProviderConfigState,
  LocalCoreProviderConfigWrite,
  ProviderConfigKind,
} from './local-core-protocol.js';

const SUPPORTED_PROVIDER_KINDS = new Set<ProviderConfigKind>(['cortex', 'anthropic', 'openai-compatible']);

export interface ProviderSecretResolutionRequest {
  provider?: string;
  model?: string;
  provider_secret_values?: Record<string, string>;
}

export function localProviderConfigPath(): string {
  if (process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH']) return process.env['SHIZUHA_LOCAL_PROVIDER_CONFIG_PATH'];
  return path.join(process.env['HOME'] ?? '~', '.config', 'shizuha', 'provider-config.json');
}

export function providerConfigCapabilities(): Record<string, unknown> {
  return {
    config_api: true,
    provider_kinds: [...SUPPORTED_PROVIDER_KINDS],
    config_scope: 'durable-local-core',
    secret_ref_resolution: 'core-runtime-secret-ref-resolution',
    secret_refs: 'vscode-secret-storage-or-core-delegated',
  };
}

function providerConfigFromLoadedConfig(cfg: ShizuhaConfig): LocalCoreProviderConfig[] {
  const providers: LocalCoreProviderConfig[] = [];
  if (cfg.providers.cortex?.baseUrl || cfg.providers.cortex?.apiKey) {
    providers.push({
      provider: 'cortex',
      model: cfg.agent.defaultModel || 'auto',
      base_url: cfg.providers.cortex?.baseUrl,
      has_api_key: !!cfg.providers.cortex?.apiKey,
    });
  }
  if (cfg.providers.anthropic?.baseUrl || cfg.providers.anthropic?.apiKey) {
    providers.push({
      provider: 'anthropic',
      model: cfg.agent.defaultModel || 'auto',
      base_url: cfg.providers.anthropic?.baseUrl,
      has_api_key: !!cfg.providers.anthropic?.apiKey,
    });
  }
  if (cfg.providers.openai?.baseUrl || cfg.providers.openai?.apiKey) {
    providers.push({
      provider: 'openai-compatible',
      model: cfg.agent.defaultModel || 'auto',
      base_url: cfg.providers.openai?.baseUrl,
      has_api_key: !!cfg.providers.openai?.apiKey,
    });
  }
  return providers;
}

function normalizeState(value: unknown): LocalCoreProviderConfigState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const providers = Array.isArray(row.providers) ? row.providers : [];
  const cleanProviders: LocalCoreProviderConfig[] = [];
  for (const candidate of providers) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const providerRow = candidate as Record<string, unknown>;
    const provider = providerRow.provider;
    const model = typeof providerRow.model === 'string' ? providerRow.model.trim() : '';
    if (!SUPPORTED_PROVIDER_KINDS.has(provider as ProviderConfigKind) || !model) continue;
    cleanProviders.push({
      provider: provider as ProviderConfigKind,
      model,
      base_url: typeof providerRow.base_url === 'string' && providerRow.base_url.trim() ? providerRow.base_url.trim() : undefined,
      api_key_secret_ref: typeof providerRow.api_key_secret_ref === 'string' && providerRow.api_key_secret_ref.trim() ? providerRow.api_key_secret_ref.trim() : undefined,
      has_api_key: providerRow.has_api_key === true || (typeof providerRow.api_key_secret_ref === 'string' && !!providerRow.api_key_secret_ref.trim()),
    });
  }
  return {
    default_provider: SUPPORTED_PROVIDER_KINDS.has(row.default_provider as ProviderConfigKind) ? row.default_provider as ProviderConfigKind : undefined,
    default_model: typeof row.default_model === 'string' && row.default_model.trim() ? row.default_model.trim() : undefined,
    providers: cleanProviders,
    capabilities: providerConfigCapabilities(),
  };
}

export async function readLocalProviderConfigState(cfg: ShizuhaConfig): Promise<LocalCoreProviderConfigState> {
  try {
    const raw = await fs.readFile(localProviderConfigPath(), 'utf-8');
    const parsed = normalizeState(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Missing/invalid local provider state falls back to loaded config.
  }
  return {
    default_model: cfg.agent.defaultModel,
    providers: providerConfigFromLoadedConfig(cfg),
    capabilities: providerConfigCapabilities(),
  };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function mergeLocalProviderConfig(
  existing: LocalCoreProviderConfigState,
  next: LocalCoreProviderConfigWrite,
): LocalCoreProviderConfigState {
  const entry = withoutUndefined({
    provider: next.provider,
    model: next.model.trim(),
    base_url: next.base_url?.trim() || undefined,
    api_key_secret_ref: next.api_key_secret_ref?.trim() || undefined,
    has_api_key: !!next.api_key_secret_ref?.trim(),
  }) as unknown as LocalCoreProviderConfig;
  const providers = existing.providers.filter((candidate) => candidate.provider !== next.provider);
  providers.push(entry);
  return {
    default_provider: next.provider,
    default_model: entry.model,
    providers,
    capabilities: providerConfigCapabilities(),
  };
}

export async function writeLocalProviderConfigState(state: LocalCoreProviderConfigState): Promise<void> {
  const filePath = localProviderConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const persisted = {
    default_provider: state.default_provider,
    default_model: state.default_model,
    providers: state.providers.map((provider) => withoutUndefined({
      provider: provider.provider,
      model: provider.model,
      base_url: provider.base_url,
      api_key_secret_ref: provider.api_key_secret_ref,
      has_api_key: provider.has_api_key === true || !!provider.api_key_secret_ref,
    })),
  };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function selectedProviderConfig(
  state: LocalCoreProviderConfigState,
  request: ProviderSecretResolutionRequest,
): LocalCoreProviderConfig | undefined {
  const provider = request.provider || state.default_provider;
  if (provider && SUPPORTED_PROVIDER_KINDS.has(provider as ProviderConfigKind)) {
    const byProvider = state.providers.find((candidate) => candidate.provider === provider);
    if (byProvider) return byProvider;
  }
  if (request.model) {
    const byModel = state.providers.find((candidate) => candidate.model === request.model);
    if (byModel) return byModel;
  }
  return state.default_provider ? state.providers.find((candidate) => candidate.provider === state.default_provider) : undefined;
}

export function resolveSecretRef(secretRef: string | undefined, request: ProviderSecretResolutionRequest): string | undefined {
  if (!secretRef) return undefined;
  if (secretRef.startsWith('env:')) {
    const envName = secretRef.slice('env:'.length);
    return envName ? process.env[envName] : undefined;
  }
  const secretValues = request.provider_secret_values ?? {};
  return secretValues[secretRef];
}

export async function applyLocalProviderConfigForRequest(
  cfg: ShizuhaConfig,
  request: ProviderSecretResolutionRequest,
): Promise<{ config: ShizuhaConfig; model: string; providerConfig?: LocalCoreProviderConfig }> {
  const state = await readLocalProviderConfigState(cfg);
  const providerConfig = selectedProviderConfig(state, request);
  if (!providerConfig) {
    return { config: cfg, model: request.model ?? cfg.agent.defaultModel, providerConfig: undefined };
  }

  const apiKey = resolveSecretRef(providerConfig.api_key_secret_ref, request);
  const model = request.model?.trim() || providerConfig.model || cfg.agent.defaultModel;
  const config: ShizuhaConfig = {
    ...cfg,
    agent: { ...cfg.agent, defaultModel: model },
    providers: { ...cfg.providers },
  };

  if (providerConfig.provider === 'cortex') {
    config.providers.cortex = {
      ...(cfg.providers.cortex ?? {}),
      ...(providerConfig.base_url ? { baseUrl: providerConfig.base_url } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  } else if (providerConfig.provider === 'anthropic') {
    config.providers.anthropic = {
      ...(cfg.providers.anthropic ?? {}),
      ...(providerConfig.base_url ? { baseUrl: providerConfig.base_url } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  } else if (providerConfig.provider === 'openai-compatible') {
    config.providers.openai = {
      ...(cfg.providers.openai ?? {}),
      ...(providerConfig.base_url ? { baseUrl: providerConfig.base_url } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }

  return { config, model, providerConfig };
}
