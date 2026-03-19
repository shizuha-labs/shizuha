/**
 * FIFO message inbox for the agent process.
 *
 * Messages from all channels are pushed here. The agent loop pulls messages
 * one at a time, processes each fully, then pulls the next. This ensures
 * sequential processing — the agent never splits attention.
 */

import type { InboundMessage, Inbox as InboxInterface } from './types.js';

export class Inbox implements InboxInterface {
  private queue: InboundMessage[] = [];
  private resolver: ((msg: InboundMessage) => void) | null = null;
  private _busy = false;

  get depth(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this._busy;
  }

  set busy(value: boolean) {
    this._busy = value;
  }

  /** Push a message into the inbox. Called by channels. */
  push(msg: InboundMessage): void {
    if (this.resolver) {
      // Agent loop is waiting — deliver immediately
      const resolve = this.resolver;
      this.resolver = null;
      resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Pull the next message. Blocks (awaits) until one is available. */
  async next(): Promise<InboundMessage> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<InboundMessage>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Peek at the next message without removing it. */
  peek(): InboundMessage | null {
    return this.queue[0] ?? null;
  }

  /** Get all queued messages (for inspection, e.g. showing queue to user). */
  queued(): readonly InboundMessage[] {
    return this.queue;
  }

  /** Clear the inbox (e.g. on shutdown). */
  clear(): void {
    this.queue.length = 0;
    if (this.resolver) {
      // Leave the resolver hanging — the agent loop will
      // be interrupted by the process shutdown anyway.
    }
  }
}
