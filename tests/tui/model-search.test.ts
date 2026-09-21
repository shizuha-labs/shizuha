import { describe, it, expect } from 'vitest';
import { fuzzyScore, filterModels } from '../../src/tui/model-search.js';
import {
  servableCortexModelIds,
  assembleCortexModels,
  CORTEX_GROUP,
} from '../../src/tui/cortex-models.js';
import type { ModelInfo } from '../../src/tui/state/types.js';

// CTX-793 (CTX-710 S6): SCLI /model fuzzy search over the live Cortex catalog.
// The fuzzy picker (SCLI-602) and live-catalog assembly (SCLI-162) exist; these
// tests lock the slug-parse / fuzzy-match / incremental-filter / fallback
// contract so the feature is regression-safe.

const model = (over: Partial<ModelInfo>): ModelInfo =>
  ({
    slug: 'cortex/grok-4.6',
    displayName: 'Cortex/grok-4.6',
    description: 'Shizuha Cortex (hosted)',
    provider: 'cortex',
    group: CORTEX_GROUP,
    reasoningLevels: [],
    visibility: 'list',
    ...over,
  }) as ModelInfo;

const catalog: ModelInfo[] = [
  model({ slug: 'cortex/grok-4.6', displayName: 'Cortex/grok-4.6' }),
  model({ slug: 'cortex/glm-4.7', displayName: 'Cortex/glm-4.7' }),
  model({ slug: 'anthropic/claude-sonnet-4-6', displayName: 'Anthropic/claude-sonnet-4-6', provider: 'anthropic', group: 'Anthropic / Claude' }),
  model({ slug: 'openai/gpt-5.5', displayName: 'OpenAI/gpt-5.5', provider: 'openai', group: 'OpenAI / Codex' }),
];

describe('CTX-793 — fuzzyScore (fuzzy match)', () => {
  it('returns 1 for an empty query (no filter)', () => {
    expect(fuzzyScore('', 'cortex/grok-4.6')).toBe(1);
    expect(fuzzyScore('   ', 'anything')).toBe(1);
  });

  it('scores a contiguous substring higher than a gapped subsequence', () => {
    const contiguous = fuzzyScore('grok', 'cortex/grok-4.6');
    const gapped = fuzzyScore('grk', 'cortex/grok-4.6');
    expect(contiguous).toBeGreaterThan(gapped);
    expect(gapped).toBeGreaterThan(0);
  });

  it('returns 0 when the query is not a subsequence', () => {
    expect(fuzzyScore('zzz', 'cortex/grok-4.6')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('GROK', 'cortex/grok-4.6')).toBeGreaterThan(0);
  });
});

describe('CTX-793 — filterModels (incremental filter by slug/name/provider)', () => {
  it('returns all models for an empty query', () => {
    expect(filterModels(catalog, '')).toHaveLength(catalog.length);
  });

  it('filters by slug prefix', () => {
    const out = filterModels(catalog, 'cortex/grok');
    expect(out.map((m) => m.slug)).toEqual(['cortex/grok-4.6']);
  });

  it('filters by provider', () => {
    const out = filterModels(catalog, 'anthropic');
    expect(out.map((m) => m.slug)).toEqual(['anthropic/claude-sonnet-4-6']);
  });

  it('filters by display name / description text', () => {
    const out = filterModels(catalog, 'gpt-5');
    expect(out.map((m) => m.slug)).toEqual(['openai/gpt-5.5']);
  });

  it('ranks slug matches above description matches', () => {
    const out = filterModels(catalog, 'cortex');
    // Both cortex models match; the two cortex slugs outrank the others.
    expect(out[0].slug.startsWith('cortex/')).toBe(true);
    expect(out[1].slug.startsWith('cortex/')).toBe(true);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterModels(catalog, 'does-not-exist')).toEqual([]);
  });
});

describe('CTX-793 — assembleCortexModels (live catalog + fallback)', () => {
  it('falls back to the offline default when Cortex is unreachable (null)', () => {
    const out = assembleCortexModels(null);
    expect(out).toHaveLength(1);
    expect(out[0].description).toContain('offline');
    expect(out[0].provider).toBe('cortex');
  });

  it('returns an empty list when Cortex is reachable but serves nothing', () => {
    expect(assembleCortexModels([])).toEqual([]);
  });

  it('builds live entries from served model ids', () => {
    const out = assembleCortexModels(['cortex/grok-4.6', 'cortex/glm-4.7']);
    expect(out.map((m) => m.slug)).toEqual(['cortex/grok-4.6', 'cortex/glm-4.7']);
    expect(out.every((m) => m.group === CORTEX_GROUP)).toBe(true);
  });
});

describe('CTX-793 — servableCortexModelIds (slug parse / availability)', () => {
  it('returns null when the catalog fetch errored', () => {
    expect(servableCortexModelIds(null)).toBeNull();
  });

  it('drops unavailable and status=unavailable rows', () => {
    const rows = [
      { id: 'cortex/grok-4.6', available: true },
      { id: 'cortex/glm-4.7', available: false },
      { id: 'cortex/retired', status: 'unavailable' },
      { id: 'cortex/ok' },
    ];
    expect(servableCortexModelIds(rows)).toEqual(['cortex/grok-4.6', 'cortex/ok']);
  });

  it('keeps residency_full rows (busy served GLM, not a dead backend)', () => {
    const rows = [
      { id: 'cortex/GLM-5.3-Flash', available: false, status: 'residency_full' },
      { id: 'cortex/retired', available: false, status: 'unavailable' },
    ];
    expect(servableCortexModelIds(rows)).toEqual(['cortex/GLM-5.3-Flash']);
  });
});
