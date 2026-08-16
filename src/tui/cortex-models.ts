import type { ModelInfo } from './state/types.js';
import { DEFAULT_CORTEX_MODEL } from '../provider/registry.js';

/** Display group for Shizuha Cortex (hosted) models in the picker. */
export const CORTEX_GROUP = 'Shizuha / Cortex';

/**
 * SCLI-162: build the "Shizuha / Cortex" model-picker entries from the LIVE
 * Cortex `/v1/models` response, per session — never from a static catalog.
 *
 * @param liveModelIds the model ids Cortex `/v1/models` returned (the currently
 *   served set), or `null` when Cortex is unreachable / the fetch errored.
 *
 * Reachable -> show EXACTLY the served models. We deliberately do NOT inject
 * `DEFAULT_CORTEX_MODEL`: it is a static default (e.g. a retired `GLM-4.7`), and
 * unconditionally adding it made stale/unavailable models appear in a fresh
 * session even though Cortex no longer serves them — the SCLI-162 bug. If the
 * default is genuinely served it is already in `liveModelIds`.
 *
 * Unreachable (`null`) -> fall back to the default model ONLY, clearly marked
 * offline, so a possibly-stale model is never presented as live (acceptance #3).
 * An empty list (`[]`, reachable but serving nothing) shows no Cortex entries
 * rather than a stale default.
 */
/** Drop Cortex rows that cannot serve. /v1/models used to keep
 *  available=false ids (dead adopted backends); SCLI /model listed them. */
export function servableCortexModelIds(
  rows: Array<{ id: string; available?: boolean; status?: string }> | null,
): string[] | null {
  if (rows === null) return null;
  return rows
    .filter((m) => m.available !== false && m.status !== 'unavailable')
    .map((m) => m.id);
}

export function assembleCortexModels(liveModelIds: string[] | null): ModelInfo[] {
  if (liveModelIds === null) {
    return [{
      slug: DEFAULT_CORTEX_MODEL,
      displayName: `Cortex/${DEFAULT_CORTEX_MODEL}`,
      description: 'Shizuha Cortex (offline — last known, may be stale)',
      provider: 'cortex',
      group: CORTEX_GROUP,
      reasoningLevels: [],
      visibility: 'list',
    }];
  }
  return liveModelIds.map((id) => ({
    // CTX-67: clean model id slug (no cortex/ prefix); displayName branded.
    slug: id,
    displayName: `Cortex/${id}`,
    description: 'Shizuha Cortex (hosted)',
    provider: 'cortex',
    group: CORTEX_GROUP,
    reasoningLevels: [],
    visibility: 'list',
  }));
}
