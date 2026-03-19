import type { Message, ContentBlock, ToolResultContent } from '../agent/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { countTokens } from '../utils/tokens.js';

/** Approximate tokens for an image in the Anthropic API (based on typical resolution) */
const IMAGE_TOKEN_ESTIMATE = 1600;

/**
 * Compaction threshold — the fraction of maxContextTokens at which compaction triggers.
 * Claude Code uses ~93% with a 13K buffer. We use 0.90 (90%) as the base.
 */
const COMPACTION_THRESHOLD = 0.90;

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
 * counts are ~15-20% higher than tiktoken estimates. Use 1.20 to compensate.
 */
const TIKTOKEN_SAFETY_FACTOR_LOCAL = 1.20;

/** Get the appropriate tiktoken safety factor for a model.
 *  Anthropic models undercount by ~35% with tiktoken; GPT/Codex models use tiktoken natively.
 *  Local models (llamacpp/ollama) undercount by ~20% — Qwen/Llama tokenizers differ from tiktoken. */
export function getSafetyFactor(model?: string): number {
  if (!model) return TIKTOKEN_SAFETY_FACTOR_ANTHROPIC; // conservative default
  // GPT/Codex/O-series models use tiktoken natively
  if (model.startsWith('gpt-') || model.startsWith('codex-') ||
      model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return TIKTOKEN_SAFETY_FACTOR_GPT;
  }
  // Local models: tiktoken undercounts vs Qwen/Llama tokenizers by ~15-20%
  if (model.startsWith('llamacpp/') || model.startsWith('ollama/')) {
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
  const reasoning = block as { encryptedContent?: string | null; signature?: string; summary?: Array<{ text: string }> };
  let tokens = 0;

  // Encrypted content: use the proper decode formula, not raw string length
  if (reasoning.encryptedContent) {
    tokens += estimateEncryptedContentTokens(reasoning.encryptedContent.length);
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

/** Check if context window needs compaction.
 *  @param overheadTokens — estimated tokens for system prompt + tool definitions (from estimateOverheadTokens)
 *  Applies model-aware safety factor: 1.35x for Anthropic (tiktoken undercount), 1.0x for GPT/Codex. */
export function needsCompaction(messages: Message[], maxTokens: number, model?: string, overheadTokens = 0): boolean {
  const rawEstimate = estimateTokens(messages, model) + overheadTokens;
  const estimated = Math.ceil(rawEstimate * getSafetyFactor(model));
  return estimated > maxTokens * COMPACTION_THRESHOLD;
}
