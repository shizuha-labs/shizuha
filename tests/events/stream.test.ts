import { describe, it, expect } from 'vitest';
import { toNDJSON, toSSE, fromNDJSON } from '../../src/events/stream.js';
import type { AgentEvent } from '../../src/events/types.js';

describe('stream serializers', () => {
  const event: AgentEvent = { type: 'content', text: 'hello', timestamp: 1234567890 };

  it('toNDJSON produces valid JSON line', () => {
    const line = toNDJSON(event);
    expect(line).toMatch(/\n$/);
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe('content');
    expect(parsed.text).toBe('hello');
  });

  it('toSSE produces valid SSE format', () => {
    const sse = toSSE(event);
    expect(sse).toMatch(/^event: content\n/);
    expect(sse).toMatch(/^data: /m);
    expect(sse).toMatch(/\n\n$/);
  });

  it('fromNDJSON round-trips', () => {
    const line = toNDJSON(event);
    const parsed = fromNDJSON(line);
    expect(parsed).toEqual(event);
  });

  it('fromNDJSON returns null for empty lines', () => {
    expect(fromNDJSON('')).toBeNull();
    expect(fromNDJSON('  ')).toBeNull();
  });

  it('fromNDJSON returns null for invalid JSON', () => {
    expect(fromNDJSON('not json')).toBeNull();
  });
});
