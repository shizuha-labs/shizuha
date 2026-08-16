import { describe, it, expect } from 'vitest';
import {
  bareModelIdForContextLookup,
  resolveDynamicCompactionWindow,
  resolveEffectiveContextWindow,
  resolveModelContextWindow,
  sanitizeServedContextWindow,
} from '../../src/provider/context-window.js';
import { getSafetyFactor } from '../../src/prompt/context.js';

describe('codex spark / cortex context windows', () => {
  it('strips cortex/codex routing prefixes for lookup', () => {
    expect(bareModelIdForContextLookup('cortex/gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark');
    expect(bareModelIdForContextLookup('codex/gpt-5.5')).toBe('gpt-5.5');
  });

  it('defaults cortex/gpt-5.3-codex-spark to 272k (not 128k/131k)', () => {
    expect(resolveModelContextWindow('gpt-5.3-codex-spark')).toBe(272000);
    expect(resolveModelContextWindow('cortex/gpt-5.3-codex-spark')).toBe(272000);
    expect(resolveModelContextWindow('codex/gpt-5.3-codex-spark')).toBe(272000);
  });

  it('does not let a generic 131k provider floor suppress 272k defaults', () => {
    // Simulates VLlmProvider before /v1/models discovery (constructor default).
    const fakeProvider = {
      maxContextWindow: 131072,
      contextWindowFor: () => 131072,
    };
    expect(
      resolveEffectiveContextWindow('cortex/gpt-5.3-codex-spark', fakeProvider),
    ).toBe(272000);
  });

  it('overrides the stale 200k Codex catalog seed with 272k defaults', () => {
    const fakeProvider = {
      maxContextWindow: 200000,
      contextWindowFor: () => 200000,
    };
    // Managed-codex once seeded context_window=200000; prefer real Codex 272k.
    expect(
      resolveEffectiveContextWindow('cortex/gpt-5.3-codex-spark', fakeProvider),
    ).toBe(272000);
  });

  it('still trusts a non-stale discovered window (e.g. 256k deploy cap)', () => {
    const fakeProvider = {
      maxContextWindow: 262144,
      contextWindowFor: () => 262144,
    };
    expect(
      resolveEffectiveContextWindow('cortex/DeepSeek-V4-Flash', fakeProvider),
    ).toBe(262144);
  });

  it('uses tiktoken-native safety factor for cortex-hosted GPT/Codex models', () => {
    expect(getSafetyFactor('cortex/gpt-5.3-codex-spark')).toBe(1.0);
    expect(getSafetyFactor('gpt-5.3-codex-spark')).toBe(1.0);
    expect(getSafetyFactor('cortex/gpt-5.5')).toBe(1.0);
    // Local cortex models keep the inflated factor
    expect(getSafetyFactor('cortex/DeepSeek-V4-Flash')).toBe(1.45);
    expect(getSafetyFactor('cortex/GLM-4.7')).toBe(1.45);
  });

  it('sanitizes served_model 200k events so mid-session cache cannot pin a stale window', () => {
    expect(sanitizeServedContextWindow('cortex/gpt-5.3-codex-spark', 200000)).toBe(272000);
    expect(sanitizeServedContextWindow('cortex/gpt-5.3-codex-spark', 272000)).toBe(272000);
    // Non-codex models keep advertised windows
    expect(sanitizeServedContextWindow('cortex/DeepSeek-V4-Flash', 200000)).toBe(200000);

    expect(resolveDynamicCompactionWindow({
      requestedModel: 'cortex/gpt-5.3-codex-spark',
      servedModel: 'gpt-5.3-codex-spark',
      servedContextWindow: 200000,
    })).toBe(272000);
  });
});
