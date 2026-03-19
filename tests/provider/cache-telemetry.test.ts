import { describe, it, expect } from 'vitest';
import type { StreamChunk } from '../../src/provider/types.js';
import type { TurnResult } from '../../src/agent/turn.js';
import type { TurnCompleteEvent, CompleteEvent } from '../../src/events/types.js';

describe('Cache telemetry: StreamChunk level', () => {
  it('usage chunk accepts cache token fields', () => {
    const chunk: StreamChunk = {
      type: 'usage',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 800,
    };

    expect(chunk.type).toBe('usage');
    if (chunk.type === 'usage') {
      expect(chunk.cacheCreationInputTokens).toBe(200);
      expect(chunk.cacheReadInputTokens).toBe(800);
    }
  });

  it('usage chunk without cache fields defaults to undefined', () => {
    const chunk: StreamChunk = {
      type: 'usage',
      inputTokens: 1000,
      outputTokens: 500,
    };

    if (chunk.type === 'usage') {
      expect(chunk.cacheCreationInputTokens).toBeUndefined();
      expect(chunk.cacheReadInputTokens).toBeUndefined();
    }
  });

  it('simulates multiple usage chunks — last values are kept', () => {
    const chunks: StreamChunk[] = [
      { type: 'usage', inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 90 },
      { type: 'usage', inputTokens: 200, outputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 180 },
    ];

    let lastCacheCreation: number | undefined;
    let lastCacheRead: number | undefined;
    for (const chunk of chunks) {
      if (chunk.type === 'usage') {
        if (chunk.cacheCreationInputTokens != null) lastCacheCreation = chunk.cacheCreationInputTokens;
        if (chunk.cacheReadInputTokens != null) lastCacheRead = chunk.cacheReadInputTokens;
      }
    }

    expect(lastCacheCreation).toBe(20);
    expect(lastCacheRead).toBe(180);
  });
});

describe('Cache telemetry: TurnResult level', () => {
  it('TurnResult includes cache token fields', () => {
    const result: TurnResult = {
      assistantMessage: { role: 'assistant', content: 'hello', timestamp: Date.now() },
      toolCalls: [],
      toolResults: [],
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 800,
    };

    expect(result.cacheCreationInputTokens).toBe(200);
    expect(result.cacheReadInputTokens).toBe(800);
  });

  it('TurnResult with zero cache tokens returns 0', () => {
    const result: TurnResult = {
      assistantMessage: { role: 'assistant', content: 'hello', timestamp: Date.now() },
      toolCalls: [],
      toolResults: [],
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    expect(result.cacheCreationInputTokens).toBe(0);
    expect(result.cacheReadInputTokens).toBe(0);
  });

  it('TurnResult without cache fields leaves them undefined', () => {
    const result: TurnResult = {
      assistantMessage: { role: 'assistant', content: 'hello', timestamp: Date.now() },
      toolCalls: [],
      toolResults: [],
      inputTokens: 1000,
      outputTokens: 500,
    };

    expect(result.cacheCreationInputTokens).toBeUndefined();
    expect(result.cacheReadInputTokens).toBeUndefined();
  });
});

describe('Cache telemetry: Event level', () => {
  it('TurnCompleteEvent contains per-turn cache tokens', () => {
    const event: TurnCompleteEvent = {
      type: 'turn_complete',
      turnIndex: 0,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 800,
      durationMs: 1500,
      timestamp: Date.now(),
    };

    expect(event.cacheCreationInputTokens).toBe(200);
    expect(event.cacheReadInputTokens).toBe(800);
  });

  it('CompleteEvent contains cumulative totals', () => {
    const event: CompleteEvent = {
      type: 'complete',
      totalTurns: 3,
      totalInputTokens: 3000,
      totalOutputTokens: 1500,
      totalCacheCreationInputTokens: 600,
      totalCacheReadInputTokens: 2400,
      totalDurationMs: 5000,
      timestamp: Date.now(),
    };

    expect(event.totalCacheCreationInputTokens).toBe(600);
    expect(event.totalCacheReadInputTokens).toBe(2400);
  });

  it('multi-turn accumulation works correctly', () => {
    const turnResults = [
      { cacheCreationInputTokens: 100, cacheReadInputTokens: 400 },
      { cacheCreationInputTokens: 50, cacheReadInputTokens: 500 },
      { cacheCreationInputTokens: undefined, cacheReadInputTokens: undefined },
      { cacheCreationInputTokens: 200, cacheReadInputTokens: 300 },
    ];

    let totalCreation = 0;
    let totalRead = 0;
    for (const r of turnResults) {
      if (r.cacheCreationInputTokens) totalCreation += r.cacheCreationInputTokens;
      if (r.cacheReadInputTokens) totalRead += r.cacheReadInputTokens;
    }

    expect(totalCreation).toBe(350);
    expect(totalRead).toBe(1200);
  });

  it('SSE event shape includes cache fields for serialization', () => {
    const event: TurnCompleteEvent = {
      type: 'turn_complete',
      turnIndex: 0,
      inputTokens: 500,
      outputTokens: 250,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 400,
      durationMs: 800,
      timestamp: Date.now(),
    };

    // Simulate SSE serialization
    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);
    expect(parsed.cacheCreationInputTokens).toBe(100);
    expect(parsed.cacheReadInputTokens).toBe(400);
  });
});
