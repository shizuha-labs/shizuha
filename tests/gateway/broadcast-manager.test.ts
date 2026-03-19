import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BroadcastManager } from '../../src/gateway/broadcast.js';
import type { Channel, ChannelType } from '../../src/gateway/types.js';
import type { AgentEvent, ContentEvent } from '../../src/events/types.js';

// ── Helpers ──

function makeChannel(
  id: string,
  type: ChannelType,
  overrides: Partial<Channel> = {},
): Channel {
  return {
    id,
    type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    sendComplete: vi.fn(),
    broadcastEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeEvent(): AgentEvent {
  return {
    type: 'content',
    text: 'Hello from agent',
    timestamp: Date.now(),
  } as ContentEvent;
}

function makeFanOut(overrides: Partial<Record<ChannelType, boolean>> = {}): Record<ChannelType, boolean> {
  return {
    http: true,
    'shizuha-ws': true,
    telegram: true,
    discord: true,
    whatsapp: false,
    slack: true,
    cli: false,
    ...overrides,
  };
}

// ── Tests ──

describe('BroadcastManager', () => {
  let channels: Map<string, Channel>;
  let fanOut: Record<ChannelType, boolean>;
  let manager: BroadcastManager;

  beforeEach(() => {
    channels = new Map();
    fanOut = makeFanOut();
  });

  // ── broadcast() ──

  describe('broadcast', () => {
    it('sends to all channels except source', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      const ch2 = makeChannel('ch-2', 'telegram');
      const ch3 = makeChannel('ch-3', 'discord');
      channels.set('ch-1', ch1);
      channels.set('ch-2', ch2);
      channels.set('ch-3', ch3);
      manager = new BroadcastManager(channels, fanOut);

      const event = makeEvent();
      await manager.broadcast(event, 'ch-1', 'thread-1');

      // ch-1 is the source, should be skipped
      expect(ch1.broadcastEvent).not.toHaveBeenCalled();
      // ch-2 and ch-3 should receive the broadcast
      expect(ch2.broadcastEvent).toHaveBeenCalledWith(event, 'ch-1', 'thread-1');
      expect(ch3.broadcastEvent).toHaveBeenCalledWith(event, 'ch-1', 'thread-1');
    });

    it('skips channels with fan-out disabled', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      const ch2 = makeChannel('ch-2', 'whatsapp'); // whatsapp is disabled by default
      channels.set('ch-1', ch1);
      channels.set('ch-2', ch2);
      manager = new BroadcastManager(channels, fanOut);

      await manager.broadcast(makeEvent(), 'ch-1', 'thread-1');

      expect(ch2.broadcastEvent).not.toHaveBeenCalled();
    });

    it('skips channels without broadcastEvent method', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      const ch2 = makeChannel('ch-2', 'telegram', { broadcastEvent: undefined });
      channels.set('ch-1', ch1);
      channels.set('ch-2', ch2);
      manager = new BroadcastManager(channels, fanOut);

      await manager.broadcast(makeEvent(), 'ch-1', 'thread-1');

      // Should not throw, just skip ch2
    });

    it('handles delivery failure gracefully', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      const ch2 = makeChannel('ch-2', 'telegram', {
        broadcastEvent: vi.fn().mockRejectedValue(new Error('Network error')),
      });
      const ch3 = makeChannel('ch-3', 'discord');
      channels.set('ch-1', ch1);
      channels.set('ch-2', ch2);
      channels.set('ch-3', ch3);
      manager = new BroadcastManager(channels, fanOut);

      // Should not throw even though ch2 fails
      await expect(manager.broadcast(makeEvent(), 'ch-1', 'thread-1')).resolves.toBeUndefined();
      // ch3 should still receive the broadcast
      expect(ch3.broadcastEvent).toHaveBeenCalled();
    });

    it('does nothing when all channels are the source', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      channels.set('ch-1', ch1);
      manager = new BroadcastManager(channels, fanOut);

      await manager.broadcast(makeEvent(), 'ch-1', 'thread-1');

      expect(ch1.broadcastEvent).not.toHaveBeenCalled();
    });

    it('does nothing with empty channel map', async () => {
      manager = new BroadcastManager(channels, fanOut);
      // Should not throw
      await expect(manager.broadcast(makeEvent(), 'ch-1', 'thread-1')).resolves.toBeUndefined();
    });
  });

  // ── addGroup / removeGroup ──

  describe('addGroup / removeGroup', () => {
    it('adds a named broadcast group', () => {
      manager = new BroadcastManager(channels, fanOut);
      manager.addGroup('ops-alerts', ['ch-1', 'ch-2']);
      expect(manager.getGroup('ops-alerts')).toEqual(['ch-1', 'ch-2']);
    });

    it('addGroup makes a copy of channel IDs', () => {
      manager = new BroadcastManager(channels, fanOut);
      const ids = ['ch-1', 'ch-2'];
      manager.addGroup('ops', ids);
      ids.push('ch-3'); // mutate original
      expect(manager.getGroup('ops')).toEqual(['ch-1', 'ch-2']); // not affected
    });

    it('removes a named broadcast group', () => {
      manager = new BroadcastManager(channels, fanOut);
      manager.addGroup('ops', ['ch-1']);
      manager.removeGroup('ops');
      expect(manager.getGroup('ops')).toBeUndefined();
    });

    it('removeGroup is a no-op for unknown groups', () => {
      manager = new BroadcastManager(channels, fanOut);
      // Should not throw
      manager.removeGroup('nonexistent');
    });

    it('overwrites existing group with same name', () => {
      manager = new BroadcastManager(channels, fanOut);
      manager.addGroup('ops', ['ch-1']);
      manager.addGroup('ops', ['ch-2', 'ch-3']);
      expect(manager.getGroup('ops')).toEqual(['ch-2', 'ch-3']);
    });
  });

  // ── listGroups ──

  describe('listGroups', () => {
    it('returns all group names', () => {
      manager = new BroadcastManager(channels, fanOut);
      manager.addGroup('ops', ['ch-1']);
      manager.addGroup('dev', ['ch-2']);
      manager.addGroup('all', ['ch-1', 'ch-2']);
      const groups = manager.listGroups();
      expect(groups).toContain('ops');
      expect(groups).toContain('dev');
      expect(groups).toContain('all');
      expect(groups.length).toBe(3);
    });

    it('returns empty array when no groups', () => {
      manager = new BroadcastManager(channels, fanOut);
      expect(manager.listGroups()).toEqual([]);
    });

    it('reflects removals', () => {
      manager = new BroadcastManager(channels, fanOut);
      manager.addGroup('ops', ['ch-1']);
      manager.addGroup('dev', ['ch-2']);
      manager.removeGroup('ops');
      expect(manager.listGroups()).toEqual(['dev']);
    });
  });

  // ── broadcastToGroup ──

  describe('broadcastToGroup', () => {
    it('sends to all channels in the group', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      const ch2 = makeChannel('ch-2', 'telegram');
      const ch3 = makeChannel('ch-3', 'discord');
      channels.set('ch-1', ch1);
      channels.set('ch-2', ch2);
      channels.set('ch-3', ch3);
      manager = new BroadcastManager(channels, fanOut);

      manager.addGroup('ops', ['ch-1', 'ch-3']);
      const event = makeEvent();
      await manager.broadcastToGroup('ops', event);

      expect(ch1.broadcastEvent).toHaveBeenCalledWith(event, 'broadcast', 'ops');
      expect(ch3.broadcastEvent).toHaveBeenCalledWith(event, 'broadcast', 'ops');
      // ch-2 is not in the group
      expect(ch2.broadcastEvent).not.toHaveBeenCalled();
    });

    it('handles unknown group gracefully', async () => {
      manager = new BroadcastManager(channels, fanOut);
      // Should not throw
      await expect(
        manager.broadcastToGroup('nonexistent', makeEvent()),
      ).resolves.toBeUndefined();
    });

    it('skips unregistered channel IDs in the group', async () => {
      const ch1 = makeChannel('ch-1', 'http');
      channels.set('ch-1', ch1);
      manager = new BroadcastManager(channels, fanOut);

      // Group includes ch-2 which doesn't exist in channels map
      manager.addGroup('ops', ['ch-1', 'ch-2']);
      await manager.broadcastToGroup('ops', makeEvent());

      expect(ch1.broadcastEvent).toHaveBeenCalled();
      // ch-2 silently skipped (not in channels map)
    });

    it('skips channels without broadcastEvent in group', async () => {
      const ch1 = makeChannel('ch-1', 'http', { broadcastEvent: undefined });
      channels.set('ch-1', ch1);
      manager = new BroadcastManager(channels, fanOut);

      manager.addGroup('ops', ['ch-1']);
      // Should not throw
      await expect(manager.broadcastToGroup('ops', makeEvent())).resolves.toBeUndefined();
    });

    it('handles delivery failure in group broadcast gracefully', async () => {
      const ch1 = makeChannel('ch-1', 'http', {
        broadcastEvent: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const ch2 = makeChannel('ch-2', 'telegram');
      channels.set('ch-1', ch1);
      channels.set('ch-2', ch2);
      manager = new BroadcastManager(channels, fanOut);

      manager.addGroup('ops', ['ch-1', 'ch-2']);
      await expect(manager.broadcastToGroup('ops', makeEvent())).resolves.toBeUndefined();
      // ch-2 should still get the broadcast despite ch-1 failing
      expect(ch2.broadcastEvent).toHaveBeenCalled();
    });

    it('handles empty group gracefully', async () => {
      manager = new BroadcastManager(channels, fanOut);
      manager.addGroup('empty', []);
      // Should not throw
      await expect(manager.broadcastToGroup('empty', makeEvent())).resolves.toBeUndefined();
    });
  });
});
