import { describe, expect, it } from 'vitest';
import { resolveDynamicCompactionWindow, resolveEffectiveContextWindow, resolveModelContextWindow } from '../../src/provider/context-window.js';
import { AnthropicProvider } from '../../src/provider/anthropic.js';
import { OpenAIProvider } from '../../src/provider/openai.js';

describe('resolveModelContextWindow', () => {
  // The provider's own maxContextWindow is authoritative when present — for
  // self-hosted backends it's the auto-discovered SERVED limit (e.g. vLLM
  // max_model_len) and must be respected. The hardcoded table is only the
  // fallback used when the provider reports nothing (undefined).

  it('uses the table for known models when the provider reports nothing', () => {
    expect(resolveModelContextWindow('codex-mini-latest')).toBe(192000);
    expect(resolveModelContextWindow('gpt-5')).toBe(272000);
    expect(resolveModelContextWindow('claude-opus-4.6')).toBe(1000000);
    expect(resolveModelContextWindow('claude-sonnet-4-6')).toBe(1000000); // Sonnet 4.x → 1M (operator 2026-06-24)
    expect(resolveModelContextWindow('DeepSeek-V4-Flash')).toBe(524288);
    expect(resolveModelContextWindow('Qwen3.6-27B-NVFP4')).toBe(262144);
    expect(resolveModelContextWindow('Qwen3.6-35B-A3B-NVFP4')).toBe(262144);
    expect(resolveModelContextWindow('GLM-5.2-QuantTrio-256K')).toBe(262144);
    expect(resolveModelContextWindow('GLM-5.2-NVFP4-AQLM-380K')).toBe(380928);
  });

  it('prefers the provider/served window over the table (respects served limit)', () => {
    // A vLLM served at 65K must win even if the model could theoretically do more.
    expect(resolveModelContextWindow('claude-opus-4.6', 200000)).toBe(200000);
    expect(resolveModelContextWindow('GLM-4.7', 131072)).toBe(131072);
  });

  it('falls back to the provider value for unknown models', () => {
    expect(resolveModelContextWindow('unknown-model', 123456)).toBe(123456);
  });

  it('falls back to the generic default when nothing else is known', () => {
    expect(resolveModelContextWindow('totally-unknown-model')).toBe(128000);
  });

  // SCLI-81: when passed a PROVIDER, the per-model contextWindowFor(model) wins,
  // so the correct window is used BEFORE the first chat() call. The provider's
  // bare class-default maxContextWindow must NOT shadow a larger per-model window.
  it('prefers the provider per-model contextWindowFor over the class-default maxContextWindow', () => {
    const fake = {
      maxContextWindow: 200000, // stale class default, as it is before chat()
      contextWindowFor: (m: string) => (m === 'claude-opus-4-8' ? 1_000_000 : 200000),
    };
    expect(resolveModelContextWindow('claude-opus-4-8', fake)).toBe(1_000_000);
    expect(resolveModelContextWindow('claude-sonnet-4-6', fake)).toBe(200000);
  });

  it('still respects an auto-discovered served limit (provider with no contextWindowFor)', () => {
    // vLLM/self-hosted: no per-model table, maxContextWindow is the served value.
    expect(resolveModelContextWindow('GLM-4.7', { maxContextWindow: 65000 })).toBe(65000);
    expect(resolveModelContextWindow('GLM-4.7', { maxContextWindow: undefined })).toBe(128000);
  });

  it('SCLI-81 regression: real providers report the correct window pre-chat() — no class-default lie', () => {
    const anthropic = new AnthropicProvider('test-key');
    // Class default is 200K and is NOT corrected until chat() runs...
    expect(anthropic.maxContextWindow).toBe(200000);
    // ...but resolving via the provider gives the right per-model window NOW:
    expect(resolveModelContextWindow('claude-opus-4-8', anthropic)).toBe(1_000_000);
    expect(resolveModelContextWindow('claude-fable-5', anthropic)).toBe(1_000_000);
    expect(resolveModelContextWindow('claude-sonnet-4-6', anthropic)).toBe(1_000_000); // Sonnet 4.x → 1M (operator 2026-06-24)

    const openai = new OpenAIProvider('test-key');
    expect(resolveModelContextWindow('gpt-4.1', openai)).toBe(1047576);
    expect(resolveModelContextWindow('gpt-5', openai)).toBe(272000);
  });
});

describe('resolveEffectiveContextWindow', () => {
  it('lets config lower the context window but not exceed a live provider window', () => {
    const servedDeepSeek = { maxContextWindow: 262_144 };

    expect(resolveEffectiveContextWindow('DeepSeek-V4-Flash', servedDeepSeek, 1_000_000)).toBe(262_144);
    expect(resolveEffectiveContextWindow('DeepSeek-V4-Flash', servedDeepSeek, 128_000)).toBe(128_000);
  });

  it('preserves explicit config for unknown models when no provider window exists', () => {
    expect(resolveEffectiveContextWindow('custom-model', undefined, 1_000_000)).toBe(1_000_000);
  });
});

// ── SCLI-218: dynamic context windows for cortex/auto ────────────────────────

describe('resolveDynamicCompactionWindow', () => {
  // A cortex/auto backend: the alias plans at the top rung's 262K, the ladder
  // holds a smaller Qwen rung, and the floor is the smallest rung window.
  const autoSource = {
    maxContextWindow: 262_144,
    contextWindowFor: (m: string) => (m === 'Qwen3.6-27B-FP8' ? 131_072 : 262_144),
    contextFloorFor: (m: string) => (m === 'cortex/auto' ? 131_072 : undefined),
  };

  it('starts from the requested model planning window before any response', () => {
    expect(resolveDynamicCompactionWindow({
      requestedModel: 'cortex/auto',
      source: autoSource,
    })).toBe(262_144);
  });

  it('switches to the served rung window mid-session (262k → smaller rung)', () => {
    expect(resolveDynamicCompactionWindow({
      requestedModel: 'cortex/auto',
      servedModel: 'Qwen3.6-27B-FP8',
      source: autoSource,
    })).toBe(131_072);
  });

  it('prefers the backend-reported served window over any lookup', () => {
    expect(resolveDynamicCompactionWindow({
      requestedModel: 'cortex/auto',
      servedModel: 'Qwen3.6-27B-FP8',
      servedContextWindow: 98_304,
      source: autoSource,
    })).toBe(98_304);
  });

  it('conservative mode caps at the alias context floor so the session fits every rung', () => {
    expect(resolveDynamicCompactionWindow({
      requestedModel: 'cortex/auto',
      servedModel: 'DeepSeek-V4-Flash',
      servedContextWindow: 262_144,
      source: autoSource,
      mode: 'conservative',
    })).toBe(131_072);
  });

  it('conservative mode is a no-op when no floor is advertised (pre-CTX-353 servers)', () => {
    expect(resolveDynamicCompactionWindow({
      requestedModel: 'DeepSeek-V4-Flash',
      source: { maxContextWindow: 262_144 },
      mode: 'conservative',
    })).toBe(262_144);
  });

  it('explicit config still caps the backend-reported window', () => {
    expect(resolveDynamicCompactionWindow({
      requestedModel: 'cortex/auto',
      servedModel: 'DeepSeek-V4-Flash',
      servedContextWindow: 262_144,
      source: autoSource,
      configured: 128_000,
    })).toBe(128_000);
  });
});
