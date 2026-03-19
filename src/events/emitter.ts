import type { AgentEvent, AgentEventType } from './types.js';

type EventHandler = (event: AgentEvent) => void;

export class AgentEventEmitter {
  private handlers = new Map<AgentEventType | '*', Set<EventHandler>>();

  on(type: AgentEventType | '*', handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit(event: AgentEvent): void {
    // Type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) handler(event);
    }
    // Wildcard handlers
    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) handler(event);
    }
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }
}
