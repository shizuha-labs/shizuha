import { describe, expect, it } from 'vitest';

import { normalizeCodexEffort } from '../../src/codex-bridge/index.js';

// Hive can pin reasoning_effort=ultra/max for gpt-5.6-sol ChatGPT-backend
// levels, but the codex app-server ReasoningEffort enum only accepts
// none|minimal|low|medium|high|xhigh. The bridge must clamp ultra/max -> xhigh
// (the same normalization the Responses-API path applies in provider/codex.ts),
// otherwise a valid Hive setting wedges the bridge on every turn/start.
describe('normalizeCodexEffort (codex-bridge)', () => {
  it('clamps gpt-5.6-sol backend levels ultra/max to xhigh', () => {
    expect(normalizeCodexEffort('ultra')).toBe('xhigh');
    expect(normalizeCodexEffort('max')).toBe('xhigh');
    expect(normalizeCodexEffort('ULTRA')).toBe('xhigh');
    expect(normalizeCodexEffort('Max')).toBe('xhigh');
  });

  it('passes supported app-server levels through unchanged', () => {
    for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(normalizeCodexEffort(level)).toBe(level);
    }
  });

  it('returns undefined for empty/unknown input (no effort forwarded)', () => {
    expect(normalizeCodexEffort(undefined)).toBeUndefined();
    expect(normalizeCodexEffort(null)).toBeUndefined();
    expect(normalizeCodexEffort('')).toBeUndefined();
    expect(normalizeCodexEffort('absurd')).toBeUndefined();
  });
});
