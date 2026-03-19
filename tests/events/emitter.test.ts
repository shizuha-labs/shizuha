import { describe, it, expect } from 'vitest';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import type { AgentEvent } from '../../src/events/types.js';

describe('AgentEventEmitter', () => {
  it('emits to typed handlers', () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    emitter.on('content', (e) => received.push(e));

    emitter.emit({ type: 'content', text: 'hello', timestamp: Date.now() });
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('content');
  });

  it('emits to wildcard handlers', () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    emitter.on('*', (e) => received.push(e));

    emitter.emit({ type: 'content', text: 'hello', timestamp: Date.now() });
    emitter.emit({ type: 'error', error: 'oops', timestamp: Date.now() });
    expect(received).toHaveLength(2);
  });

  it('unsubscribes correctly', () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    const unsub = emitter.on('content', (e) => received.push(e));

    emitter.emit({ type: 'content', text: 'first', timestamp: Date.now() });
    unsub();
    emitter.emit({ type: 'content', text: 'second', timestamp: Date.now() });
    expect(received).toHaveLength(1);
  });

  it('removeAllListeners clears everything', () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    emitter.on('*', (e) => received.push(e));

    emitter.removeAllListeners();
    emitter.emit({ type: 'content', text: 'hello', timestamp: Date.now() });
    expect(received).toHaveLength(0);
  });
});
