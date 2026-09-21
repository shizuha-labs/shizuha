import type { ModelInfo } from './state/types.js';

/** Incremental fuzzy score for /model picker (SCLI-602). 0 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = (text || '').toLowerCase();
  if (!t) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 200 - idx;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 80 - gaps);
}

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim();
  if (!q) return models;
  return models
    .map((model) => ({
      model,
      score: Math.max(
        fuzzyScore(q, model.slug),
        fuzzyScore(q, model.displayName),
        fuzzyScore(q, model.description),
        fuzzyScore(q, model.provider),
        fuzzyScore(q, model.group),
      ),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.model.slug.localeCompare(b.model.slug))
    .map((row) => row.model);
}
