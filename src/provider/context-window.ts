/**
 * Context-window resolution for compaction thresholds and status display.
 *
 * Precedence (primary → fallback):
 *   1. The provider's own maxContextWindow — for self-hosted backends (vLLM,
 *      llama.cpp) this is AUTO-DISCOVERED from the live server (e.g. vLLM's
 *      /v1/models max_model_len); for cloud providers it's the provider's own
 *      per-model value. This is authoritative and always preferred when present.
 *   2. MODEL_CONTEXT_WINDOW_DEFAULTS[model] — a hardcoded best-guess used only
 *      when the provider could not supply a value (e.g. discovery not yet run).
 *   3. GENERIC_CONTEXT_WINDOW_DEFAULT — last-resort floor.
 *
 * These hardcoded values are DEFAULTS / GUESSES, not overrides — auto-discovery
 * leads. Each provider also keeps its own per-model table, so this table is a
 * thin safety net for the rare case a provider reports nothing.
 */
const MODEL_CONTEXT_WINDOW_DEFAULTS: Record<string, number> = {
  // Anthropic (native + Copilot/LiteLLM slugs)
  'claude-opus-4-20250514': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-haiku-4-20250514': 200000,
  'claude-opus-4.7': 1000000,
  'claude-opus-4.6': 1000000,
  'claude-opus-4.6-fast': 1000000,
  'claude-opus-4.5': 1000000,
  'claude-opus-5': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-4.6': 1000000, // Sonnet 4.x — 1M via long-context beta (operator 2026-06-24)
  'claude-sonnet-4.5': 1000000,
  'claude-sonnet-4': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-haiku-4.5': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4-5-20251001': 200000,

  // OpenAI / Codex (ChatGPT backend + Cortex-managed openai-codex offers).
  // Live Codex app-server models.json uses 272k for gpt-5.x / *-codex* family.
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1047576,
  'gpt-4.1-mini': 1047576,
  'gpt-4.1-nano': 1047576,
  'gpt-5': 272000,
  'gpt-5-codex': 272000,
  'gpt-5-codex-mini': 272000,
  'gpt-5.1': 272000,
  'gpt-5.1-codex': 272000,
  'gpt-5.1-codex-max': 272000,
  'gpt-5.1-codex-mini': 272000,
  'gpt-5.2': 272000,
  'gpt-5.2-codex': 272000,
  'gpt-5.3-codex': 272000,
  'gpt-5.3-codex-spark': 272000,
  'gpt-5.5': 272000,
  'gpt-5.6-sol': 272000,
  'codex-mini-latest': 192000,
  'o3-mini': 200000,
  'o4-mini': 200000,

  // Google
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,

  // DeepSeek — live deepseek-v4-flash-i6 serves 524288; /v1/models discovery wins.
  'DeepSeek-V4-Flash': 524288,
  'deepseek-chat': 65536,
  'deepseek-coder': 65536,
  'deepseek-reasoner': 65536,

  // Cortex Qwen deployments. Live provider discovery from /v1/models still
  // wins; these are first-turn fallbacks when discovery has not completed yet.
  'Qwen3.6-27B-NVFP4': 262144,
  'Qwen3.6-27B-FP8': 262144,
  'Qwen3.6-27B': 262144,
  'Qwen3.6-35B-A3B-NVFP4': 262144,
  'Qwen3.6-35B-A3B-8bit-MLX': 262144,
  'Qwen3.6-35B-A3B': 262144,

  // Cortex GLM-5.2 deployments. Live /v1/models discovery remains
  // authoritative; these exact launch limits protect resume sizing when model
  // discovery is temporarily unavailable before the first provider call.
  'GLM-5.2-QuantTrio-256K': 262144,
  'GLM-5.2-NVFP4-AQLM-380K': 380928,

  // Mistral
  'mistral-large-latest': 128000,
  'mistral-medium-latest': 128000,
  'mistral-small-latest': 128000,
  'codestral-latest': 256000,

  // xAI
  'grok-2': 131072,
  'grok-3': 131072,
  'grok-3-mini': 131072,
};

/** Last-resort context window when neither the provider nor the defaults table knows the model. */
const GENERIC_CONTEXT_WINDOW_DEFAULT = 128000;

/**
 * Resolve the context window for a model.
 *
 * @param model   Resolved model id (provider prefix already stripped).
 * @param source  The provider (preferred) OR its bare maxContextWindow number
 *                (legacy/back-compat). When a provider is passed, its per-model
 *                `contextWindowFor(model)` is consulted FIRST so the correct
 *                window is used before the first chat() call (SCLI-81 — fixes
 *                opus-4-8/fable-5 compacting at 200K instead of 1M); it then
 *                falls back to the (possibly auto-discovered) maxContextWindow,
 *                then the defaults table, then the floor.
 */
type ContextWindowSource = number | null | { maxContextWindow?: number; contextWindowFor?: (model: string) => number };

function resolveProviderContextWindow(model: string, source?: ContextWindowSource): number | undefined {
  return typeof source === 'number'
    ? source
    : (source?.contextWindowFor?.(model) ?? source?.maxContextWindow);
}

/** Strip routing prefixes so `cortex/gpt-5.3-codex-spark` hits the same default as `gpt-5.3-codex-spark`. */
export function bareModelIdForContextLookup(model: string): string {
  return (model || '')
    .replace(/^cortex\//i, '')
    .replace(/^codex\//i, '')
    .replace(/^openai\//i, '')
    .replace(/^vllm\//i, '')
    .trim();
}

function lookupDefaultContextWindow(model: string): number | undefined {
  if (!model) return undefined;
  if (MODEL_CONTEXT_WINDOW_DEFAULTS[model] != null) return MODEL_CONTEXT_WINDOW_DEFAULTS[model];
  const bare = bareModelIdForContextLookup(model);
  if (bare && MODEL_CONTEXT_WINDOW_DEFAULTS[bare] != null) return MODEL_CONTEXT_WINDOW_DEFAULTS[bare];
  // Family fallback: any gpt-5.x / *-codex* id we have not enumerated yet.
  if (/^gpt-5(\.\d+)?(-|$)/i.test(bare) || /codex/i.test(bare)) return 272000;
  return undefined;
}

/** Whether SCLI has a model-specific fallback rather than only the generic floor. */
export function hasKnownModelContextWindow(model: string): boolean {
  return lookupDefaultContextWindow(model) != null;
}

export function resolveModelContextWindow(
  model: string,
  source?: ContextWindowSource,
): number {
  return resolveProviderContextWindow(model, source)
    ?? lookupDefaultContextWindow(model)
    ?? GENERIC_CONTEXT_WINDOW_DEFAULT;
}

/**
 * Resolve the context window actually safe to use for preflight compaction.
 *
 * Agent/user config may intentionally lower the window to compact earlier, but
 * it must never raise the usable window above the provider's live advertised
 * maximum. After k8s migration, some bridge agents carried a 1M configured
 * window while Cortex/vLLM served DeepSeek at 262,144 tokens; the pre-turn guard
 * trusted the higher config value, sent a 331K-token prompt, and every turn was
 * doomed until the pod was recycled.
 */
export function resolveEffectiveContextWindow(
  model: string,
  source?: ContextWindowSource,
  configured?: number | null,
): number {
  const providerWindow = resolveProviderContextWindow(model, source);
  const defaultWindow = lookupDefaultContextWindow(model);
  // VLlmProvider.contextWindowFor falls back to a generic 131072 constructor
  // floor before /v1/models discovery. Prefer known model defaults over that
  // floor so cortex/gpt-5.3-codex-spark does not compact on the first turn.
  // Do NOT override a real smaller discovered rung (e.g. Qwen 131k under
  // cortex/auto while maxContextWindow is still 262k).
  // Exact constructor default on VLlmProvider before /v1/models discovery —
  // NOT "any window ≤ 131k". A real Cortex deploy at 98k/128k is ground truth
  // and must not be lifted to the family default (that is how overflow happens:
  // we plan against 262k while the backend rejects at 98k). Operator 2026-07-24.
  const GENERIC_PROVIDER_FLOOR = 131072;
  const STALE_CODEX_CATALOG_WINDOW = 200000;
  const maxCtx = (
    source
    && typeof source === 'object'
    && typeof source.maxContextWindow === 'number'
    && source.maxContextWindow > 0
  ) ? source.maxContextWindow : undefined;
  let effectiveProvider = providerWindow;
  const looksLikeGenericFloor = (
    typeof providerWindow === 'number'
    && providerWindow === GENERIC_PROVIDER_FLOOR
    && (maxCtx == null || maxCtx === GENERIC_PROVIDER_FLOOR || maxCtx === providerWindow)
  );
  const looksLikeStaleCodexCatalog = (
    typeof providerWindow === 'number'
    && providerWindow === STALE_CODEX_CATALOG_WINDOW
    && typeof defaultWindow === 'number'
    && defaultWindow >= 272000
  );
  if (
    typeof defaultWindow === 'number'
    && defaultWindow > (providerWindow ?? 0)
    && (looksLikeGenericFloor || looksLikeStaleCodexCatalog)
  ) {
    effectiveProvider = defaultWindow;
  }
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return effectiveProvider ? Math.min(configured, effectiveProvider) : configured;
  }
  return effectiveProvider
    ?? defaultWindow
    ?? GENERIC_CONTEXT_WINDOW_DEFAULT;
}

// ── SCLI-218: dynamic context windows for virtual aliases (cortex/auto) ──────

/**
 * How compaction picks its target window when the served model can vary:
 *  - 'planning'     — compact against the current best-known window (the served
 *    model's when known, else the requested/alias planning window). Richest
 *    context, but a session grown on the top rung may not fit a smaller rung.
 *  - 'conservative' — additionally cap at the alias's advertised context floor
 *    (smallest ladder rung), so the session ALWAYS fits every rung. Trades
 *    context richness for saturation resilience; agents' eternal sessions
 *    generally want this.
 */
export type CompactionWindowMode = 'planning' | 'conservative';

type DynamicWindowSource = ContextWindowSource & {
  contextFloorFor?: (model: string) => number | undefined;
};

/**
 * Resolve the compaction window for the CURRENT state of a session whose
 * backend may serve different concrete models per response (SCLI-218).
 *
 * Precedence: backend-reported window for the served model (authoritative,
 * still capped by an explicit user config) → resolveEffectiveContextWindow of
 * the served (else requested) model → in 'conservative' mode, capped at the
 * requested model's advertised context floor when the provider knows one.
 */
/** Lift known-stale catalog windows (e.g. Codex Spark 200k seed) to family defaults. */
export function sanitizeServedContextWindow(
  model: string | undefined,
  servedWindow: number | undefined,
): number | undefined {
  if (typeof servedWindow !== 'number' || !Number.isFinite(servedWindow) || servedWindow <= 0) {
    return servedWindow;
  }
  const defaultWindow = lookupDefaultContextWindow(model ?? '');
  // Stale managed-codex catalog used 200k; real Codex family is 272k.
  // Scope the lift to GPT/Codex only — DeepSeek defaults at 512K must not
  // rewrite a legitimately smaller served window (or a 200k probe) to 524288.
  const bare = bareModelIdForContextLookup(model ?? '');
  const isCodexFamily = /^gpt-5(\.\d+)?(-|$)/i.test(bare) || /codex/i.test(bare);
  if (
    isCodexFamily
    && servedWindow === 200000
    && typeof defaultWindow === 'number'
    && defaultWindow >= 272000
  ) {
    return defaultWindow;
  }
  return servedWindow;
}

export function resolveDynamicCompactionWindow(opts: {
  requestedModel: string;
  servedModel?: string;
  /** Backend-advertised window for servedModel (from the served_model stream event). */
  servedContextWindow?: number;
  source?: DynamicWindowSource;
  configured?: number | null;
  mode?: CompactionWindowMode;
}): number {
  const { requestedModel, servedModel, servedContextWindow, source, configured, mode } = opts;
  const modelForLookup = servedModel ?? requestedModel;
  const cleanedServed = sanitizeServedContextWindow(modelForLookup, servedContextWindow);

  let window: number;
  if (typeof cleanedServed === 'number' && Number.isFinite(cleanedServed) && cleanedServed > 0) {
    window = (typeof configured === 'number' && Number.isFinite(configured) && configured > 0)
      ? Math.min(configured, cleanedServed)
      : cleanedServed;
  } else {
    window = resolveEffectiveContextWindow(modelForLookup, source, configured);
  }

  if (mode === 'conservative') {
    const floor = source?.contextFloorFor?.(requestedModel);
    if (typeof floor === 'number' && Number.isFinite(floor) && floor > 0) {
      window = Math.min(window, floor);
    }
  }
  return window;
}
