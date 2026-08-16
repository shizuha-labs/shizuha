import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from '../../src/tui/components/MessageBlock.js';
import type { TranscriptEntry } from '../../src/tui/state/types.js';

describe('MessageBlock live event ordering', () => {
  it('renders accumulated assistant text before the currently running tool', () => {
    const entry: TranscriptEntry = {
      id: 'assistant-live',
      role: 'assistant',
      content: 'I checked the endpoint and am now running the diagnostic.',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [{
        id: 'tool-bash',
        name: 'bash',
        input: { command: 'kubectl get pods -A' },
        status: 'running',
      }],
    };

    const frame = renderToString(
      <MessageBlock entry={entry} verbosity="normal" processingLabel="Working..." />,
      { columns: 100 },
    );

    const textIndex = frame.indexOf('I checked the endpoint');
    const toolIndex = frame.indexOf('bash');

    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(textIndex);
  });

  it('continues to omit completed tool cards from the transcript', () => {
    const entry: TranscriptEntry = {
      id: 'assistant-complete',
      role: 'assistant',
      content: 'The diagnostic completed.',
      timestamp: Date.now(),
      isStreaming: false,
      toolCalls: [{
        id: 'tool-bash',
        name: 'bash',
        input: { command: 'kubectl get pods -A' },
        status: 'complete',
        result: 'pod/example Running',
      }],
    };

    const frame = renderToString(
      <MessageBlock entry={entry} verbosity="normal" />,
      { columns: 100 },
    );

    expect(frame).toContain('The diagnostic completed.');
    expect(frame).not.toContain('kubectl get pods -A');
    expect(frame).not.toContain('pod/example Running');
  });
});
