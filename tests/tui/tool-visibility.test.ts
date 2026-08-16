import { describe, it, expect } from 'vitest';
import type { ToolCallEntry } from '../../src/tui/state/types.js';
import { getVisibleToolCalls } from '../../src/tui/utils/toolVisibility.js';

function runningTool(id: string): ToolCallEntry {
  return {
    id,
    name: 'bash',
    input: { command: 'echo hi' },
    status: 'running',
  };
}

function completedTool(id: string): ToolCallEntry {
  return {
    id,
    name: 'bash',
    input: { command: 'echo hi' },
    status: 'complete',
    result: 'hi',
  };
}

describe('getVisibleToolCalls', () => {
  it('returns active running tools when present', () => {
    const visible = getVisibleToolCalls([runningTool('r1')], completedTool('c1'));
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe('r1');
    expect(visible[0]!.status).toBe('running');
  });

  it('clears completed tools from the live surface immediately', () => {
    const visible = getVisibleToolCalls([], completedTool('c1'));
    expect(visible).toEqual([]);
  });

  it('returns empty when nothing to show', () => {
    expect(getVisibleToolCalls([], null)).toEqual([]);
  });
});
