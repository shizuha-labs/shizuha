import type { Message, ContentBlock, ToolResultContent } from '../agent/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { countTokens } from '../utils/tokens.js';
import { isCortexModelId } from '../provider/registry.js';

/** Approximate tokens for an image in the Anthropic API (based on typical resolution) */
const IMAGE_TOKEN_ESTIMATE = 1600;

/**
 * Compaction threshold — the fraction of maxContextTokens at which compaction triggers.
 * Claude Code uses ~93% with a 13K buffer. Was 0.90, but a live fleet audit (2026-06-09)
 * found cortex/GLM-4.7 agents (haru/zen/yuki) bloating to ~100-110K of a 131K window —
 * INTO the degradation band (repeated/malformed tool calls, output starvation) BEFORE the
 * 0.90 trigger (~118K) fired. This estimate and the vLLM provider's promptTokenEstimate both
 * carry the 1.35 safety factor, so they align: 0.70 fires the pre-turn compaction at estimate
 * ~92K (≈70% of 131K) — before degradation — while leaving headroom to work + emit output.
 * (This is the REAL pre-turn trigger; the threshold in state/compaction.ts is a separate bar.)
 */
const COMPACTION_THRESHOLD = 0.70;

// This constant trades two real failure modes against each other; read both
// before changing it.
//
// PLAT-4192 (2026-08-01) capped the trigger at an absolute 64K because DeepSeek
// fleet agents share a saturated KV cache and 166-253K append-only sessions
// were paying 96-245s TTFT after cache eviction.
//
// That cap then caused the opposite failure (operator, 2026-08-04): pinning
// every window to 64K is non-monotonic — a 131K model compacted at 91,750
// tokens while a 524K model compacted at 64,000, so a BIGGER context window
// made an agent forget sooner. A 512K session tripped it at 12% of its window,
// compacted twice in ten minutes, and each round summarized the previous
// summary until the original task was lost entirely.
//
// Resolution: the trigger scales with the announced window (operator directive
// — "it should be a large fraction of the total context window"). The recursion
// and content defects that made frequent compaction *destructive* are fixed
// separately in state/compaction.ts (task anchor + degenerate-summary gate), so
// compaction is now survivable even when it does fire. If TTFT regresses on the
// shared DeepSeek lanes, dial it back per-agent with
// SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION / _TOKENS rather than restoring a
// flat cap that inverts with window size.
const MIN_CORTEX_COMPACTION_TRIGGER_TOKENS = 48_000;
const DEFAULT_CORTEX_COMPACTION_TRIGGER_FRACTION = 0.75;

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positiveFloatEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

/**
 * tiktoken (GPT-4o based) systematically undercounts by ~35-40% compared to
 * Anthropic's tokenizer. Apply this safety factor to tiktoken estimates so
 * compaction triggers early enough to prevent context overflow.
 * Measured: tiktoken=153K vs Anthropic API=212K → ratio 1.39. Using 1.35 as factor.
 *
 * For GPT/Codex models, tiktoken IS the native tokenizer — no inflation needed.
 */
const TIKTOKEN_SAFETY_FACTOR_ANTHROPIC = 1.35;
const TIKTOKEN_SAFETY_FACTOR_GPT = 1.0;
/**
 * Local models (Qwen, Llama, etc.) use their own tokenizers which can differ
 * significantly from tiktoken (cl100k_base). Measured: Qwen3.5-2B actual token
 * counts are ~15-20% higher than tiktoken estimates for plain text, but up to
 * 40-50% higher for JSON-heavy content (tool definitions, structured schemas).
 * Use 1.45 to safely cover the worst case with 34 tool definitions.
 */
const TIKTOKEN_SAFETY_FACTOR_LOCAL = 1.45;

/** Get the appropriate tiktoken safety factor for a model.
 *  Anthropic models undercount by ~35% with tiktoken; GPT/Codex models use tiktoken natively.
 *  Local/vLLM models (llamacpp/ollama/vllm) undercount by ~20-45% — Qwen/Llama tokenizers differ
 *  from tiktoken, especially for JSON-heavy content like tool definitions. */
export function getSafetyFactor(model?: string): number {
  if (!model) return TIKTOKEN_SAFETY_FACTOR_ANTHROPIC; // conservative default
  const bare = model.replace(/^cortex\//i, '').replace(/^codex\//i, '').replace(/^openai\//i, '');
  // GPT/Codex/O-series models use tiktoken natively — including Cortex-managed
  // offers like cortex/gpt-5.3-codex-spark (must NOT use the 1.45 local factor
  // or first-turn overhead estimates balloon and fire compaction early).
  if (bare.startsWith('gpt-') || bare.startsWith('codex-') ||
      bare.startsWith('o1') || bare.startsWith('o3') || bare.startsWith('o4') ||
      /codex/i.test(bare)) {
    return TIKTOKEN_SAFETY_FACTOR_GPT;
  }
  // Local/vLLM models: tiktoken undercounts vs Qwen/Llama tokenizers — up to 45% for JSON-heavy content
  // Cortex-hosted *local* models (GLM/Qwen/DeepSeek) keep the local factor.
  if (model.startsWith('llamacpp/') || model.startsWith('ollama/') || model.startsWith('vllm/') || isCortexModelId(model)) {
    return TIKTOKEN_SAFETY_FACTOR_LOCAL;
  }
  return TIKTOKEN_SAFETY_FACTOR_ANTHROPIC;
}

/**
 * Estimate tokens for encrypted reasoning content.
 * Encrypted content is base64-encoded. The API counts the decoded bytes, not the base64 string.
 * Formula from codex-rs/core/src/context_manager/history.rs:
 *   (base64_len * 3/4 - 650) / 4 tokens
 */
function estimateEncryptedContentTokens(base64Len: number): number {
  const decodedBytes = Math.max(0, Math.floor(base64Len * 3 / 4) - 650);
  return Math.ceil(decodedBytes / 4);
}

/** Estimate tokens for a reasoning block — handles encrypted content specially
 *  instead of naively JSON.stringify-ing the entire block (which massively overcounts). */
function estimateReasoningTokens(block: ContentBlock, model?: string): number {
  const reasoning = block as { encryptedContent?: string | null; rawContent?: string; signature?: string; summary?: Array<{ text: string }> };
  let tokens = 0;

  // Encrypted content: use the proper decode formula, not raw string length
  if (reasoning.encryptedContent) {
    tokens += estimateEncryptedContentTokens(reasoning.encryptedContent.length);
  }

  if (reasoning.rawContent) {
    tokens += countTokens(reasoning.rawContent, model);
  }

  // Summary text: count normally
  if (reasoning.summary) {
    for (const s of reasoning.summary) {
      if (s.text) tokens += countTokens(s.text, model);
    }
  }

  // Signature: relatively small, fixed overhead
  if (reasoning.signature) {
    tokens += Math.ceil(reasoning.signature.length / 4);
  }

  return tokens;
}

/** Estimate total tokens in a message array.
 *  Image data (base64) is excluded from text token counting and instead
 *  estimated as IMAGE_TOKEN_ESTIMATE per image, matching how the Anthropic API
 *  actually bills image tokens (by resolution, not text encoding).
 */
export function estimateTokens(messages: Message[], model?: string): number {
  return messages.reduce((sum, m) => {
    if (typeof m.content === 'string') {
      return sum + countTokens(m.content, model);
    }
    // Process each block individually to handle images and reasoning properly
    let msgTokens = 0;
    for (const block of m.content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        const tr = block as ToolResultContent;
        if (tr.image) {
          // Count the text content normally but estimate image tokens separately
          msgTokens += countTokens(tr.content, model) + IMAGE_TOKEN_ESTIMATE;
        } else {
          msgTokens += countTokens(tr.content, model);
        }
      } else if (block.type === 'text') {
        msgTokens += countTokens(block.text, model);
      } else if (block.type === 'reasoning') {
        // Use proper reasoning estimation instead of naive JSON.stringify
        msgTokens += estimateReasoningTokens(block, model);
      } else {
        // tool_use, etc. — serialize to count
        msgTokens += countTokens(JSON.stringify(block), model);
      }
    }
    return sum + msgTokens;
  }, 0);
}

/** Estimate token overhead from system prompt + tool definitions.
 *  These are sent alongside messages in every API request but were previously
 *  not accounted for in context usage calculations, causing underestimation
 *  (e.g., status bar shows 78% but actual is 100%). */
export function estimateOverheadTokens(systemPrompt: string, toolDefs: ToolDefinition[], model?: string): number {
  let overhead = countTokens(systemPrompt, model);
  if (toolDefs.length > 0) {
    // Tool definitions are sent as the `tools` API parameter — JSON schema serialization
    // approximates how the API tokenizes them.
    overhead += countTokens(JSON.stringify(toolDefs), model);
  }
  return overhead;
}

/**
 * Prefer observed provider usage over a speculative preflight estimate.
 *
 * The estimate is only a cold fallback for providers that omit
 * `usage.prompt_tokens`; it is not an upper bound on independently reported
 * usage. Taking the larger value reintroduces tokenizer inflation after a
 * successful turn and can trigger false compaction on the next boundary.
 */
export function providerPromptTokensOrEstimate(
  providerInputTokens: number,
  providerPromptEstimate: number,
): number {
  return providerInputTokens > 0 ? providerInputTokens : Math.max(0, providerPromptEstimate);
}

/**
 * SCLI-182: the authoritative live context size, in tokens, used by BOTH the
 * compaction trigger and the status-bar %, so what the user sees is what gates.
 *
 * `reportedPromptTokens` is the provider-reported `prompt_tokens` (real usage)
 * from the last turn — ground truth for the full prompt (system + tools + entire
 * history) as the model actually tokenized it. When present we anchor to it and
 * DROP the tiktoken×safetyFactor guess: the local/cortex 1.45x factor is
 * calibrated on the Qwen JSON worst case and wildly over-inflates tokenizers
 * close to tiktoken (e.g. DeepSeek-V4), firing compaction at ~48% of the real
 * window (the operator report). To account for the messages appended SINCE that
 * measurement (the last assistant reply + tool results + any new user turn),
 * we take max(reportedPromptTokens, uninflated current estimate): the real
 * measurement is the floor, and the uninflated tiktoken estimate of the current
 * messages captures growth without re-inflating the whole history by 45%.
 *
 * With no reported tokens yet (cold start before the first response) we fall
 * back to the original tiktoken × model-aware safety factor estimate.
 */
export function effectiveContextTokens(
  messages: Message[], model?: string, overheadTokens = 0, reportedPromptTokens = 0,
  reportedRawEstimateTokens = 0,
): number {
  const rawEstimate = estimateTokens(messages, model) + overheadTokens;
  if (reportedPromptTokens > 0) {
    // When the caller retained the uninflated estimate for the exact request
    // that produced reportedPromptTokens, grow from that matching baseline.
    // Comparing current raw tokens directly with provider-tokenizer truth loses
    // all growth until the raw estimate happens to catch up with the provider.
    // That made the status bar and next-turn gate one response/tool batch stale.
    if (reportedRawEstimateTokens > 0) {
      const growth = Math.max(0, rawEstimate - reportedRawEstimateTokens);
      return reportedPromptTokens + Math.ceil(growth * 1.10);
    }
    // Truth-anchored floor = last provider-reported prompt size.
    // Growth since that measurement (assistant reply + tool results + new user
    // text) is estimated with tiktoken. Do NOT re-inflate the whole history by
    // the 1.45× local factor (SCLI-182 — that fired compaction at ~48% of the
    // real window). DO pad only the growth portion: tokenizer skew on new tool
    // dumps was walking sessions into provider overflow before recovery.
    if (rawEstimate > reportedPromptTokens) {
      const growth = rawEstimate - reportedPromptTokens;
      return reportedPromptTokens + Math.ceil(growth * 1.10);
    }
    return reportedPromptTokens;
  }
  // Cold start: no provider truth yet — keep the conservative inflated estimate.
  return Math.ceil(rawEstimate * getSafetyFactor(model));
}

/** Check if context window needs compaction.
 *  @param overheadTokens — estimated tokens for system prompt + tool definitions (from estimateOverheadTokens)
 *  @param outputBudget — max_tokens the model will request for output (default 0).
 *    When set, compaction triggers if input + output would overflow the context window,
 *    even when input alone is below the threshold. Prevents vLLM "maximum context length" rejections.
 *  @param reportedPromptTokens — SCLI-182: provider-reported `prompt_tokens` from the
 *    last turn. When > 0, the gate uses real usage (see effectiveContextTokens) instead
 *    of the tiktoken×safetyFactor guess, so cortex/local models stop compacting at ~48%
 *    of their true window. Pass 0 (default) before the first response (cold start). */
/**
 * Compaction trigger threshold for a given window size.
 *
 * Doctrine (operator 2026-07-24): **overflow must never reach the provider**.
 * Overflow-recovery (emergency compact after a context_length rejection) is a
 * last-resort safety net, not an operating strategy. Pre-turn / post-turn
 * compaction must fire early enough that a normal tool-round + output budget
 * cannot push the next request past the backend hard limit.
 *
 * Trade-off vs older "run near the edge" tuning (2026-07-07): every compaction
 * rewrites history and busts the vLLM prefix cache (cold prefill cost), but a
 * mid-turn overflow is worse — it strands the user on recovery, can lose tail
 * state, and means the proactive path already failed. Prefer a bit more
 * headroom over recovery.
 *
 * SMALL windows keep the audited 0.70: the 2026-06-09 live audit found
 * Qwen-class models degrading (loops/garbled tool calls) past ~90K on a 131K
 * window — a model-quality bound, not a budget one.
 */
/** Absolute floor headroom for large non-DSV4 windows (tool dump + output). */
const LARGE_WINDOW_HEADROOM_TOKENS = 48_000;
/** Fractional headroom for large non-DSV4 windows (15% of max). */
const LARGE_WINDOW_HEADROOM_FRACTION = 0.15;

export function largeWindowHeadroomTokens(maxTokens: number): number {
  // Keep the proactive threshold at or below the default final provider-call
  // ceiling. The final gate reserves a 12.5% tokenizer guard (capped at 65,536)
  // plus up to 16,384 output tokens. The former 48K-only floor left an inverted
  // band on 256K-class windows where destructive trimming fired before normal
  // compaction had become eligible.
  const defaultPreflightGuard = Math.max(
    1_024,
    Math.min(65_536, Math.ceil(maxTokens * 0.125)),
  );
  const defaultFitHeadroom = defaultPreflightGuard + 16_384;
  return Math.max(
    LARGE_WINDOW_HEADROOM_TOKENS,
    Math.floor(maxTokens * LARGE_WINDOW_HEADROOM_FRACTION),
    defaultFitHeadroom,
  );
}

export function compactionThresholdFor(maxTokens: number): number {
  if (maxTokens >= 200_000) {
    // ONE rule for every large-window model, keyed ONLY on the window size the
    // provider announces (Cortex /v1/models max_model_len, registry ctx tables
    // — trust the number as-is). There is deliberately no per-model-name
    // tiering here: a name match silently excluded `DeepSeek-V4-Flash-DSpark`
    // (2026-08-05, shizuha2) and dropped it to a branch whose 524K trigger
    // computed to EXACTLY the backend fit ceiling (window − 16,384 output −
    // 65,536 guard = 442,368), so proactive compaction never fired and resume
    // had to destructively skip 57 messages. Behaviour must be a pure function
    // of the window, never of the model's spelling.
    //
    // Precedence: absolute env override > fraction env override > default
    // fraction. The default 0.75 tracks the announced window (a 512K session
    // compacts at 393,216; a 262K one at 196,608) and always sits below the
    // fit ceiling (headroom is ≥15% of the window ⇒ ceiling fraction ≥0.85).
    const absolute = positiveIntEnv('SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS');
    const fractionOverride = positiveFloatEnv('SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION');
    const fraction = fractionOverride ?? DEFAULT_CORTEX_COMPACTION_TRIGGER_FRACTION;
    const configured = absolute ?? Math.round(maxTokens * fraction);
    // Clamp: never below the quality-tested 48K floor (typo guard), never at
    // or above the hard-trim ceiling — the trigger must fire strictly before
    // destructive trimming becomes the only option.
    const fitCeilingTokens = maxTokens - largeWindowHeadroomTokens(maxTokens);
    const triggerTokens = Math.min(
      Math.max(configured, MIN_CORTEX_COMPACTION_TRIGGER_TOKENS),
      fitCeilingTokens,
    );
    return triggerTokens / maxTokens;
  }
  // SMALL windows keep the audited 0.70 (2026-06-09: model-quality bound —
  // Qwen-class degradation past ~90K of 131K — not a budget bound).
  return COMPACTION_THRESHOLD;
}

export function needsCompaction(
  messages: Message[], maxTokens: number, model?: string,
  overheadTokens = 0, outputBudget = 0, reportedPromptTokens = 0,
  reportedRawEstimateTokens = 0, guardBudget = 0,
): boolean {
  const estimated = effectiveContextTokens(
    messages,
    model,
    overheadTokens,
    reportedPromptTokens,
    reportedRawEstimateTokens,
  );
  // Two conditions trigger compaction:
  // 1. Input tokens exceed the window-aware threshold
  // 2. Input + requested output + the final tokenizer guard would exceed the
  //    provider-call ceiling. Callers that use a custom guard pass it here.
  //
  // RAW-FLOOR SAFETY NET (2026-08-08, cold-resume under-count fix): the
  // anchor-adjusted `estimated` above can under-report the REAL context on a
  // cold-resumed first turn (or after a compaction that left a stale anchor),
  // because it anchors to the last provider-reported `prompt_tokens` and only
  // pads small growth. The full prompt is system + tools + ALL messages, and a
  // tool dump during a multi-turn query can blow past the threshold while the
  // anchor-based estimate still reads below it. When that happens the hard
  // pre-provider fit-check (which measures the true full prompt) would fire a
  // DESTRUCTIVE message drop instead of a clean compaction. This floor checks
  // the raw (uninflated) full-context estimate directly against the threshold,
  // so a stale anchor can never suppress a real need to compact. It fires
  // strictly BEFORE the fit-check ceiling (which reserves output + guard), so
  // proactive compaction always wins over destructive trimming mid-query.
  // PAIR EXEMPTION (2026-08-08, agent-ryo 324K/62% falsely selected for compaction):
  // when the caller supplies the PAIRED baseline (`reportedRawEstimateTokens`
  // — the raw estimate captured for the exact request that produced
  // `reportedPromptTokens`), growth is measured differentially and the
  // anchored estimate can never under-count; the floor must NOT fire there,
  // because the raw estimator's systematic overcount of the OLD history
  // (tiktoken vs provider tokenizer) would read as phantom context and force
  // unnecessary semantic compaction on a session with real headroom. In every unpaired
  // branch effectiveContextTokens() already returns ≥ rawFullEstimate, so the
  // floor stays as a belt for exactly the stale-anchor cases it was built for.
  const rawFullEstimate = estimateTokens(messages, model) + overheadTokens;
  const rawFloorTrigger = reportedRawEstimateTokens <= 0
    && rawFullEstimate > maxTokens * compactionThresholdFor(maxTokens);
  return estimated > maxTokens * compactionThresholdFor(maxTokens)
    || (outputBudget + guardBudget > 0
      && estimated + outputBudget + guardBudget > maxTokens)
    || rawFloorTrigger;
}

/**
 * True iff the next provider call can physically fit (input + output + guard
 * ≤ window). Independent of the 70% proactive trigger. After semantic
 * compaction, "headroom restored" means this — not "back under the trigger".
 * Targeting only the trigger after a 16k think suffix used to abort fitable
 * sessions (Q4 remaining-16 compaction-headroom abort, 2026-08-16).
 */
export function nextProviderCallFits(
  messages: Message[], maxTokens: number, model?: string,
  overheadTokens = 0, outputBudget = 0, reportedPromptTokens = 0,
  reportedRawEstimateTokens = 0, guardBudget = 0,
): boolean {
  const estimated = effectiveContextTokens(
    messages,
    model,
    overheadTokens,
    reportedPromptTokens,
    reportedRawEstimateTokens,
  );
  return estimated + outputBudget + guardBudget <= maxTokens;
}
