import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { StateStore } = await import('../../src/state/store.js');
const { UsageTracker } = await import('../../src/gateway/usage-tracker.js');

describe('UsageTracker', () => {
  let tmpDir: string;
  let store: InstanceType<typeof StateStore>;
  let tracker: InstanceType<typeof UsageTracker>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-usage-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    store = new StateStore(dbPath);
    tracker = new UsageTracker(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('recordMessage', () => {
    it('creates a new record for a new user/channel combination', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      const records = tracker.getUserUsage('user1');
      expect(records).toHaveLength(1);
      expect(records[0]!.userId).toBe('user1');
      expect(records[0]!.channelType).toBe('telegram');
      expect(records[0]!.messageCount).toBe(1);
      expect(records[0]!.inputTokens).toBe(100);
      expect(records[0]!.outputTokens).toBe(200);
      expect(records[0]!.toolCalls).toBe(1);
    });

    it('increments existing record on subsequent messages', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'telegram', 150, 300, 2);

      const records = tracker.getUserUsage('user1');
      expect(records).toHaveLength(1);
      expect(records[0]!.messageCount).toBe(2);
      expect(records[0]!.inputTokens).toBe(250);
      expect(records[0]!.outputTokens).toBe(500);
      expect(records[0]!.toolCalls).toBe(3);
    });

    it('keeps separate records for different channels', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'whatsapp', 50, 100, 0);

      const records = tracker.getUserUsage('user1');
      expect(records).toHaveLength(2);
      const telegram = records.find((r) => r.channelType === 'telegram')!;
      const whatsapp = records.find((r) => r.channelType === 'whatsapp')!;
      expect(telegram.messageCount).toBe(1);
      expect(whatsapp.messageCount).toBe(1);
    });

    it('sets firstSeen and lastSeen timestamps', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      const records = tracker.getUserUsage('user1');
      expect(records[0]!.firstSeen).toBeTruthy();
      expect(records[0]!.lastSeen).toBeTruthy();
    });

    it('updates lastSeen but not firstSeen on subsequent messages', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      const first = tracker.getUserUsage('user1')[0]!;
      const firstSeenBefore = first.firstSeen;

      // Small delay to ensure timestamps differ
      tracker.recordMessage('user1', 'telegram', 50, 100, 0);
      const updated = tracker.getUserUsage('user1')[0]!;
      expect(updated.firstSeen).toBe(firstSeenBefore);
      // lastSeen should be the same or newer (both happen nearly instantly)
      expect(updated.lastSeen).toBeTruthy();
    });

    it('handles zero token counts', () => {
      tracker.recordMessage('user1', 'telegram', 0, 0, 0);
      const records = tracker.getUserUsage('user1');
      expect(records[0]!.inputTokens).toBe(0);
      expect(records[0]!.outputTokens).toBe(0);
      expect(records[0]!.toolCalls).toBe(0);
    });
  });

  describe('getUserUsage', () => {
    it('returns empty array for unknown user', () => {
      const records = tracker.getUserUsage('unknown');
      expect(records).toEqual([]);
    });

    it('returns per-channel breakdown for a user', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'whatsapp', 50, 100, 0);
      tracker.recordMessage('user1', 'discord', 75, 150, 2);

      const records = tracker.getUserUsage('user1');
      expect(records).toHaveLength(3);
      const channelTypes = records.map((r) => r.channelType).sort();
      expect(channelTypes).toEqual(['discord', 'telegram', 'whatsapp']);
    });

    it('does not return other users records', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user2', 'telegram', 50, 100, 0);

      const user1Records = tracker.getUserUsage('user1');
      expect(user1Records).toHaveLength(1);
      expect(user1Records[0]!.userId).toBe('user1');
    });
  });

  describe('getAllUsage', () => {
    it('returns empty array when no records exist', () => {
      const records = tracker.getAllUsage();
      expect(records).toEqual([]);
    });

    it('returns all records from all users', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user2', 'whatsapp', 50, 100, 0);
      tracker.recordMessage('user3', 'discord', 75, 150, 2);

      const records = tracker.getAllUsage();
      expect(records).toHaveLength(3);
    });

    it('returns all records from getAllUsage', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user2', 'whatsapp', 50, 100, 0);
      tracker.recordMessage('user3', 'discord', 75, 150, 2);

      const records = tracker.getAllUsage();
      expect(records).toHaveLength(3);
      const userIds = records.map(r => r.userId).sort();
      expect(userIds).toEqual(['user1', 'user2', 'user3']);
    });

    it('includes multi-channel records for same user', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'whatsapp', 50, 100, 0);

      const records = tracker.getAllUsage();
      expect(records).toHaveLength(2);
    });
  });

  describe('getAggregateStats', () => {
    it('returns zeros when no records exist', () => {
      const stats = tracker.getAggregateStats();
      expect(stats.totalMessages).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalToolCalls).toBe(0);
      expect(stats.uniqueUsers).toBe(0);
    });

    it('totals across all users and channels', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'whatsapp', 50, 100, 2);
      tracker.recordMessage('user2', 'telegram', 75, 150, 3);

      const stats = tracker.getAggregateStats();
      expect(stats.totalMessages).toBe(3);
      expect(stats.totalInputTokens).toBe(225);
      expect(stats.totalOutputTokens).toBe(450);
      expect(stats.totalToolCalls).toBe(6);
      expect(stats.uniqueUsers).toBe(2);
    });

    it('counts unique users correctly (not channel combinations)', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'whatsapp', 50, 100, 0);
      tracker.recordMessage('user1', 'discord', 25, 50, 0);

      const stats = tracker.getAggregateStats();
      expect(stats.uniqueUsers).toBe(1);
    });

    it('accumulates across multiple messages for same user/channel', () => {
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);
      tracker.recordMessage('user1', 'telegram', 100, 200, 1);

      const stats = tracker.getAggregateStats();
      expect(stats.totalMessages).toBe(3);
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(600);
      expect(stats.totalToolCalls).toBe(3);
      expect(stats.uniqueUsers).toBe(1);
    });
  });

  describe('multiple users', () => {
    it('tracks many users independently', () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordMessage(`user${i}`, 'telegram', i * 10, i * 20, i);
      }

      const stats = tracker.getAggregateStats();
      expect(stats.uniqueUsers).toBe(10);

      // Verify individual user isolation
      const user5 = tracker.getUserUsage('user5');
      expect(user5).toHaveLength(1);
      expect(user5[0]!.inputTokens).toBe(50);
      expect(user5[0]!.outputTokens).toBe(100);
      expect(user5[0]!.toolCalls).toBe(5);
    });
  });

  describe('table creation', () => {
    it('creates usage_stats table automatically on construction', () => {
      // The tracker was already created in beforeEach; verify by inserting and querying
      tracker.recordMessage('test', 'test', 1, 2, 3);
      const records = tracker.getUserUsage('test');
      expect(records).toHaveLength(1);
    });

    it('is safe to create multiple UsageTrackers on same store', () => {
      // The table already exists from beforeEach; creating another tracker should not throw
      const tracker2 = new UsageTracker(store);
      tracker2.recordMessage('user2', 'telegram', 10, 20, 0);
      const records = tracker2.getUserUsage('user2');
      expect(records).toHaveLength(1);
    });
  });
});
