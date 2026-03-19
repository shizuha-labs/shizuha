import type { ToolCallEntry } from '../state/types.js';

/**
 * Keep transcript tool rendering focused:
 * - Show active running tools while work is in progress.
 * - Otherwise show up to 2 recently completed tools for context.
 * - Avoid showing an empty tools section.
 */
export function getVisibleToolCalls(
  runningTools: ToolCallEntry[] | ToolCallEntry | null,
  recentCompletedTools: ToolCallEntry[] | ToolCallEntry | null,
): ToolCallEntry[] {
  const running = Array.isArray(runningTools)
    ? runningTools
    : (runningTools ? [runningTools] : []);
  const completed = Array.isArray(recentCompletedTools)
    ? recentCompletedTools
    : (recentCompletedTools ? [recentCompletedTools] : []);

  if (running.length > 0) {
    return running;
  }
  return completed.slice(-2);
}
