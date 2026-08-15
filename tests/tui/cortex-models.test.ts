import { describe, it, expect } from 'vitest';
import { assembleCortexModels, CORTEX_GROUP } from '../../src/tui/cortex-models.js';
import { DEFAULT_CORTEX_MODEL } from '../../src/provider/registry.js';

// SCLI-162: the Cortex picker must reflect live /v1/models, never a static
// catalog, and must never present a stale/retired model (e.g. GLM-4.7) as live.
describe('assembleCortexModels (SCLI-162)', () => {
  const LIVE = [
    'Gemma-4-31B', 'Qwen3.6-27B-NVFP4', 'Qwen3.6-27B-NVFP4-MTP',
    'Qwen3.6-27B-4bit-MLX', 'Qwen3.6-27B', 'Qwen-AgentWorld-35B-A3B',
  ];

  it('reachable: shows EXACTLY the served models, in order', () => {
    const out = assembleCortexModels(LIVE);
    expect(out.map((m) => m.slug)).toEqual(LIVE);
    expect(out.every((m) => m.provider === 'cortex' && m.group === CORTEX_GROUP)).toBe(true);
    expect(out.every((m) => m.displayName === `Cortex/${m.slug}`)).toBe(true);
    expect(out.every((m) => m.description === 'Shizuha Cortex (hosted)')).toBe(true);
  });

  it('reachable: does NOT inject the retired default GLM-4.7 (the bug)', () => {
    // GLM-4.7 is the DEFAULT_CORTEX_MODEL but is no longer served -> must be absent.
    expect(DEFAULT_CORTEX_MODEL).toBe('GLM-4.7'); // guards the regression premise
    const out = assembleCortexModels(LIVE);
    expect(out.map((m) => m.slug)).not.toContain('GLM-4.7');
    expect(out.map((m) => m.slug)).not.toContain(DEFAULT_CORTEX_MODEL);
  });

  it('reachable: a served default IS shown (only because /v1/models returned it)', () => {
    const out = assembleCortexModels([...LIVE, DEFAULT_CORTEX_MODEL]);
    expect(out.map((m) => m.slug)).toContain(DEFAULT_CORTEX_MODEL);
    // ...and is not duplicated.
    expect(out.filter((m) => m.slug === DEFAULT_CORTEX_MODEL)).toHaveLength(1);
  });

  it('reachable but serving nothing: shows no Cortex entries (no stale default)', () => {
    expect(assembleCortexModels([])).toEqual([]);
  });

  it('unreachable (null): offline fallback = default ONLY, clearly marked offline', () => {
    const out = assembleCortexModels(null);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe(DEFAULT_CORTEX_MODEL);
    expect(out[0]!.description.toLowerCase()).toContain('offline');
    expect(out[0]!.group).toBe(CORTEX_GROUP);
  });
});
