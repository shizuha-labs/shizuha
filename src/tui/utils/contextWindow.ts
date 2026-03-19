import { resolveModelContextWindow } from '../../provider/context-window.js';

const DEFAULT_CONTEXT = 128_000;

/** Get context window size for a model */
export function getContextWindow(model: string): number {
  return resolveModelContextWindow(model, DEFAULT_CONTEXT);
}

/** Calculate context usage percentage */
export function contextUsagePercent(usedTokens: number, model: string): number {
  const maxTokens = getContextWindow(model);
  return Math.min(100, Math.round((usedTokens / maxTokens) * 100));
}
