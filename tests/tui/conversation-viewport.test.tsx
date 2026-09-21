import React from 'react';
import { renderToString } from 'ink';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConversationViewport,
  resolveViewportTop,
  remainingViewportRows,
  clampedScrollDelta,
} from '../../src/tui/components/ConversationViewport.js';
import { flattenTranscript } from '../../src/tui/components/TranscriptPager.js';

const viewportSrc = readFileSync(
  resolve(__dirname, '../../src/tui/components/ConversationViewport.tsx'),
  'utf8',
);

describe('source-backed conversation viewport', () => {
  const longAnswer = Array.from({ length: 80 }, (_, i) => `answer line ${i}`).join('\n');
  const entries = [{
    id: 'answer',
    role: 'assistant' as const,
    content: longAnswer,
    timestamp: 1,
  }];

  it('keeps the complete answer in the transcript source', () => {
    const flattened = flattenTranscript(entries, 100);
    expect(flattened).toContain('answer line 0');
    expect(flattened).toContain('answer line 79');
    expect(flattened).not.toContain('\n  …\n');
  });

  it('computes a bounded bottom-following visual window', () => {
    expect(resolveViewportTop(100, 20, null)).toBe(80);
    expect(resolveViewportTop(100, 20, 7)).toBe(7);
    expect(resolveViewportTop(100, 20, 999)).toBe(80);
    expect(resolveViewportTop(4, 20, null)).toBe(0);
  });

  it('does not overscroll past the last line (wheel-down at bottom is a no-op)', () => {
    expect(clampedScrollDelta(null, 80, 3)).toBe(0);
    expect(clampedScrollDelta(80, 80, 3)).toBe(0);
    expect(clampedScrollDelta(0, 80, -3)).toBe(0);
    expect(clampedScrollDelta(10, 80, 3)).toBe(3);
    expect(clampedScrollDelta(79, 80, 3)).toBe(1);
  });

  it('sizes the viewport to remaining rows so the tail is not clipped under chrome', () => {
    expect(remainingViewportRows(40, 2, 5)).toBe(33);
    expect(remainingViewportRows(40, 0, 0)).toBe(40);
    expect(remainingViewportRows(10, 20, 5)).toBe(1);
    expect(remainingViewportRows(35, 2, 4)).toBe(29);
  });

  it('renders only the latest visible rows without an elision marker', () => {
    const frame = renderToString(
      <ConversationViewport
        completedEntries={entries}
        columns={100}
        rows={8}
      />,
      { columns: 100 },
    );

    expect(frame).toContain('answer line 79');
    expect(frame).not.toContain('answer line 0');
    expect(frame).not.toContain('…');
    expect(frame.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('wheel path refuses a no-op overscroll before requesting a render', () => {
    expect(viewportSrc).toContain('clampedScrollDelta(requestedTopRef.current, maxTopRef.current, delta)');
    expect(viewportSrc).toContain('if (applied === 0) return');
    expect(viewportSrc).toContain('height={preferredHeight}');
  });
});

describe('SCLI-519: multi-line slash output renders as transcript rows', () => {
  const doctorOutput = [
    'Results:',
    '- Cortex model: ok',
    '- SQLite state store: OK',
    'Fix: Model not available (model_not_found). Try /model with one of: DeepSeek-V4-Flash, grok-4.5',
  ].join('\n');

  it('keeps every /doctor diagnostic row in the transcript source', () => {
    const flattened = flattenTranscript([{
      id: 'doctor',
      role: 'assistant' as const,
      content: doctorOutput,
      timestamp: 1,
    }], 100);
    expect(flattened).toContain('Cortex model: ok');
    expect(flattened).toContain('SQLite state store: OK');
    expect(flattened).toContain('model_not_found');
    expect(flattened).toContain('DeepSeek-V4-Flash');
  });

  it('renders the recovery row byte-completely in the visible frame', () => {
    const frame = renderToString(
      <ConversationViewport
        completedEntries={[{
          id: 'doctor',
          role: 'assistant' as const,
          content: doctorOutput,
          timestamp: 1,
        }]}
        columns={120}
        rows={40}
      />,
      { columns: 120 },
    );
    expect(frame).toContain('Fix: Model not available (model_not_found).');
    expect(frame).toContain('Try /model with one of: DeepSeek-V4-Flash, grok-4.5');
    expect(frame).toContain('SQLite state store: OK');
  });
});
