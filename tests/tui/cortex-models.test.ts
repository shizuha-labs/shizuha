import { describe, it, expect } from 'vitest';
import { assembleCortexModels, CORTEX_GROUP, servableCortexModelIds } from '../../src/tui/cortex-models.js';
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
    expect(out.every((m) => m.displayName === `Cortex/${m.slug}` || m.displayName === m.slug)).toBe(true);
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

  it('prefixed catalog ids keep cortex/ as the display slug', () => {
    const out = assembleCortexModels(['cortex/DeepSeek-V4-Flash']);
    expect(out[0]!.slug).toBe('cortex/DeepSeek-V4-Flash');
    expect(out[0]!.displayName).toBe('cortex/DeepSeek-V4-Flash');
  });

  it('reachable but serving nothing: shows no Cortex entries (no stale default)', () => {
    expect(assembleCortexModels([])).toEqual([]);
  });

  it('servableCortexModelIds drops available=false / status=unavailable rows', () => {
    expect(servableCortexModelIds(null)).toBeNull();
    expect(servableCortexModelIds([
      { id: 'Qwen3.8-27B-Q4', available: true, status: 'available' },
      { id: 'Qwen3.8-27B', available: false, status: 'unavailable' },
      { id: 'Qwen3.8-27B-MLX', status: 'unavailable' },
      { id: 'DeepSeek-V4-Flash' },
    ])).toEqual(['Qwen3.8-27B-Q4', 'DeepSeek-V4-Flash']);
  });

  it('keeps residency_full GLM-5.3-Flash so the picker still lists a served model', () => {
    // Live Cortex 2026-09-06: 4 healthy GLM TP4 backends, catalog
    // available:false status=residency_full because Hive held 16/16 homes.
    // The old available!==false filter hid the model from every SCLI user.
    expect(servableCortexModelIds([
      { id: 'cortex/DeepSeek-V4-Flash-Vision-Metal', available: true, status: 'available' },
      { id: 'cortex/GLM-5.3-Flash', available: false, status: 'residency_full' },
      { id: 'cortex/MiniMax-H3', available: true, status: 'available' },
      { id: 'cortex/dead', available: false, status: 'unavailable' },
    ])).toEqual([
      'cortex/DeepSeek-V4-Flash-Vision-Metal',
      'cortex/GLM-5.3-Flash',
      'cortex/MiniMax-H3',
    ]);
    expect(assembleCortexModels([
      'cortex/GLM-5.3-Flash',
    ]).map((m) => m.slug)).toEqual(['cortex/GLM-5.3-Flash']);
  });

  it('TUI picker still builds Cortex rows through servableCortexModelIds', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/tui/session.ts', import.meta.url), 'utf8');
    expect(src).toContain('liveModelIds = servableCortexModelIds(data.data ?? [])');
  });

  it('unreachable (null): offline fallback = default ONLY, clearly marked offline', () => {
    const out = assembleCortexModels(null);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe(DEFAULT_CORTEX_MODEL);
    expect(out[0]!.description.toLowerCase()).toContain('offline');
    expect(out[0]!.group).toBe(CORTEX_GROUP);
  });
});

// CTX-971 (CTX-710 c6): the picker must render the marketplace catalog shape —
// first-party/reseller entries as `cortex/<model>` under the Cortex group,
// onboarded third-party providers as RAW `<seller_slug>/<model>` grouped under
// the seller's own alias header (never prefixed with Cortex/).
describe('assembleCortexModels marketplace shape (CTX-971)', () => {
  it('third-party seller/model renders RAW and groups under the seller alias', () => {
    const out = assembleCortexModels(['grok-labs/qwen3-8b', 'together/fireworks-v4']);
    expect(out.map((m) => m.displayName)).toEqual(['grok-labs/qwen3-8b', 'together/fireworks-v4']);
    expect(out.map((m) => m.group)).toEqual(['grok-labs', 'together']);
    expect(out.every((m) => m.provider === 'cortex')).toBe(true); // routes through the gateway
    expect(out.every((m) => m.description.includes('marketplace'))).toBe(true);
  });

  it('seller slugs are NEVER prefixed with Cortex/ (the misrender)', () => {
    const out = assembleCortexModels(['seller_slug/model']);
    expect(out[0]!.displayName).not.toContain('Cortex/');
    expect(out[0]!.displayName).toBe('seller_slug/model');
  });

  it('cortex/ first-party entries stay under the Cortex group', () => {
    const out = assembleCortexModels(['cortex/gpt-5.6-sol', 'seller/mistral-large']);
    expect(out[0]!.group).toBe(CORTEX_GROUP);
    expect(out[0]!.displayName).toBe('cortex/gpt-5.6-sol');
    expect(out[1]!.group).toBe('seller');
  });

  it('bare historical ids keep the readable Cortex/<id> display', () => {
    const out = assembleCortexModels(['Qwen3.8-27B']);
    expect(out[0]!.displayName).toBe('Cortex/Qwen3.8-27B');
    expect(out[0]!.group).toBe(CORTEX_GROUP);
  });

  it('catalogRowShape partitions ids by alias prefix', async () => {
    const { catalogRowShape } = await import('../../src/tui/cortex-models.js');
    expect(catalogRowShape('cortex/gpt-5.6-sol')).toEqual({ alias: 'cortex', firstParty: true });
    expect(catalogRowShape('grok-labs/qwen3-8b')).toEqual({ alias: 'grok-labs', firstParty: false });
    expect(catalogRowShape('Qwen3.8-27B')).toEqual({ alias: 'cortex', firstParty: true });
    expect(catalogRowShape('/weird')).toEqual({ alias: 'cortex', firstParty: true });
  });
});
