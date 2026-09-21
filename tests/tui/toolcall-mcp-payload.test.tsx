/**
 * SCLI-562: ToolCall render path must not clone/re-stringify the full MCP
 * invocation payload per frame.
 *
 * The renderer memoizes derived preview strings on the entry/input reference
 * (codex mcp.rs borrow-not-clone technique), and previewToolInput truncates
 * values to a bounded window. These tests pin the contract:
 *   - a large structured MCP payload renders a bounded, truncated preview
 *     (no full-payload clone/stringify in the output);
 *   - previewToolInput output stays bounded as payload size grows.
 */
import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { ToolCall } from '../../src/tui/components/ToolCall.js';
import { previewToolInput } from '../../src/tui/utils/toolInputPreview.js';
import type { ToolCallEntry } from '../../src/tui/state/types.js';

function bigMcpEntry(payloadSize: number): ToolCallEntry {
  // A structured MCP invocation payload: nested args with a large blob.
  const bigBlob = 'x'.repeat(payloadSize);
  return {
    id: 'mcp-big',
    name: 'mcp__some-server__some_tool',
    input: {
      file_path: '/repo/src/main.ts',
      args: { query: 'search term', blob: bigBlob, nested: { a: [1, 2, 3], b: { c: 'deep' } } },
    },
    status: 'complete',
  };
}

describe('SCLI-562 ToolCall MCP payload render path', () => {
  it('renders a bounded preview for a large MCP invocation payload', () => {
    const frame = renderToString(
      <ToolCall entry={bigMcpEntry(200_000)} verbosity="normal" />,
      { columns: 100 },
    );
    // The full 200KB blob must NOT appear in the rendered output.
    expect(frame).not.toContain('x'.repeat(200_000));
    // The preview is present and truncated.
    expect(frame).toContain('file_path');
    expect(frame).toContain('/repo/src/main.ts');
    // Output stays compact (bounded by the truncation window, not payload size).
    expect(frame.length).toBeLessThan(10_000);
  });

  it('keeps previewToolInput output bounded as payload size grows', () => {
    const small = previewToolInput(bigMcpEntry(1_000).input, 2);
    const large = previewToolInput(bigMcpEntry(1_000_000).input, 2);
    // Same number of preview lines regardless of payload size.
    expect(large.length).toBe(small.length);
    // Each line stays within the truncation window.
    for (const line of large) {
      expect(line.length).toBeLessThan(200);
    }
  });

  it('renders the MCP server/tool summary from the entry name', () => {
    const frame = renderToString(
      <ToolCall entry={bigMcpEntry(10_000)} verbosity="normal" />,
      { columns: 100 },
    );
    expect(frame).toContain('mcp');
    expect(frame).toContain('some-server');
    expect(frame).toContain('some_tool');
  });
});
