import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  ConversationViewport,
  resolveViewportTop,
} from '../../src/tui/components/ConversationViewport.js';
import { flattenTranscript } from '../../src/tui/components/TranscriptPager.js';

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
});
