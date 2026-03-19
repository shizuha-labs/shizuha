/**
 * Broadcast Manager — manages named broadcast groups for cross-channel delivery.
 *
 * Extends the existing fan-out mechanism by supporting named groups:
 * a named set of channel IDs that receive messages together.
 *
 * Usage:
 *   const bm = new BroadcastManager(channels, fanOut);
 *   bm.addGroup('ops-alerts', ['telegram-main', 'discord-ops', 'slack-incidents']);
 *   await bm.broadcastToGroup('ops-alerts', event);
 */

import type { AgentEvent } from '../events/types.js';
import type { Channel, ChannelType } from './types.js';
import { logger } from '../utils/logger.js';

export class BroadcastManager {
  private groups = new Map<string, string[]>();

  constructor(
    private channels: Map<string, Channel>,
    private fanOut: Record<ChannelType, boolean>,
  ) {}

  /**
   * Broadcast an event to all channels with fan-out enabled,
   * except the source channel.
   */
  async broadcast(
    event: AgentEvent,
    sourceChannelId: string,
    threadId: string,
  ): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [, channel] of this.channels) {
      if (channel.id === sourceChannelId) continue;
      if (!this.fanOut[channel.type]) continue;
      if (!channel.broadcastEvent) continue;

      promises.push(
        channel.broadcastEvent(event, sourceChannelId, threadId).catch((err) => {
          logger.debug(
            { channelId: channel.id, err },
            'Broadcast delivery failed',
          );
        }),
      );
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  /** Add a named broadcast group. */
  addGroup(name: string, channelIds: string[]): void {
    this.groups.set(name, [...channelIds]);
    logger.debug({ group: name, channelCount: channelIds.length }, 'Broadcast group added');
  }

  /** Remove a named broadcast group. */
  removeGroup(name: string): void {
    this.groups.delete(name);
  }

  /** Get channel IDs for a named group. */
  getGroup(name: string): string[] | undefined {
    return this.groups.get(name);
  }

  /** List all group names. */
  listGroups(): string[] {
    return Array.from(this.groups.keys());
  }

  /**
   * Broadcast an event to all channels in a named group.
   * Channels that are not registered or don't support broadcastEvent are skipped.
   */
  async broadcastToGroup(groupName: string, event: AgentEvent): Promise<void> {
    const channelIds = this.groups.get(groupName);
    if (!channelIds || channelIds.length === 0) {
      logger.warn({ groupName }, 'Broadcast group not found or empty');
      return;
    }

    const promises: Promise<void>[] = [];

    for (const channelId of channelIds) {
      const channel = this.channels.get(channelId);
      if (!channel) continue;
      if (!channel.broadcastEvent) continue;

      promises.push(
        channel.broadcastEvent(event, 'broadcast', groupName).catch((err) => {
          logger.debug(
            { channelId, groupName, err },
            'Group broadcast delivery failed',
          );
        }),
      );
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }
}
