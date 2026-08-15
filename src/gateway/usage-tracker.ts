import { logger } from '../utils/logger.js';
import type { StateStore } from '../state/store.js';

export interface UsageRecord {
  userId: string;
  channelType: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Tracks per-user usage statistics.
 * Uses the existing StateStore's SQLite database -- adds a usage_stats table.
 */
export class UsageTracker {
  private store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.store.execSQL(`
      CREATE TABLE IF NOT EXISTS usage_stats (
        user_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        tool_calls INTEGER DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type)
      )
    `);
  }

  /** Record a message from a user */
  recordMessage(userId: string, channelType: string, inputTokens: number, outputTokens: number, toolCalls: number): void {
    const now = new Date().toISOString();
    this.store.prepareSQL(`
      INSERT INTO usage_stats (user_id, channel_type, message_count, input_tokens, output_tokens, tool_calls, first_seen, last_seen)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, channel_type) DO UPDATE SET
        message_count = message_count + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        tool_calls = tool_calls + excluded.tool_calls,
        last_seen = excluded.last_seen
    `).run(userId, channelType, inputTokens, outputTokens, toolCalls, now, now);
  }

  /** Get usage stats for a user */
  getUserUsage(userId: string): UsageRecord[] {
    return this.store.prepareSQL(
      'SELECT user_id as userId, channel_type as channelType, message_count as messageCount, input_tokens as inputTokens, output_tokens as outputTokens, tool_calls as toolCalls, first_seen as firstSeen, last_seen as lastSeen FROM usage_stats WHERE user_id = ?'
    ).all(userId) as UsageRecord[];
  }

  /** Get all usage stats */
  getAllUsage(): UsageRecord[] {
    return this.store.prepareSQL(
      'SELECT user_id as userId, channel_type as channelType, message_count as messageCount, input_tokens as inputTokens, output_tokens as outputTokens, tool_calls as toolCalls, first_seen as firstSeen, last_seen as lastSeen FROM usage_stats ORDER BY last_seen DESC'
    ).all() as UsageRecord[];
  }

  /** Get aggregate stats */
  getAggregateStats(): { totalMessages: number; totalInputTokens: number; totalOutputTokens: number; totalToolCalls: number; uniqueUsers: number } {
    const row = this.store.prepareSQL(`
      SELECT
        COALESCE(SUM(message_count), 0) as totalMessages,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(tool_calls), 0) as totalToolCalls,
        COUNT(DISTINCT user_id) as uniqueUsers
      FROM usage_stats
    `).get() as any;
    return row;
  }
}
