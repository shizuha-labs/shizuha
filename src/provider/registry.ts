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
import { readCredentials } from '../config/credentials.js';

/** Check if we have a real OpenAI API key (not OAuth token) */
function hasOpenAIApiKey(config: ShizuhaConfig): boolean {
  return !!(config.providers.openai?.apiKey || process.env['OPENAI_API_KEY']);
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

/** Short model aliases used by shizuha-agent platform */
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'opus-4.5': 'claude-opus-4-20250514',
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

/** OpenAI-compatible providers: env var → [base URL, provider name] */
const OPENAI_COMPATIBLE_PROVIDERS: Array<[string, string, string]> = [
  // OpenRouter has its own dedicated provider class (OpenRouterProvider) — not listed here.
  ['DEEPSEEK_API_KEY',   'https://api.deepseek.com',     'deepseek'],
  ['MISTRAL_API_KEY',    'https://api.mistral.ai/v1',    'mistral'],
  ['XAI_API_KEY',        'https://api.x.ai/v1',          'xai'],
  ['GROQ_API_KEY',       'https://api.groq.com/openai/v1', 'groq'],
  ['TOGETHER_API_KEY',   'https://api.together.xyz/v1',  'together'],
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
      this.providers.set('litellm', new OpenAIProvider('sk-litellm', baseUrl));
      // If no native anthropic provider is configured, also register as fallback
      if (!this.providers.has('anthropic')) {
        this.providers.set('anthropic', this.providers.get('litellm')!);
      }
    }

    // OpenAI provider: use API key if available
    if (hasOpenAIApiKey(config)) {
      this.providers.set('openai', new OpenAIProvider(pc.openai?.apiKey, pc.openai?.baseUrl));
    } else if (creds.openai?.apiKey) {
      // Credential store fallback
      this.providers.set('openai', new OpenAIProvider(creds.openai.apiKey));
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

    // OpenAI-compatible providers (DeepSeek, Mistral, xAI, Groq, Together)
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

    // Ollama is always available (local)
    this.providers.set('ollama', new OllamaProvider(pc.ollama?.baseUrl));
  }

  /** Resolve `auto` to the best available model based on configured providers. */
  resolveAutoModel(): string {
    // Prefer Codex first (self-contained, auto-refreshable, free with ChatGPT).
    // Claude Code OAuth is fragile (expires, requires Claude Code running).
    if (this.providers.has('codex')) return 'gpt-5.3-codex-spark';
    if (this.providers.has('anthropic')) return 'claude-sonnet-4-6';
    if (this.providers.has('claude-code')) return 'claude-sonnet-4-6';
    if (this.providers.has('openai')) return 'gpt-4.1';
    if (this.providers.has('google')) return 'gemini-2.5-pro';
    // No cloud provider configured — default to Codex (free with ChatGPT account).
    // This will fail at message time with a helpful setup prompt.
    return 'gpt-5.3-codex-spark';
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

    // Resolve short aliases (e.g., "opus" → "claude-opus-4-6")
    model = MODEL_ALIASES[model] ?? model;

    // Explicit provider/model syntax: first segment before '/' is the provider name
    // (only if that segment matches a registered provider)
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      const prefix = model.slice(0, slashIdx);
      const provider = this.providers.get(prefix);
      if (provider) return { provider, resolvedModel: model };
      // Not a known provider prefix — might be an OpenRouter-style model ID
      // (e.g., "anthropic/claude-3-opus"). Route to openrouter if available.
      const openrouter = this.providers.get('openrouter');
      if (openrouter) return { provider: openrouter, resolvedModel: model };
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
    // This includes: gpt-5.x (all variants), gpt-oss-*, and gpt-5.3-xhigh.
    // These use chatgpt.com/backend-api/codex, NOT OpenAI Chat Completions.
    // gpt-4.x models (gpt-4.1, gpt-4o, etc.) are standard OpenAI API models.
    // codex-mini-latest is also a standard OpenAI model.
    if (model.startsWith('gpt-5') || model.startsWith('gpt-oss-')) {
      if (this.providers.has('codex')) {
        return { provider: this.providers.get('codex')!, resolvedModel: model };
      }
      throw new Error(
        `Codex not authenticated. Run: shizuha auth codex\n` +
        `(Free with any ChatGPT account — uses gpt-5.3-codex-spark)`,
      );
    }

    // Check prefix map
    for (const [prefix, providerName] of MODEL_PREFIX_MAP) {
      if (model.startsWith(prefix)) {
        const provider = this.providers.get(providerName);
        if (provider) return { provider, resolvedModel: model };
        throw new Error(`Provider "${providerName}" not configured for model "${model}". Set ${providerName === 'anthropic' ? 'ANTHROPIC_API_KEY' : providerName === 'openai' ? 'OPENAI_API_KEY' : providerName === 'google' ? 'GOOGLE_API_KEY' : providerName.toUpperCase() + '_API_KEY'}.`);
      }
    }

    // Check known Ollama models
    for (const ollamaModel of OLLAMA_MODELS) {
      if (model.startsWith(ollamaModel)) {
        const provider = this.providers.get('ollama');
        if (provider) return { provider, resolvedModel: model };
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
