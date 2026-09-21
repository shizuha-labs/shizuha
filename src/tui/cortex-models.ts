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
/** True when Cortex still serves this id. Dead backends must not appear;
 *  a saturated KV-residency guard must — it is busy, not gone. */
export function cortexCatalogRowIsListed(row: {
  id: string;
  available?: boolean;
  status?: string;
}): boolean {
  const status = (row.status || '').toLowerCase();
  if (status === 'unavailable') return false;
  // CTX-885 advertises healthy-but-full models as available:false /
  // status=residency_full so clients do not treat them as idle capacity.
  // Dropping those rows hid cortex/GLM-5.3-Flash from every SCLI /model
  // picker whenever Hive filled the 16 homes (operator 2026-09-06).
  if (status === 'residency_full') return true;
  return row.available !== false;
}

/** Drop Cortex rows that cannot serve. /v1/models used to keep
 *  available=false ids (dead adopted backends); SCLI /model listed them. */
export function servableCortexModelIds(
  rows: Array<{ id: string; available?: boolean; status?: string }> | null,
): string[] | null {
  if (rows === null) return null;
  return rows.filter(cortexCatalogRowIsListed).map((m) => m.id);
}

/** Partition a live catalog id into its picker row shape (CTX-971 / CTX-713).
 * Cortex catalog ids are `alias/model`: first-party / wholesale-reseller
 * entries advertise as `cortex/<model>`, onboarded third-party providers as
 * `<seller_slug>/<model>`. A bare historical id (no `/`) stays a first-party
 * Cortex row. All rows route through the Cortex gateway, so `provider` stays
 * `cortex` for availability; only display/group vary by alias. */
export function catalogRowShape(id: string): {
  alias: string;
  firstParty: boolean;
} {
  const slash = id.indexOf('/');
  if (slash <= 0) return { alias: 'cortex', firstParty: true };
  const alias = id.slice(0, slash);
  return { alias, firstParty: alias === 'cortex' };
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
  return liveModelIds.map((id) => {
    const shape = catalogRowShape(id);
    if (shape.firstParty) {
      return {
        // CTX-713: first-party catalog ids are cortex/<model> — show the slug
        // as advertised; bare historical ids keep the readable Cortex/<id>.
        slug: id,
        displayName: id.includes('/') ? id : `Cortex/${id}`,
        description: 'Shizuha Cortex (hosted)',
        provider: 'cortex',
        group: CORTEX_GROUP,
        reasoningLevels: [],
        visibility: 'list',
      };
    }
    return {
      // CTX-971: onboarded third-party providers advertise as
      // <seller_slug>/<model> — render the slug RAW (never prefix it with
      // Cortex/) and group under the seller's own alias header, so the
      // marketplace catalog reads as advertised once cortex#120 lands.
      slug: id,
      displayName: id,
      description: `Cortex marketplace — provider ${shape.alias}`,
      provider: 'cortex',
      group: shape.alias,
      reasoningLevels: [],
      visibility: 'list',
    };
  });
}
