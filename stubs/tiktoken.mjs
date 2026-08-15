/**
 * tiktoken stub for Android (nodejs-mobile).
 *
 * The real tiktoken uses WASM or native bindings for BPE tokenization.
 * This stub uses a simple character-based estimator (~4 chars per token),
 * which matches the existing fallback in src/utils/tokens.ts.
 *
 * The 1.35x safety factor in context.ts compensates for estimation errors
 * on Anthropic models. For GPT/Codex (safety factor 1.0), this is within
 * ~10% accuracy which is sufficient for compaction threshold decisions.
 */

export function encoding_for_model(_model) {
  return {
    encode(text) {
      // ~4 chars per token for English text (matches GPT-4o tokenizer average)
      const len = Math.ceil(text.length / 4);
      return new Uint32Array(len);
    },
    decode(_tokens) {
      return '';
    },
    free() {},
  };
}

// Type stub — TiktokenModel is just a string union in the real package
export const TiktokenModel = undefined;
