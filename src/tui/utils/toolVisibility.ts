import type { ToolCallEntry } from '../state/types.js';

/**
 * Keep transcript tool rendering focused:
 * - Show active running tools while work is in progress.
 * - Remove a tool from the live surface as soon as it completes.
 *
 * Completed tool calls remain in provider/session history; retaining their
 * result cards in the live entry made old output sit above the composer until
 * the entire model turn ended.
 */
export function getVisibleToolCalls(
  runningTools: ToolCallEntry[] | ToolCallEntry | null,
  _recentCompletedTools: ToolCallEntry[] | ToolCallEntry | null,
): ToolCallEntry[] {
  const running = Array.isArray(runningTools)
    ? runningTools
    : (runningTools ? [runningTools] : []);
  return running.filter((tool) => tool.status === 'running');
}
