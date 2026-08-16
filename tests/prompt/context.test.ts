import { describe, it, expect } from 'vitest';
import {
  compactionThresholdFor,
  estimateTokens,
  getSafetyFactor,
  needsCompaction,
  nextProviderCallFits,
} from '../../src/prompt/context.js';
import type { Message } from '../../src/agent/types.js';

describe('estimateTokens', () => {
  it('counts tokens for a string content message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello, how are you?' },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tokens for text content blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am doing well.' }],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tool_use blocks by serializing them', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'read', input: { file_path: '/tmp/test.txt' } },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tool_result blocks with text content', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc1', content: 'File contents here' },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('adds IMAGE_TOKEN_ESTIMATE (1600) for images in tool_result', () => {
    const textOnly: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc1', content: 'Image caption' },
        ],
      },
    ];
    const withImage: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tc1',
            content: 'Image caption',
            image: { base64: 'abc', mediaType: 'image/png' as const },
          },
        ],
      },
    ];
    const textTokens = estimateTokens(textOnly);
    const imageTokens = estimateTokens(withImage);
    // Image version should be ~1600 tokens more
    expect(imageTokens - textTokens).toBeGreaterThanOrEqual(1500);
    expect(imageTokens - textTokens).toBeLessThanOrEqual(1700);
  });

  it('returns 0 for empty messages array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('sums tokens across multiple messages', () => {
    const one: Message[] = [{ role: 'user', content: 'Hello' }];
    const two: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ];
    const oneTokens = estimateTokens(one);
    const twoTokens = estimateTokens(two);
    expect(twoTokens).toBeGreaterThan(oneTokens);
  });
});

describe('needsCompaction', () => {
  // needsCompaction applies a 1.35x safety factor to tiktoken estimates
  // (accounting for ~35% undercount vs Anthropic tokenizer), then checks
  // if the adjusted estimate exceeds 90% of maxTokens.
  // Effective threshold in raw tiktoken terms: maxTokens * 0.90 / 1.35 ≈ maxTokens * 0.667
  const SAFETY_FACTOR = 1.35;
  const THRESHOLD = 0.90;

  it('returns false when below effective threshold', () => {
    // Single short message — way below any reasonable threshold
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    expect(needsCompaction(messages, 200000)).toBe(false);
  });

  it('returns true when above effective threshold', () => {
    // Create enough messages to exceed threshold after safety factor
    const longText = 'word '.repeat(5000); // ~5000 tokens
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // 20 messages * ~5000 tokens = ~100K raw → *1.35 = ~135K; 90% of 100K = 90K → triggers
    expect(needsCompaction(messages, 100000)).toBe(true);
  });

  it('handles boundary with safety factor', () => {
    // needsCompaction: ceil(rawEstimate * 1.35) > maxTokens * 0.90
    const messages: Message[] = [{ role: 'user', content: 'a' }];
    const rawTokens = estimateTokens(messages);
    // Set maxTokens so rawTokens * 1.35 == maxTokens * 0.90 (at boundary)
    const adjustedTokens = Math.ceil(rawTokens * SAFETY_FACTOR);
    const maxTokens = Math.ceil(adjustedTokens / THRESHOLD);
    // At exact boundary, adjusted <= maxTokens * 0.90 → false
    expect(needsCompaction(messages, maxTokens)).toBe(false);
    // Just below → triggers
    expect(needsCompaction(messages, maxTokens - 1)).toBe(true);
  });

  it('accounts for overhead tokens in compaction threshold', () => {
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    const rawTokens = estimateTokens(messages);
    // Without overhead: well below threshold
    expect(needsCompaction(messages, 200000)).toBe(false);
    // With overhead pushing adjusted total above 90% of 200K (= 180K):
    // Need (rawTokens + overhead) * 1.35 > 180000
    // → overhead > 180000 / 1.35 - rawTokens ≈ 133333 - rawTokens
    const overhead = Math.ceil(200000 * THRESHOLD / SAFETY_FACTOR) - rawTokens + 1;
    expect(needsCompaction(messages, 200000, undefined, overhead)).toBe(true);
  });

  it('applies the local safety factor for llamacpp models (Qwen/Llama tokenizer mismatch)', () => {
    // tiktoken undercounts vs Qwen/Llama tokenizers; the local factor inflates the
    // estimate so compaction fires before vLLM rejects on real prompt length.
    const longText = 'word '.repeat(5000); // ~5000 tokens
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    const factor = getSafetyFactor('llamacpp/local');
    expect(factor).toBeGreaterThanOrEqual(1.4); // local models inflate heavily
    // Derive the inflated estimate the same way needsCompaction does, then probe
    // both sides of the 90% threshold with comfortable margins — no tokenizer-exact
    // boundary assumptions, so this stays robust to tokenizer changes.
    const raw = estimateTokens(messages, 'llamacpp/local');
    const inflated = Math.ceil(raw * factor);
    const triggersAt = Math.floor(inflated / 0.90) - 5000; // threshold below estimate → triggers
    const safeAt = Math.ceil(inflated / 0.90) + 20000;     // threshold above estimate → safe
    expect(needsCompaction(messages, triggersAt, 'llamacpp/local')).toBe(true);
    expect(needsCompaction(messages, safeAt, 'llamacpp/local')).toBe(false);
  });

  it('uses 1.35x safety factor for Claude models', () => {
    const longText = 'word '.repeat(5000); // ~5000 tokens
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // ~30K raw tokens. With 1.35x: ~40.5K. 70% of 60K = 42K.
    // Should NOT trigger at 60K context (40.5K < 42K).
    expect(needsCompaction(messages, 60000, 'claude-sonnet-4-6')).toBe(false);
    // 70% of 50K = 35K. 30K * 1.35 = 40.5K > 35K → triggers.
    expect(needsCompaction(messages, 50000, 'claude-sonnet-4-6')).toBe(true);
  });
});

describe('PLAT-4192 cortex-tier compaction threshold', () => {
  const maxTokens = 262_144;
  const messages: Message[] = [{ role: 'user', content: 'small current tail' }];

  // Superseded (operator 2026-08-04). PLAT-4192's flat 64K cap protected TTFT
  // but inverted with window size: a 131K model compacted at 91,750 tokens
  // while a 524K model compacted at 64,000, so a bigger context window made an
  // agent forget SOONER. A 512K session tripped it at 12% of its window and
  // compacted twice in ten minutes, each round summarizing the previous
  // summary until the original task was gone. The trigger now tracks the
  // announced window; TTFT tuning moves to the per-agent env knobs.
  it('scales the trigger with the announced window instead of a flat cap', () => {
    expect(compactionThresholdFor(maxTokens) * maxTokens)
      .toBe(Math.round(maxTokens * 0.75));
    expect(needsCompaction(messages, maxTokens, 'DeepSeek-V4-Flash', 0, 0, 196_608)).toBe(false);
    expect(needsCompaction(messages, maxTokens, 'DeepSeek-V4-Flash', 0, 0, 196_609)).toBe(true);
    expect(compactionThresholdFor(524_288) * 524_288)
      .toBe(Math.round(524_288 * 0.75));
  });

  it('never lets a larger window compact earlier than a smaller one', () => {
    // The exact inversion that caused the 2026-08-04 amnesia.
    let previous = 0;
    for (const window of [131_072, 200_000, 262_144, 400_000, 524_288]) {
      const trigger = Math.round(window * compactionThresholdFor(window));
      expect(trigger, `window ${window} must not compact earlier than ${previous}`)
        .toBeGreaterThanOrEqual(previous);
      previous = trigger;
    }
  });

  it('applies the same window-scaled trigger to every model (no name tiers)', () => {
    // 2026-08-05 (shizuha2): the former per-model-name tier check silently
    // excluded a variant spelling and its branch's trigger coincided with the
    // hard-fit ceiling, so proactive compaction never fired. The rule is now a
    // pure function of the window: 0.75 × 262,144 = 196,608 for everything,
    // comfortably below the 212,992 hard-fit ceiling (49,152 headroom).
    expect(compactionThresholdFor(maxTokens) * maxTokens).toBe(Math.round(maxTokens * 0.75));
    expect(compactionThresholdFor(maxTokens) * maxTokens)
      .toBeLessThan(maxTokens - 49_152);
  });

  it('supports a clamped runtime override for reversible tuning', () => {
    const prior = process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS;
    try {
      process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS = '80000';
      expect(compactionThresholdFor(maxTokens) * maxTokens).toBe(80_000);
      process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS = '1';
      expect(compactionThresholdFor(maxTokens) * maxTokens).toBe(48_000);
      process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS = '999999';
      expect(compactionThresholdFor(maxTokens) * maxTokens).toBe(212_992);
      process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS = '80000junk';
      // Invalid absolute override → falls back to the window-scaled default
      // (was a flat 64_000 before the 2026-08-04 inversion fix).
      expect(compactionThresholdFor(maxTokens) * maxTokens)
        .toBe(Math.round(maxTokens * 0.75));
    } finally {
      if (prior === undefined) delete process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS;
      else process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS = prior;
    }
  });

  it('allows an explicit fraction to relax the default cap', () => {
    const prior = process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION;
    try {
      process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION = '0.75';
      expect(compactionThresholdFor(524_288) * 524_288)
        .toBe(Math.round(524_288 * 0.75));
    } finally {
      if (prior === undefined) delete process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION;
      else process.env.SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION = prior;
    }
  });
});

describe('getSafetyFactor', () => {
  it('returns 1.35 for Anthropic/Claude models', () => {
    expect(getSafetyFactor('claude-opus-4-6')).toBe(1.35);
    expect(getSafetyFactor('claude-sonnet-4-6')).toBe(1.35);
    expect(getSafetyFactor('claude-haiku-4-5-20251001')).toBe(1.35);
  });

  it('returns 1.0 for GPT/Codex/O-series models', () => {
    expect(getSafetyFactor('gpt-4.1')).toBe(1.0);
    expect(getSafetyFactor('gpt-5.3-codex')).toBe(1.0);
    expect(getSafetyFactor('codex-mini-latest')).toBe(1.0);
    expect(getSafetyFactor('o3-mini')).toBe(1.0);
    expect(getSafetyFactor('o4-mini')).toBe(1.0);
  });

  it('returns 1.45 for local models (llamacpp, ollama, vllm, cortex)', () => {
    // Local/self-hosted tokenizers (Qwen/Llama/GLM) undercount worst-case with
    // many tool definitions; 1.45 covers it so compaction beats vLLM rejection.
    expect(getSafetyFactor('llamacpp/local')).toBe(1.45);
    expect(getSafetyFactor('llamacpp/Qwen3.5-2B')).toBe(1.45);
    expect(getSafetyFactor('ollama/qwen3.5')).toBe(1.45);
    expect(getSafetyFactor('ollama/llama3.1')).toBe(1.45);
    expect(getSafetyFactor('vllm/GLM-4.7')).toBe(1.45);
    expect(getSafetyFactor('cortex/GLM-4.7')).toBe(1.45);
  });

  it('returns 1.35 (conservative) when model is undefined', () => {
    expect(getSafetyFactor(undefined)).toBe(1.35);
    expect(getSafetyFactor()).toBe(1.35);
  });

  it('returns 1.35 for unknown model names', () => {
    expect(getSafetyFactor('some-unknown-model')).toBe(1.35);
    expect(getSafetyFactor('mistral-large')).toBe(1.35);
  });
});

describe('SCLI-182: provider-reported prompt_tokens gates compaction (not tiktoken×1.45)', () => {
  // A realistic cortex/local session: a chunk of history that tiktoken estimates
  // well under the window, but the ×1.45 local safety factor inflated past the
  // 0.70 trigger — the operator's "compaction at ~48%" bug.
  const bigText = 'x '.repeat(30000); // ~15k tiktoken tokens of plain text
  const messages: Message[] = [{ role: 'user', content: bigText }];
  const model = 'cortex/DeepSeek-V4-Flash';
  const maxTokens = 40000;

  it('WITHOUT reported tokens, the ×1.45 local factor over-fires (documents the bug)', () => {
    // estimate ≈ 15k; ×1.45 ≈ 21.75k > 40k×0.70 (28k)? Tune sizes so the inflated
    // path trips while the truth path does not, proving the factor is the cause.
    const raw = estimateTokens(messages, model);
    const inflated = Math.ceil(raw * getSafetyFactor(model)); // ×1.45
    // The inflated estimate is materially larger than the raw truth.
    expect(inflated).toBeGreaterThan(raw * 1.4);
  });

  // Small message list so the current-messages estimate is tiny and the reported
  // (truth) value drives the gate via max(reported, estimate).
  const tinyMessages: Message[] = [{ role: 'user', content: 'hello' }];

  it('uses reported prompt_tokens verbatim when provided (no ×1.45 inflation)', () => {
    // Real prompt is 20k of a 40k window = 50% — well under the 0.70 trigger.
    // The legacy inflated path can't apply because reported truth is used.
    const reported = 20000;
    expect(needsCompaction(tinyMessages, maxTokens, model, 0, 0, reported)).toBe(false);
  });

  it('fires when reported prompt_tokens actually exceeds the 0.70 threshold', () => {
    const reported = 29000; // 72.5% of 40k > 70%
    expect(needsCompaction(tinyMessages, maxTokens, model, 0, 0, reported)).toBe(true);
  });

  it('anchors to the real measurement even if the tiktoken estimate is lower', () => {
    // reported (truth) = 30k dominates a tiny message list's estimate → fires.
    const tiny: Message[] = [{ role: 'user', content: 'hi' }];
    expect(needsCompaction(tiny, maxTokens, model, 0, 0, 30000)).toBe(true);
  });

  it('accounts for growth since the last report via max(reported, estimate)', () => {
    // reported is stale-small (2k) but the current messages estimate is large —
    // the gate must reflect the grown context, not the stale report.
    const raw = estimateTokens(messages, model);
    // Use a window where the raw (uninflated) current estimate exceeds 0.70.
    const smallWindow = Math.floor(raw / 0.7) - 1; // raw > smallWindow*0.70
    expect(needsCompaction(messages, smallWindow, model, 0, 0, 2000)).toBe(true);
  });

  it('cold start (reported=0) preserves the original inflated-estimate behavior', () => {
    // No provider truth yet → same result as the legacy call with no 6th arg.
    const legacy = needsCompaction(messages, maxTokens, model, 0, 0);
    const coldStart = needsCompaction(messages, maxTokens, model, 0, 0, 0);
    expect(coldStart).toBe(legacy);
  });

  it('effectiveContextTokens returns truth when reported, inflated estimate when cold', async () => {
    const { effectiveContextTokens } = await import('../../src/prompt/context.js');
    const raw = estimateTokens(messages, model);
    // reported truth (larger than estimate) wins
    expect(effectiveContextTokens(messages, model, 0, raw + 5000)).toBe(raw + 5000);
    // cold start → inflated by the local safety factor
    expect(effectiveContextTokens(messages, model, 0, 0)).toBe(Math.ceil(raw * getSafetyFactor(model)));
  });

  it('pads only growth since the last report (never re-inflates whole history)', async () => {
    const { effectiveContextTokens } = await import('../../src/prompt/context.js');
    const raw = estimateTokens(messages, model);
    // Stale small report + larger current estimate → pad growth by 10%, not 1.45× whole history.
    const reported = Math.max(1, Math.floor(raw * 0.4));
    const growth = raw - reported;
    expect(effectiveContextTokens(messages, model, 0, reported)).toBe(
      reported + Math.ceil(growth * 1.10),
    );
  });
});

describe('providerPromptTokensOrEstimate', () => {
  it('treats real usage as authoritative over a larger cold estimate', async () => {
    const { providerPromptTokensOrEstimate } = await import('../../src/prompt/context.js');
    expect(providerPromptTokensOrEstimate(326_049, 479_865)).toBe(326_049);
  });

  it('uses the estimate only when the provider omitted usage', async () => {
    const { providerPromptTokensOrEstimate } = await import('../../src/prompt/context.js');
    expect(providerPromptTokensOrEstimate(0, 479_865)).toBe(479_865);
  });
});

describe('compaction trigger is a pure function of the window — no model-name tiering', () => {
  // shizuha2, 2026-08-05: a model-NAME tier check exact-matched
  // 'deepseek-v4-flash' and silently excluded `DeepSeek-V4-Flash-DSpark`,
  // dropping it to a branch whose trigger for a 524,288 window landed at
  // 84.4% — EXACTLY the backend fit ceiling (window − 16,384 output −
  // 65,536 guard = 442,368). Proactive compaction never fired; resume dropped
  // 57 messages unsummarized. Operator ruling: no name matching at all — the
  // trigger keys ONLY on the window size the provider announces.
  const WINDOW = 524_288;

  it('every 524K model compacts at the same 0.75 trigger regardless of name', () => {
    const expected = compactionThresholdFor(WINDOW);
    expect(Math.round(expected * WINDOW)).toBe(Math.round(WINDOW * 0.75));
  });

  it('the trigger is strictly below the backend fit ceiling', () => {
    // If these ever meet again, proactive compaction is dead code again.
    const trigger = compactionThresholdFor(WINDOW) * WINDOW;
    const fitCeiling = WINDOW - 16_384 - 65_536;
    expect(trigger).toBeLessThan(fitCeiling);
  });

  it('the exported threshold function takes no model argument', () => {
    // Arity pin: reintroducing a model parameter is how name-tiering sneaks
    // back in.
    expect(compactionThresholdFor.length).toBe(1);
  });
});

describe('raw-floor safety net — stale anchor must not suppress compaction (2026-08-08)', () => {
  // Cold-resume under-count fix: a stale provider-reported anchor can make the
  // anchor-adjusted estimate read BELOW the compaction threshold while the REAL
  // full prompt (system + tools + all messages) is already over it. When that
  // happens the hard fit-check would destructively drop messages instead of
  // compacting. The raw-floor check makes needsCompaction fire on the raw
  // (uninflated) full-context estimate so a stale anchor can never win.
  const WINDOW = 524_288;
  const trigger = Math.round(WINDOW * compactionThresholdFor(WINDOW)); // 0.75 → 393,216

  it('compacts when raw full-context exceeds threshold even if the anchor under-reports', () => {
    // Build a transcript whose raw estimate alone exceeds the 0.75 trigger.
    // ~4000 tokens * 100 messages = 400K raw (> 393,216) regardless of anchor.
    const longText = 'word '.repeat(4000); // ~4000 tokens
    const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // A stale anchor from a previous (smaller) session: provider reported only
    // 100K tokens. effectiveContextTokens would anchor to it and under-report.
    const staleReportedPromptTokens = 100_000;
    // needsCompaction must STILL fire via the raw floor.
    expect(needsCompaction(messages, WINDOW, 'DeepSeek-V4-Flash', 0, 0, staleReportedPromptTokens)).toBe(true);
  });

  it('raw floor does not fire for genuinely small contexts (no false positives)', () => {
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    expect(needsCompaction(messages, WINDOW, 'DeepSeek-V4-Flash', 0, 0, 100_000)).toBe(false);
  });

  it('raw floor counts overhead tokens (system + tools) toward the trigger', () => {
    const messages: Message[] = [{ role: 'user', content: 'word '.repeat(1000) }]; // ~1000 tokens
    // 1000 raw + huge overhead = over trigger; stale anchor (small) would otherwise suppress.
    const overhead = trigger - 1000 + 1;
    expect(needsCompaction(messages, WINDOW, 'DeepSeek-V4-Flash', overhead, 0, 50_000)).toBe(true);
  });

  it('mid-query tool-dump growth fires compaction on the raw floor (multi-turn query)', () => {
    // Simulate a 30-turn query where a late tool_result dump pushes raw context
    // over the threshold while the anchor (from an earlier smaller turn) is stale.
    const messages: Message[] = [];
    // 25 normal turns (~200 tokens each) + one huge tool_result dump.
    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'user', content: 'normal turn text '.repeat(40) });
      messages.push({ role: 'assistant', content: 'processing '.repeat(20) });
    }
    // ~1.6M chars ≈ 400K tokens raw — enough alone to cross the 393,216 trigger.
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tc-big', content: 'data '.repeat(400_000) }],
    });
    // Stale anchor from an early turn (small).
    const staleAnchor = 30_000;
    expect(needsCompaction(messages, WINDOW, 'DeepSeek-V4-Flash', 10_000, 0, staleAnchor)).toBe(true);
  });
});

describe('paired-baseline exemption — anchored truth beats raw overcount (agent-ryo 2026-08-08)', () => {
  const WINDOW = 524_288;

  it('does NOT compact a session with real headroom when the anchor pair is present', () => {
    // agent-ryo: provider truth 324K on a 524K window (62%), but the raw
    // char-based estimate of the same history reads ~20% higher and crossed
    // the 0.75 trigger, extractively collapsing 529 messages to 6. With the
    // PAIRED baseline (raw estimate captured for the exact anchored request),
    // growth is differential: estimated = 324K + 1.1×(rawNow − rawBaseline).
    const longText = 'word '.repeat(4000);
    const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    const rawNow = 400_000; // what the raw estimator reads for this history
    const providerTruth = 324_286; // what the provider actually tokenized
    // Baseline captured at the last request — same history, so ≈ rawNow.
    expect(
      needsCompaction(messages, WINDOW, 'DeepSeek-V4-Flash', 0, 0, providerTruth, rawNow),
    ).toBe(false);
  });

  it('still compacts when genuine growth since the anchored request crosses the trigger', () => {
    const longText = 'word '.repeat(4000);
    const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // Anchor pair from a much smaller past request: 100K real / 110K raw.
    // Raw growth since then ≈ 290K ⇒ estimated ≈ 100K + 1.1×290K ≈ 419K > trigger.
    expect(
      needsCompaction(messages, WINDOW, 'DeepSeek-V4-Flash', 0, 0, 100_000, 110_000),
    ).toBe(true);
  });
});

describe('nextProviderCallFits', () => {
  it('is independent of the 70% proactive trigger', () => {
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    expect(nextProviderCallFits(messages, 100_000, undefined, 0, 16_384)).toBe(true);
    expect(needsCompaction(messages, 100_000, undefined, 0, 16_384)).toBe(false);
  });

  it('is false when input plus output budget exceeds the window', () => {
    const messages: Message[] = [{ role: 'user', content: 'word '.repeat(5000) }];
    const raw = estimateTokens(messages);
    expect(nextProviderCallFits(messages, raw + 100, undefined, 0, 16_384)).toBe(false);
  });
});
