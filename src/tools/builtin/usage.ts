import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import type { UsageTracker } from '../../gateway/usage-tracker.js';

let sharedTracker: UsageTracker | null = null;

export function setUsageTracker(tracker: UsageTracker): void {
  sharedTracker = tracker;
}

export const usageStatsTool: ToolHandler = {
  name: 'usage_stats',
  description: 'Get usage statistics -- total messages, tokens, tool calls, and per-user breakdown.',
  parameters: z.object({
    user_id: z.string().optional().describe('Filter by user ID (omit for aggregate stats)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedTracker) {
      return { toolUseId: '', content: 'Usage tracking not initialized', isError: true };
    }

    const { user_id } = (this as any).parameters.parse(params);

    if (user_id) {
      const records = sharedTracker.getUserUsage(user_id);
      if (records.length === 0) {
        return { toolUseId: '', content: `No usage data for user "${user_id}".` };
      }
      return { toolUseId: '', content: JSON.stringify(records, null, 2) };
    }

    const aggregate = sharedTracker.getAggregateStats();
    const allUsers = sharedTracker.getAllUsage();

    return {
      toolUseId: '',
      content: JSON.stringify({
        aggregate,
        topUsers: allUsers.slice(0, 10),
      }, null, 2),
    };
  },
};
