/**
 * In-memory channel layer for the daemon's mini-Connect.
 *
 * Real shizuha-connect uses Django Channels + Redis for pub/sub across worker
 * processes. The daemon is a single Node process, so we do the same thing with
 * a `Map<groupName, Set<Channel>>`. Same surface area as Django Channels'
 * `group_add` / `group_discard` / `group_send`, just synchronous and local.
 *
 * A "channel" here is anything with a unique name and an `onEvent(event)`
 * callback — typically a WebSocket connection wrapper, but the layer doesn't
 * know or care. Lets us unit-test broadcast logic without spinning up sockets.
 */

export interface ChannelLike {
  /** Unique per-connection name. Real Connect uses Channels' auto-generated name. */
  readonly channelName: string;
  /** Called with every event broadcast to a group this channel has joined. */
  onEvent(event: ChannelEvent): void;
}

export interface ChannelEvent {
  type: string;
  [key: string]: unknown;
}

export class ChannelLayer {
  private groups = new Map<string, Set<ChannelLike>>();
  private channelGroups = new Map<string, Set<string>>();

  /** Add a channel to a group. Idempotent. */
  groupAdd(group: string, channel: ChannelLike): void {
    let members = this.groups.get(group);
    if (!members) {
      members = new Set();
      this.groups.set(group, members);
    }
    members.add(channel);

    let groups = this.channelGroups.get(channel.channelName);
    if (!groups) {
      groups = new Set();
      this.channelGroups.set(channel.channelName, groups);
    }
    groups.add(group);
  }

  /** Remove a channel from a group. Cleans up the group entry if empty. */
  groupDiscard(group: string, channel: ChannelLike): void {
    const members = this.groups.get(group);
    if (members) {
      members.delete(channel);
      if (members.size === 0) this.groups.delete(group);
    }
    const groups = this.channelGroups.get(channel.channelName);
    if (groups) {
      groups.delete(group);
      if (groups.size === 0) this.channelGroups.delete(channel.channelName);
    }
  }

  /** Remove a channel from every group it joined. Call on disconnect. */
  removeChannel(channel: ChannelLike): void {
    const groups = this.channelGroups.get(channel.channelName);
    if (!groups) return;
    for (const g of groups) {
      const members = this.groups.get(g);
      if (members) {
        members.delete(channel);
        if (members.size === 0) this.groups.delete(g);
      }
    }
    this.channelGroups.delete(channel.channelName);
  }

  /**
   * Broadcast an event to every channel in `group`. Errors in one channel's
   * handler don't break the broadcast for the others — same as Channels'
   * fire-and-forget semantics.
   */
  groupSend(group: string, event: ChannelEvent): void {
    const members = this.groups.get(group);
    if (!members) return;
    for (const ch of members) {
      try { ch.onEvent(event); } catch { /* swallow per-channel error */ }
    }
  }

  /** Diagnostic: how many distinct channels are currently in this group. */
  groupSize(group: string): number {
    return this.groups.get(group)?.size ?? 0;
  }

  /** Diagnostic: every group this channel is currently in. */
  channelGroupNames(channel: ChannelLike): string[] {
    return [...(this.channelGroups.get(channel.channelName) ?? [])];
  }
}
