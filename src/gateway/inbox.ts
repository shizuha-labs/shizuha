/**
 * Stable-priority message inbox for the agent process.
 *
 * Messages are still processed one at a time. Direct/control traffic stays
 * ahead of autonomous scheduling, while a pending scheduler checkpoint runs
 * before routine task-notification hints. Ordering is FIFO within each class.
 *
 * Pulse `[Task Assigned]` / `[Task Update]` DMs are notifications of state
 * Pulse already holds. They must not start a model turn while the agent is
 * in a work session (a real user/control turn). Idle agents may still be
 * woken by them; a burst collapses to one digest. A heartbeat is the idle
 * checkpoint and drops any parked assignment notices (Pulse is SoT).
 */

import { logger } from '../utils/logger.js';
import type { InboundMessage, Inbox as InboxInterface } from './types.js';

export type GatewayInboxClass = 'direct-control' | 'heartbeat' | 'routine-task';

export function isRoutineTaskNotificationContent(content: unknown): boolean {
  return typeof content === 'string'
    && /^\s*\[system\]\s+(?:\[Task (?:Assigned|Update)\]|\[(?:Review Seat Starvation|Routability Hold)\])/i.test(content);
}

/** Low-priority Pulse notices — hold during a work session. */
export function isWorkingDeferredTaskNotification(message: InboundMessage): boolean {
  if (message.source === 'heartbeat') return false;
  const content = typeof message.content === 'string' ? message.content : '';
  return /^\s*\[system\]\s+\[Task (?:Assigned|Update)\]/i.test(content);
}

export function gatewayInboxClass(message: InboundMessage): GatewayInboxClass {
  if (message.source === 'heartbeat') return 'heartbeat';
  if (message.metadata?.['schedulerClass'] === 'routine-task'
      || isRoutineTaskNotificationContent(message.content)) {
    return 'routine-task';
  }
  return 'direct-control';
}

export function gatewayTaskNotificationKey(message: InboundMessage): string | null {
  if (gatewayInboxClass(message) !== 'routine-task') return null;
  const explicit = message.metadata?.['schedulerTaskKey'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().toUpperCase();
  if (typeof message.content !== 'string') return null;
  return message.content.match(/\b[A-Z][A-Z0-9]*-\d+\b/i)?.[0]?.toUpperCase() ?? null;
}

function gatewayInboxPriority(message: InboundMessage): number {
  const cls = gatewayInboxClass(message);
  if (cls === 'direct-control') return 0;
  if (cls === 'heartbeat') return 1;
  return 2;
}

export class Inbox implements InboxInterface {
  private queue: InboundMessage[] = [];
  private resolver: ((msg: InboundMessage) => void) | null = null;
  private arrivalSequence = new WeakMap<InboundMessage, number>();
  private nextArrivalSequence = 0;
  private coalescedHeartbeatCount = 0;
  private _busy = false;
  private ingressSealed = false;
  private _admissionVersion = 0;
  /** True after a real user/control turn until the next heartbeat. */
  private workSessionActive = false;

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
    this.tryPush(msg);
  }

  tryPush(msg: InboundMessage): boolean {
    if (this.ingressSealed) return false;
    this._admissionVersion += 1;

    // Assignment/update notices always land in the queue first so a burst can
    // coalesce. Never resolve the waiter with a raw mid-work notice.
    if (isWorkingDeferredTaskNotification(msg)) {
      this.enqueueMessage(msg);
      if (this.resolver && !this.workSessionActive) {
        const admitted = this.takeWorkingDeferredAdmission();
        if (admitted) {
          const resolve = this.resolver;
          this.resolver = null;
          resolve(admitted);
        }
      } else if (this.workSessionActive) {
        logger.info({
          taskKey: gatewayTaskNotificationKey(msg),
          queued: this.queue.filter((row) => isWorkingDeferredTaskNotification(row)).length,
        }, 'Holding Pulse task notification until the work session is idle');
      }
      return true;
    }

    if (this.resolver) {
      // Agent loop is waiting — deliver immediately
      const resolve = this.resolver;
      this.resolver = null;
      if (gatewayInboxClass(msg) === 'heartbeat') {
        this.dropWorkingDeferred('heartbeat');
        this.workSessionActive = false;
      } else {
        this.workSessionActive = true;
      }
      resolve(msg);
      return true;
    }

    const cls = gatewayInboxClass(msg);
    if (cls === 'heartbeat' && this.queue.some((queued) => gatewayInboxClass(queued) === 'heartbeat')) {
      this.coalescedHeartbeatCount += 1;
      return true; // cadence ticks coalesce into one pending scheduler checkpoint
    }

    this.enqueueMessage(msg);
    return true;
  }

  private enqueueMessage(msg: InboundMessage): void {
    const taskKey = gatewayTaskNotificationKey(msg);
    if (taskKey) {
      const duplicateIndex = this.queue.findIndex((queued) => gatewayTaskNotificationKey(queued) === taskKey);
      if (duplicateIndex >= 0) {
        // The task event is only a wake hint; retain its stable queue position
        // but replace stale detail with the newest canonical-state hint.
        const replaced = this.queue[duplicateIndex]!;
        this.arrivalSequence.set(msg, this.arrivalSequence.get(replaced) ?? this.nextArrivalSequence++);
        this.queue[duplicateIndex] = msg;
        return;
      }
    }

    this.arrivalSequence.set(msg, this.nextArrivalSequence++);
    const priority = gatewayInboxPriority(msg);
    const insertionIndex = this.queue.findIndex((queued) => gatewayInboxPriority(queued) > priority);
    if (insertionIndex < 0) this.queue.push(msg);
    else this.queue.splice(insertionIndex, 0, msg);
  }

  private dropWorkingDeferred(reason: string): number {
    const kept: InboundMessage[] = [];
    let dropped = 0;
    for (const row of this.queue) {
      if (isWorkingDeferredTaskNotification(row)) dropped += 1;
      else kept.push(row);
    }
    if (dropped > 0) {
      this.queue = kept;
      logger.info({ dropped, reason }, 'Dropped parked Pulse task notifications (Pulse remains SoT)');
    }
    return dropped;
  }

  private takeWorkingDeferredAdmission(): InboundMessage | null {
    const held = this.queue.filter((row) => isWorkingDeferredTaskNotification(row));
    if (held.length === 0) return null;
    this.queue = this.queue.filter((row) => !isWorkingDeferredTaskNotification(row));
    if (held.length === 1) return held[0]!;
    const keys = [...new Set(
      held.map((row) => gatewayTaskNotificationKey(row)).filter((key): key is string => Boolean(key)),
    )];
    const first = held[0]!;
    return {
      ...first,
      id: `task-notification-digest:${keys.join(',') || first.id}`,
      content: `[system] [Task notifications] ${held.length} Pulse assignment/update `
        + `notice${held.length === 1 ? '' : 's'} arrived while idle`
        + `${keys.length ? `: ${keys.join(', ')}` : ''}. `
        + 'They are already on your Pulse queue — call pulse_get_my_tasks. '
        + 'Do not abandon in-progress work to chase these.',
      timestamp: Date.now(),
      metadata: {
        ...(first.metadata || {}),
        schedulerClass: 'routine-task',
        syntheticDigest: true,
        coalescedCount: held.length,
        coalescedTaskKeys: keys,
      },
    };
  }

  private takeAdmissible(): InboundMessage | null {
    // Queue is already priority-sorted (direct-control, heartbeat, routine).
    for (let i = 0; i < this.queue.length; i++) {
      const row = this.queue[i]!;
      if (isWorkingDeferredTaskNotification(row)) {
        if (this.workSessionActive) continue;
        return this.takeWorkingDeferredAdmission();
      }
      this.queue.splice(i, 1);
      if (gatewayInboxClass(row) === 'heartbeat') {
        this.dropWorkingDeferred('heartbeat');
        this.workSessionActive = false;
        this.coalescedHeartbeatCount = 0;
      } else {
        this.workSessionActive = true;
      }
      return row;
    }
    return null;
  }

  sealIngress(): void { this.ingressSealed = true; }
  unsealIngress(): void { this.ingressSealed = false; }
  get ingressFenced(): boolean { return this.ingressSealed; }
  get admissionVersion(): number { return this._admissionVersion; }

  hasClass(messageClass: GatewayInboxClass): boolean {
    return this.queue.some((message) => gatewayInboxClass(message) === messageClass);
  }

  /**
   * Put recovery work ahead of ordinary feed traffic without reversing FIFO
   * order.  This is intentionally separate from push(): a fenced session must
   * run its bounded recovery heartbeat before any deferred Connect/system
   * noise is admitted again.
   */
  pushFront(messages: readonly InboundMessage[]): void {
    if (messages.length === 0) return;
    const earliestQueued = this.queue.reduce(
      (earliest, message) => Math.min(earliest, this.arrivalSequence.get(message) ?? earliest),
      this.nextArrivalSequence,
    );
    const replayStart = earliestQueued - messages.length;
    messages.forEach((message, index) => this.arrivalSequence.set(message, replayStart + index));
    if (this.resolver) {
      const [first, ...rest] = messages;
      const resolve = this.resolver;
      this.resolver = null;
      if (rest.length > 0) this.queue.unshift(...rest);
      resolve(first!);
      return;
    }
    this.queue.unshift(...messages);
  }

  /**
   * Atomically detach every not-yet-admitted feed item from the live inbox.
   * The caller durably classifies/persists the returned snapshot before a
   * successor generation is allowed to sample.
   */
  drain(): InboundMessage[] {
    return this.drainForRecovery().messages;
  }

  /**
   * Detach the queue together with admission-time heartbeat coalescing evidence.
   * Recovery persists both atomically so the priority inbox cannot hide feed
   * items that were collapsed before the generation fence drained the queue.
   */
  drainForRecovery(): { messages: InboundMessage[]; coalescedHeartbeats: number } {
    const drained = [...this.queue].sort((left, right) => (
      (this.arrivalSequence.get(left) ?? 0) - (this.arrivalSequence.get(right) ?? 0)
    ));
    this.queue = [];
    const coalescedHeartbeats = this.coalescedHeartbeatCount;
    this.coalescedHeartbeatCount = 0;
    return { messages: drained, coalescedHeartbeats };
  }

  /** Pull the next message. Blocks (awaits) until one is available. */
  async next(): Promise<InboundMessage> {
    const admitted = this.takeAdmissible();
    if (admitted) return admitted;
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
    this.arrivalSequence = new WeakMap<InboundMessage, number>();
    this.nextArrivalSequence = 0;
    this.coalescedHeartbeatCount = 0;
    this.workSessionActive = false;
    if (this.resolver) {
      // Leave the resolver hanging — the agent loop will
      // be interrupted by the process shutdown anyway.
    }
  }
}
