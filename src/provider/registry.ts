import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLMProvider } from './types.js';
import type { ShizuhaConfig } from '../config/types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { LlamaCppProvider } from './llamacpp.js';
import { VLlmProvider } from './vllm.js';
import { CodexProvider } from './codex.js';
import { OpenRouterProvider } from './openrouter.js';
import { CopilotProvider } from './copilot.js';
import { XaiProvider } from './xai.js';
import { GroqProvider } from './groq.js';
import { TogetherProvider } from './together.js';
import { readCredentials } from '../config/credentials.js';
import { readShizuhaAuth } from '../config/shizuhaAuth.js';

export const DEFAULT_CORTEX_BASE_URL = 'https://cortex.shizuha.com';
export const DEFAULT_CORTEX_MODEL = 'GLM-4.7';

/**
 * Clean model-id family prefixes served by the Cortex gateway. Kept in sync with
 * cortex `model_specs.yaml`; every new gateway-served family deploys through the
 * CTX-57 gate (aoi), which enforces coverage here. Longer-term this should
 * consult the cortex provider's discovered `/models` list instead of a static
 * prefix set, so a new family can't silently fall through (CTX-67 rider).
 */
const CORTEX_MODEL_FAMILY_PREFIXES = [
  'glm-',      // GLM (GLM-4.7, GLM-4.9, ...)
  'chatglm',   // ChatGLM variants
  'qwen',      // Qwen (Qwen3.6-27B, Qwen3-7B, ...)
  'gpt-oss',   // gpt-oss-120b
  'minimax',   // MiniMax-M2.7
  'deepseek',  // DeepSeek-V3.2
  'grok-',     // Grok via managed Cortex xAI provider (prefer cortex over direct XAI_API_KEY)
];

/**
 * Returns true if the model ID routes to the Cortex gateway — either via the
 * legacy `cortex/` routing prefix (still accepted during migration) or a clean
 * model ID from a gateway-served family (see CORTEX_MODEL_FAMILY_PREFIXES).
 *
 * Also matches Cortex *vendor-prefixed offer ids* such as `xai/grok-4.5` (managed
 * SuperGrok path). Those must NOT be treated as SCLI `provider/model` routing
 * (which would strip `xai/` and miss the Cortex key, then fall through to Ollama).
 *
 * Used by compaction, context-budget, tool-search, and the daemon manager to
 * detect cortex/local models without holding a registry instance. A bare ID
 * from an uncovered family would otherwise fall through to the ollama default,
 * so the family list above must track the gateway's served set (CTX-67).
 */
export function isCortexModelId(model: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (lower.startsWith('cortex/')) return true; // legacy prefix — still routes during transition
  // Cortex managed-xAI offer aliases keep the vendor/model shape as the model id.
  if (lower.startsWith('xai/grok-')) return true;
  return CORTEX_MODEL_FAMILY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveCortexBaseUrl(config?: ShizuhaConfig): string {
  // SCLI-86: stored baseUrl (credentials.json) sits below env/TOML, above the default.
  return nonEmptyEnv('CORTEX_BASE_URL')
    ?? config?.providers.cortex?.baseUrl
    ?? readCredentials().cortex?.baseUrl
    ?? DEFAULT_CORTEX_BASE_URL;
}

export function resolveCortexAuthToken(config?: ShizuhaConfig): string | undefined {
  // Prefer the signed-in Shizuha identity for interactive Cortex usage: staff
  // and owner accounts carry their service tier in the JWT. A generic
  // CORTEX_API_KEY may be a lower-tier client key and should not silently
  // downgrade a logged-in operator. Service environments can force API-key auth
  // with SHIZUHA_CORTEX_AUTH_MODE=api_key.
  //
  // Always re-read on each call: login JWTs are ~1h and auto-refresh rewrites
  // auth.json; callers (VLlmProvider) must not freeze a one-shot resolve.
  // ...but an AGENT must never borrow the human's identity. A gateway running
  // on the operator's host reads the same ~/.shizuha/auth.json, so a stopped
  // agent's respawning gateway billed its 220K-token prewarms to the operator's
  // personal uid-3 JWT and showed up as an unattributable "standard" row on the
  // Usage page (operator 2026-08-06: "i haven't touched the tmux session for
  // hours .. so i don't think that's me"). Same directive as the shared
  // fleet-key fix: every agent uses its OWN Cortex account.
  if (isAgentRuntime()) {
    return nonEmptyEnv('CORTEX_API_KEY')
      ?? nonEmptyEnv('CORTEX_API_KEY_SHARED_FALLBACK')
      ?? config?.providers.cortex?.apiKey
      ?? readCredentials().cortex?.apiKey
      ?? nonEmptyEnv('CORTEX_OAUTH_TOKEN');
  }
  return nonEmptyEnv('CORTEX_OAUTH_TOKEN')
    ?? freshShizuhaAccessToken()
    ?? nonEmptyEnv('CORTEX_API_KEY')
    ?? nonEmptyEnv('CORTEX_API_KEY_SHARED_FALLBACK')
    ?? config?.providers.cortex?.apiKey
    ?? readCredentials().cortex?.apiKey;
}

/** 10 min skew — match shizuhaAuth ACCESS_EXPIRY_SKEW so we fall back to the
 *  API key before Cortex rejects the JWT with "Signature has expired". */
const CORTEX_JWT_EXPIRY_SKEW_MS = 10 * 60_000;

/** Whether this process serves a fleet AGENT rather than an interactive human.
 *
 * Agent gateways are spawned with the agent's identity in env; a TUI/exec run
 * by a person has none. Deliberately env-based, not argv-based: the daemon,
 * bridges, and the gateway all set these, and argv shapes vary per launcher.
 */
function isAgentRuntime(): boolean {
  // ARGV first: every gateway launcher (daemon host spawn, k3s pod entrypoint,
  // bridges) passes `--agent-id`, whereas the agent env vars are inconsistent —
  // SHIZUHA_AGENT_USERNAME is absent in live fleet pods, so an env-only check
  // would silently keep borrowing the human JWT on the host.
  const argv = process.argv.slice(1);
  if (argv.some((a) => a === '--agent-id' || a.startsWith('--agent-id='))) return true;
  if (argv.includes('gateway')) return true;
  return Boolean(
    nonEmptyEnv('SHIZUHA_AGENT_USERNAME')
    ?? nonEmptyEnv('SHIZUHA_AGENT_ID')
    ?? nonEmptyEnv('SHIZUHA_K8S_PRIMARY_MODEL'),
  );
}

function freshShizuhaAccessToken(): string | undefined {
  if (nonEmptyEnv('SHIZUHA_CORTEX_AUTH_MODE')?.toLowerCase() === 'api_key') {
    return undefined;
  }
  const auth = readShizuhaAuth();
  if (!auth?.accessToken) return undefined;
  if (jwtAlg(auth.accessToken) !== 'RS256') return undefined;
  // Prefer the JWT `exp` claim (source of truth for Cortex RS256 validation).
  // Metadata accessTokenExpiresAt can lag or be missing — that previously let
  // an already-expired token keep being sent (401 Signature has expired).
  const jwtExpMs = jwtExpMsFromToken(auth.accessToken);
  const metaExpMs = Date.parse(auth.accessTokenExpiresAt ?? '');
  const expiresAt = Number.isFinite(jwtExpMs)
    ? jwtExpMs!
    : (Number.isFinite(metaExpMs) ? metaExpMs : NaN);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + CORTEX_JWT_EXPIRY_SKEW_MS) {
    return undefined; // fall through to sk-cortex API key
  }
  // No usable expiry → do not risk sending a possibly-dead JWT.
  if (!Number.isFinite(expiresAt)) return undefined;
  return auth.accessToken;
}

function jwtAlg(token: string): string | undefined {
  const [header] = token.split('.');
  if (!header) return undefined;
  try {
    const normalized = header.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as { alg?: unknown };
    return typeof parsed.alg === 'string' ? parsed.alg : undefined;
  } catch {
    return undefined;
  }
}

function jwtExpMsFromToken(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const normalized = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as { exp?: unknown };
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp)
      ? parsed.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/** Check if we have a real OpenAI API key (not OAuth token) */
function hasOpenAIApiKey(config: ShizuhaConfig): boolean {
  return !!(config.providers.openai?.apiKey || process.env['OPENAI_API_KEY'] || readCredentials().openai?.apiKey);
}

export function resolveOpenAIBaseUrl(config?: ShizuhaConfig): string | undefined {
  return nonEmptyEnv('OPENAI_BASE_URL')
    ?? config?.providers.openai?.baseUrl?.trim()
    ?? readCredentials().openai?.baseUrl?.trim();
}

function hasCustomOpenAIEndpoint(config?: ShizuhaConfig): boolean {
  return !!resolveOpenAIBaseUrl(config);
}

/**
 * Detect Copilot-format Claude model names (use dots for versions).
 * Examples: claude-opus-4.6, claude-sonnet-4.5, claude-haiku-4.5
 * Native Anthropic format uses hyphens: claude-opus-4-20250514
 */
function isCopilotClaudeModel(model: string): boolean {
  return /^claude-\w+-\d+\.\d+/.test(model);
}

/** Map of model name prefixes to provider names */
const MODEL_PREFIX_MAP: Array<[string, string]> = [
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['codex-', 'openai'],
  ['gemini-', 'google'],
  ['mistral-', 'mistral'],
  ['codestral-', 'mistral'],
  ['pixtral-', 'mistral'],
  ['grok-', 'xai'],
  ['deepseek-', 'deepseek'],
];

/**
 * The universe of provider names this runtime knows how to build, including
 * ones that may not be configured in the current environment. Used by the
 * explicit `provider:model` override (SCLI-23) to decide whether a colon-prefix
 * is a provider routing directive or merely part of a model name (e.g. Ollama's
 * `model:tag` syntax such as `llama3.1:8b`). A prefix in this set is treated as
 * an explicit provider; anything else falls through to implicit resolution.
 */
const KNOWN_PROVIDER_NAMES = new Set<string>([
  'anthropic', 'openai', 'google', 'openrouter', 'ollama', 'llamacpp', 'vllm',
  'codex', 'copilot', 'cortex', 'litellm', 'deepseek', 'mistral', 'xai',
  'groq', 'together',
]);

/** Short model aliases used by shizuha-agent platform */
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-5',
  'opus-5': 'claude-opus-5',
  'opus-4.8': 'claude-opus-4-8',
  'opus-4.7': 'claude-opus-4-7',
  'opus-4.5': 'claude-opus-4-5-20251101',
  'fable': 'claude-fable-5',
  'sonnet': 'claude-sonnet-4-6',
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'haiku': 'claude-haiku-4-5-20251001',
};

/** Normalize a model name by resolving short aliases. */
export function normalizeModelName(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

/** Models known to be Ollama (or fallback for unknown models) */
const OLLAMA_MODELS = new Set([
  'qwen3-coder-next',
  'qwen3.5',
  'llama3.1',
]);

/** Explicit local provider prefixes that must never silently fall through to Ollama/OpenRouter. */
const STRICT_EXPLICIT_PROVIDER_HINTS: Record<string, string> = {
  vllm:
    'vLLM model selected, but the vLLM provider is not configured.\n' +
    'Set VLLM_BASE_URL (for container agents, use http://host.docker.internal:<port>, not localhost).',
  ollama:
    'Ollama model selected, but Ollama is not reachable/configured.\n' +
    'Start Ollama or select a different provider-backed model.',
  llamacpp:
    'llama.cpp model selected, but LLAMACPP_BASE_URL is not configured.',
  cortex:
    'Cortex model selected, but the built-in Cortex provider is unavailable.\n' +
    'Set CORTEX_BASE_URL to override the hosted endpoint, or CORTEX_API_KEY/CORTEX_OAUTH_TOKEN if your deployment requires auth.',
  codex:
    'Codex model selected, but Codex is not authenticated. Run: shizuha auth codex',
  copilot:
    'Copilot model selected, but GitHub Copilot is not configured.',
};

/** OpenAI-compatible providers with no dedicated class: env var → [base URL, provider name].
 *  xAI (Grok), Groq, and Together now have dedicated provider classes (correct
 *  context windows + Groq tool-call quirk handling) and are registered separately. */
const OPENAI_COMPATIBLE_PROVIDERS: Array<[string, string, string]> = [
  // OpenRouter has its own dedicated provider class (OpenRouterProvider) — not listed here.
  ['DEEPSEEK_API_KEY',   'https://api.deepseek.com',     'deepseek'],
  ['MISTRAL_API_KEY',    'https://api.mistral.ai/v1',    'mistral'],
];

/** Check if we have an Anthropic API key (regular, not OAuth) */
function hasAnthropicApiKey(config: ShizuhaConfig): boolean {
  return !!(config.providers.anthropic?.apiKey || process.env['ANTHROPIC_API_KEY']);
}

/** Check if we have a Google API key */
function hasGoogleApiKey(config: ShizuhaConfig): boolean {
  return !!(config.providers.google?.apiKey || process.env['GOOGLE_API_KEY']);
}

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private lastConfig: ShizuhaConfig;
  private pluginProviders = new Map<string, LLMProvider>();

  constructor(config: ShizuhaConfig) {
    this.lastConfig = config;
    this.buildProviders(config);
  }

  /** Reinitialize providers (e.g. after adding credentials). */
  reinitialize(config?: ShizuhaConfig): void {
    const cfg = config ?? this.lastConfig;
    this.lastConfig = cfg;
    this.providers.clear();
    this.buildProviders(cfg);
  }

  /**
   * Merge LLM providers registered by plugins.
   * Plugin providers override built-in providers if they register under
   * the same name (e.g. a plugin registering 'anthropic' overrides the
   * built-in AnthropicProvider). Called after plugins are loaded.
   */
  mergePluginProviders(providers: Map<string, LLMProvider>): void {
    this.pluginProviders = providers;
    for (const [name, provider] of providers) {
      this.providers.set(name, provider);
    }
  }

  private buildProviders(config: ShizuhaConfig): void {
    const pc = config.providers;
    const creds = readCredentials();

    // Anthropic provider: uses API key if available.
    // Claude Code OAuth provider is no longer built-in — install it as a plugin:
    //   ~/.shizuha/plugins/provider-claude-code/
    // The plugin registers as both 'claude-code' and 'anthropic', overriding this.
    if (pc.anthropic?.apiKey || process.env['ANTHROPIC_API_KEY']) {
      this.providers.set('anthropic', new AnthropicProvider(pc.anthropic?.apiKey, pc.anthropic?.baseUrl));
    }

    // GitHub Copilot: access Claude/GPT models via Copilot Pro+ subscription.
    // Uses GitHub PAT to exchange for short-lived Copilot API tokens.
    // Takes priority over LiteLLM for Copilot-format models (direct, no proxy needed).
    const copilotToken = process.env['GITHUB_COPILOT_TOKEN'] ?? creds.copilot?.githubToken;
    if (copilotToken) {
      this.providers.set('copilot', new CopilotProvider(copilotToken));
    }

    // LiteLLM proxy: exposes OpenAI-compatible /v1/chat/completions for any model
    // (GitHub Copilot Claude, Gemini, etc.). Registered separately so it can coexist
    // with native providers. Copilot-format claude models (claude-opus-4.6) route here
    // only if no native Copilot provider is configured.
    if (process.env['LITELLM_PROXY_URL']) {
      const proxyUrl = process.env['LITELLM_PROXY_URL'].replace(/\/+$/, '');
      const baseUrl = proxyUrl.endsWith('/v1') ? proxyUrl : proxyUrl + '/v1';
      const litellm = new OpenAIProvider('sk-litellm', baseUrl);
      litellm.name = 'litellm';
      litellm.enablePromptCaching = true; // LiteLLM forwards cache_control to Anthropic
      this.providers.set('litellm', litellm);
      // If no native anthropic provider is configured, also register as fallback
      if (!this.providers.has('anthropic')) {
        this.providers.set('anthropic', litellm);
      }
    }

    // OpenAI provider: API key and/or a custom OpenAI-compatible base URL
    // (Ollama / vLLM / llama.cpp often need no real key).
    const openaiBaseUrl = resolveOpenAIBaseUrl(config);
    const openaiKey = pc.openai?.apiKey
      || nonEmptyEnv('OPENAI_API_KEY')
      || creds.openai?.apiKey;
    if (openaiKey || openaiBaseUrl) {
      this.providers.set('openai', new OpenAIProvider(openaiKey || 'local', openaiBaseUrl));
    }

    // Codex provider: ChatGPT OAuth via Responses API (chatgpt.com/backend-api/codex)
    // Uses device auth flow — credentials stored in ~/.shizuha/credentials.json
    const codexProvider = CodexProvider.create();
    if (codexProvider) {
      this.providers.set('codex', codexProvider);
      // If no OpenAI API key, also register codex as the 'openai' provider
      // so gpt-* model resolution works
      if (!hasOpenAIApiKey(config) && !this.providers.has('openai')) {
        this.providers.set('openai', codexProvider);
      }
    }

    if (pc.google?.apiKey || process.env['GOOGLE_API_KEY']) {
      this.providers.set('google', new GoogleProvider(pc.google?.apiKey));
    } else if (creds.google?.apiKey) {
      // Credential store fallback
      this.providers.set('google', new GoogleProvider(creds.google.apiKey));
    }

    // OpenRouter: first-class provider with proper headers (X-Title, HTTP-Referer).
    // Supports config-based API key or OPENROUTER_API_KEY env var.
    const orKey = pc.openrouter?.apiKey ?? process.env['OPENROUTER_API_KEY'];
    if (orKey) {
      this.providers.set('openrouter', new OpenRouterProvider(orKey, pc.openrouter?.appName, pc.openrouter?.siteUrl));
    }

    // Dedicated OpenAI-compatible provider classes (correct baseURL + per-model
    // context windows; Groq adds tool-call quirk handling). Register when the
    // provider's API key env var is set.
    if (process.env['XAI_API_KEY']) {
      this.providers.set('xai', new XaiProvider(process.env['XAI_API_KEY']));
    }
    if (process.env['GROQ_API_KEY']) {
      this.providers.set('groq', new GroqProvider(process.env['GROQ_API_KEY']));
    }
    if (process.env['TOGETHER_API_KEY']) {
      this.providers.set('together', new TogetherProvider(process.env['TOGETHER_API_KEY']));
    }

    // Remaining OpenAI-compatible providers with no dedicated class (DeepSeek, Mistral).
    // Each registers if its API key env var is set.
    for (const [envVar, baseUrl, name] of OPENAI_COMPATIBLE_PROVIDERS) {
      const apiKey = process.env[envVar];
      if (apiKey) {
        this.providers.set(name, new OpenAIProvider(apiKey, baseUrl));
      }
    }

    // llama.cpp server (on-device or local, uses OpenAI-compatible API)
    const llamacppUrl = process.env['LLAMACPP_BASE_URL'];
    if (llamacppUrl) {
      this.providers.set('llamacpp', new LlamaCppProvider(llamacppUrl));
    }

    // vLLM server (DGX Spark / GPU servers, NVFP4-quantized models)
    const vllmUrl = process.env['VLLM_BASE_URL'] ?? pc.vllm?.baseUrl;
    if (vllmUrl) {
      this.providers.set('vllm', new VLlmProvider(vllmUrl, undefined, process.env['VLLM_API_KEY'] ?? pc.vllm?.apiKey));
    }

    // Shizuha Cortex — our own OpenAI-compatible inference gateway (GLM-4.7 etc.),
    // a first-class provider alongside OpenAI/Anthropic. Routed via the `cortex/` prefix.
    const cortexUrl = resolveCortexBaseUrl(config);
    // Cortex fronts a vLLM backend (GLM-4.7), so use VLlmProvider — it has the correct
    // GLM reasoning + glm47 tool-call handling. The generic OpenAIProvider mis-parses
    // GLM-4.7 responses (captures only `reasoning`, drops content/tool_calls). VLlmProvider
    // appends /v1 itself, so strip a trailing /v1 from the configured base.
    const cortexBase = cortexUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    // Resolver (not a frozen string): re-read JWT/API key on every request so
    // auto-refresh + sk-cortex fallback work after the ~1h login JWT expires.
    // forceRefreshKey: on 401 "Signature has expired" (RS256 key rotation),
    // force a token refresh and retry with the fresh JWT.
    this.providers.set(
      'cortex',
      new VLlmProvider(
        cortexBase,
        undefined,
        () => resolveCortexAuthToken(config),
        'cortex',
        async () => {
          const { forceRefreshShizuhaAccessToken } = await import('../config/shizuhaAuth.js');
          const fresh = await forceRefreshShizuhaAccessToken();
          return fresh ?? undefined;
        },
      ),
    );

    // Ollama is always available (local)
    this.providers.set('ollama', new OllamaProvider(pc.ollama?.baseUrl));
  }

  /** Resolve `auto` to the best available model based on configured providers. */
  resolveAutoModel(): string {
    const creds = readCredentials();
    const customOpenAI = hasCustomOpenAIEndpoint(this.lastConfig);
    // A user who pointed us at a local/custom endpoint wins over hosted defaults.
    if (this.providers.has('vllm')) {
      return creds.openai?.defaultModel || 'default';
    }
    if (customOpenAI && this.providers.has('openai')) {
      return creds.openai?.defaultModel
        ? `openai:${creds.openai.defaultModel}`
        : 'openai:default';
    }
    // Prefer Codex first (self-contained, auto-refreshable, free with ChatGPT).
    // Claude Code OAuth is fragile (expires, requires Claude Code running).
    if (this.providers.has('codex')) return 'gpt-5.5';
    if (this.providers.has('anthropic')) return 'claude-sonnet-4-6';
    if (this.providers.has('claude-code')) return 'claude-sonnet-4-6';
    if (this.providers.has('openai')) return 'gpt-4.1';
    if (this.providers.has('google')) return 'gemini-2.5-pro';
    // No cloud provider — stay on local Ollama rather than failing into Codex.
    if (this.providers.has('ollama')) return 'llama3.2';
    return 'gpt-5.5';
  }

  /** Check if any cloud provider (non-Ollama) is configured and ready. */
  hasCloudProvider(): boolean {
    for (const [name] of this.providers) {
      if (name !== 'ollama') return true;
    }
    return false;
  }

  /** Resolve a model name to its provider.
   *
   * Supports explicit routing via `provider/model` syntax:
   *   groq/llama-3.1-70b → groq provider, model = llama-3.1-70b
   *   openrouter/anthropic/claude-3-opus → openrouter provider
   *   together/meta-llama/Llama-3.1-70B → together provider
   */
  resolve(model: string): LLMProvider {
    return this.resolveWithModel(model).provider;
  }

  /** Resolve a model name to its provider AND the canonical model name.
   *  Use this when you need to know what `auto` resolved to. */
  resolveWithModel(model: string): { provider: LLMProvider; resolvedModel: string } {
    // Handle "auto" — pick best available provider/model
    if (model === 'auto') {
      model = this.resolveAutoModel();
    }

    // Resolve short aliases (e.g., "opus" → "claude-opus-4-7")
    model = MODEL_ALIASES[model] ?? model;

    // Explicit `provider:model` override (SCLI-23) — deterministic routing that
    // bypasses every implicit heuristic below. This is what lets the SAME model
    // name be pinned to a specific provider, e.g. `anthropic:claude-opus-4.6`
    // (native Anthropic API) vs `copilot:claude-opus-4.6` (GitHub Copilot).
    //
    // Split on the FIRST colon. The prefix is an explicit provider override ONLY
    // when it names a known provider — this avoids colliding with Ollama's
    // `model:tag` syntax (`llama3.1:8b`), where the segment before the colon is a
    // model. An unknown prefix therefore falls through to implicit resolution
    // (so bare Ollama tags keep working; `ollama:llama3.1:8b` routes explicitly).
    const colonIdx = model.indexOf(':');
    if (colonIdx > 0 && KNOWN_PROVIDER_NAMES.has(model.slice(0, colonIdx))) {
      const providerName = model.slice(0, colonIdx);
      const rawModel = model.slice(colonIdx + 1).trim();
      if (!rawModel) {
        throw new Error(
          `No model specified after "${providerName}:". ` +
          `Use the form "${providerName}:<model>", e.g. "${providerName}:claude-opus-4-7".`,
        );
      }
      const resolvedModel = MODEL_ALIASES[rawModel] ?? rawModel;
      const provider = this.providers.get(providerName);
      if (provider) return { provider, resolvedModel };
      // Recognized provider name, but not configured/available in this environment.
      const hint = STRICT_EXPLICIT_PROVIDER_HINTS[providerName];
      const configured = this.list();
      throw new Error(
        `Provider "${providerName}" is not configured/available.` +
        (hint ? `\n${hint}` : '') +
        `\nConfigured providers: ${configured.length ? configured.join(', ') : '(none)'}.`,
      );
    }

    // Managed Grok offer ids from Cortex look like `xai/grok-4.5`. That MUST be
    // handled before generic slash `provider/model` routing: otherwise `xai/…`
    // is treated as "use the xai provider", and without XAI_API_KEY the resolver
    // falls through to Ollama (`ollama pull xai/grok-4.5`). Keep the full offer
    // id (do not strip `xai/`) — Cortex routes on the offer slug. Prefer Cortex
    // over a console XAI_API_KEY; force direct xAI with `xai:grok-4.5`.
    if (model.toLowerCase().startsWith('xai/grok-')) {
      const cortex = this.providers.get('cortex');
      if (cortex) return { provider: cortex, resolvedModel: model };
    }

    // Explicit provider/model syntax: first segment before '/' is the provider name
    // (only if that segment matches a registered provider)
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      const prefix = model.slice(0, slashIdx);
      const provider = this.providers.get(prefix);
      if (provider) return { provider, resolvedModel: model.slice(slashIdx + 1) };
      const strictHint = STRICT_EXPLICIT_PROVIDER_HINTS[prefix];
      if (strictHint) {
        throw new Error(strictHint);
      }
      // SCLI-384: fake/unknown provider prefixes must fail closed with an
      // actionable /model hint — never hand `definitely-not-a-real-provider/…`
      // to OpenRouter (4xx → indefinite TUI retry). OpenRouter org/model ids
      // often reuse vendor names (`anthropic/…`, `deepseek/…`) even when that
      // native provider is not configured — those MUST still route to
      // openrouter when available (do NOT gate on KNOWN_PROVIDER_NAMES).
      const looksLikeOpenRouterOrg = /^[a-z][a-z0-9_-]{0,32}$/i.test(prefix);
      const looksLikeFakeProvider =
        /provider|missing|invalid|fake|definitely|not-a-real/i.test(prefix)
        || prefix.length > 40;
      const openrouter = this.providers.get('openrouter');
      if (openrouter && looksLikeOpenRouterOrg && !looksLikeFakeProvider) {
        return { provider: openrouter, resolvedModel: model };
      }
      const configured = this.list();
      throw new Error(
        `Unknown provider "${prefix}" in model "${model}". `
        + `Use /model to pick a configured provider/model, or relaunch with a valid --model.`
        + `\nConfigured providers: ${configured.length ? configured.join(', ') : '(none)'}.`,
      );
    }

    // Copilot-format Claude models (claude-opus-4.6, claude-sonnet-4.5, etc.)
    // Route through: Copilot provider (direct) > LiteLLM proxy > error.
    // Native Anthropic API doesn't recognize dot-version model names.
    if (model.startsWith('claude-') && isCopilotClaudeModel(model)) {
      const copilot = this.providers.get('copilot');
      if (copilot) return { provider: copilot, resolvedModel: model };
      const litellm = this.providers.get('litellm');
      if (litellm) return { provider: litellm, resolvedModel: model };
      throw new Error(
        `No provider configured for Copilot-format model "${model}".\n` +
        `Set up GitHub Copilot in Settings → Providers (requires Copilot Pro+ subscription),\n` +
        `or start a LiteLLM proxy with LITELLM_PROXY_URL.`,
      );
    }

    // ChatGPT Responses API models route to codex provider when available.
    // This includes: gpt-5.x (all variants) and gpt-oss-*.
    // These use chatgpt.com/backend-api/codex, NOT OpenAI Chat Completions.
    // gpt-4.x models (gpt-4.1, gpt-4o, etc.) are standard OpenAI API models.
    // codex-mini-latest is also a standard OpenAI model.
    if (model.startsWith('gpt-5') || model.startsWith('gpt-oss-')) {
      if (this.providers.has('codex')) {
        return { provider: this.providers.get('codex')!, resolvedModel: model };
      }
      throw new Error(
        `Codex not authenticated. Run: shizuha auth codex\n` +
        `(Free with any ChatGPT account — uses gpt-5.5)`,
      );
    }

    // Check known Ollama models
    for (const ollamaModel of OLLAMA_MODELS) {
      if (model.startsWith(ollamaModel)) {
        const provider = this.providers.get('ollama');
        if (provider) return { provider, resolvedModel: model };
      }
    }

    // CTX-67: clean cortex model IDs (GLM-4.7, Qwen3.6-27B, DeepSeek-V4-Flash,
    // grok-4.5) route to the Cortex gateway without a prefix. Keep this before
    // generic provider prefix routing so a DEEPSEEK_API_KEY cannot steal our
    // hosted DeepSeek deployment, but after explicit Ollama model IDs.
    if (isCortexModelId(model)) {
      const wantsCortexPrefix = model.toLowerCase().startsWith('cortex/');
      const cortexAuth = resolveCortexAuthToken(this.lastConfig);
      const localCompat = this.providers.has('vllm')
        ? this.providers.get('vllm')
        : (hasCustomOpenAIEndpoint(this.lastConfig) ? this.providers.get('openai') : undefined);
      if ((cortexAuth || wantsCortexPrefix || !localCompat)) {
        const cortex = this.providers.get('cortex');
        if (cortex) {
          const resolvedModel = wantsCortexPrefix
            ? model.slice('cortex/'.length)
            : model;
          return { provider: cortex, resolvedModel };
        }
      }
      if (localCompat && !wantsCortexPrefix) {
        return { provider: localCompat, resolvedModel: model };
      }
    }

    // Check prefix map
    for (const [prefix, providerName] of MODEL_PREFIX_MAP) {
      if (model.startsWith(prefix)) {
        const provider = this.providers.get(providerName);
        if (provider) return { provider, resolvedModel: model };
        if (providerName === 'anthropic') {
          throw new Error(
            `Claude model requires authentication. Either:\n` +
            `  • Run: shizuha auth claude <token>  (get token from 'claude setup-token')\n` +
            `  • Set ANTHROPIC_API_KEY for direct API access\n` +
            `  • Open the dashboard and use the Claude auth card`,
          );
        }
        throw new Error(`Provider "${providerName}" not configured for model "${model}". Set ${providerName === 'openai' ? 'OPENAI_API_KEY' : providerName === 'google' ? 'GOOGLE_API_KEY' : providerName.toUpperCase() + '_API_KEY'}.`);
      }
    }

    // Default: assume it's an Ollama model (local)
    const ollama = this.providers.get('ollama');
    if (ollama) return { provider: ollama, resolvedModel: model };

    throw new Error(`No provider found for model "${model}"`);
  }

  /** Get a provider by name */
  get(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /** List available provider names */
  list(): string[] {
    return [...this.providers.keys()];
  }
}
