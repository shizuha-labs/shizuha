import React, { useState, useEffect } from 'react';
import { useStdout, useInput } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { TranscriptEntry } from '../state/types.js';
import { renderMarkdown } from '../utils/markdown.js';
interface TranscriptPagerProps {
  entries?: TranscriptEntry[];
  rawContent?: string;
  onExit: () => void;
}

function flattenTranscript(entries: TranscriptEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.role === 'system') {
      parts.push(`  \x1b[2m${entry.content}\x1b[0m`);
    } else if (entry.role === 'user') {
      parts.push(`\x1b[1;34m\u25B6 You\x1b[0m`);
      parts.push(`  ${entry.content}`);
    } else {
      parts.push(`\x1b[1;32m\u25C6 Shizuha\x1b[0m`);
      if (entry.reasoningSummaries?.length) {
        for (const s of entry.reasoningSummaries) {
          parts.push(`  \x1b[2;3m\u2022 ${s}\x1b[0m`);
        }
      }
      if (entry.content) {
        const rendered = renderMarkdown(entry.content);
        parts.push(...rendered.split('\n').map((l) => `  ${l}`));
      }
      if (entry.toolCalls) {
        for (const tc of entry.toolCalls) {
          const icon = tc.isError ? '\x1b[31m\u2717\x1b[0m' : '\x1b[32m\u2713\x1b[0m';
          const preview = tc.commandPreview ? ` \x1b[2m${tc.commandPreview}\x1b[0m` : '';
          parts.push(`  ${icon} \x1b[1;33m${tc.name}\x1b[0m${preview}${tc.durationMs != null ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : ''}`);
          if (tc.result) {
            const lines = tc.result.split('\n');
            const truncated = lines.length > 10 ? [...lines.slice(0, 5), `  ... +${lines.length - 10} lines ...`, ...lines.slice(-5)] : lines;
            parts.push(...truncated.map((l) => `    ${l}`));
          }
        }
      }
    }
    parts.push('');
  }
  return parts.join('\n');
}

/** Full-screen alternate-screen pager with vim-style navigation */
export const TranscriptPager: React.FC<TranscriptPagerProps> = ({ entries, rawContent, onExit }) => {
  const { write } = useStdout();
  const { rows, columns } = useTerminalSize();
  const [scrollOffset, setScrollOffset] = useState(0);

  const content = rawContent ?? (entries ? flattenTranscript(entries) : '');
  const allLines = content.split('\n');
  // Visible area: rows minus 1 for footer bar
  const pageSize = Math.max(1, rows - 2);
  const maxOffset = Math.max(0, allLines.length - pageSize);

  // Enter alternate screen on mount, leave on unmount
  useEffect(() => {
    write('\x1b[?1049h'); // enter alternate screen
    write('\x1b[?25l');   // hide cursor
    return () => {
      write('\x1b[?25l');   // ensure cursor state before restoring
      write('\x1b[?1049l'); // leave alternate screen
      write('\x1b[?25h');   // show cursor
    };
  }, [write]);

  // Render the visible portion directly via stdout
  useEffect(() => {
    const visibleLines = allLines.slice(scrollOffset, scrollOffset + pageSize);
    const endLine = Math.min(scrollOffset + pageSize, allLines.length);
    const footer = `\x1b[7m line ${scrollOffset + 1}-${endLine} of ${allLines.length} | j/k scroll | Ctrl+F/B page | G end | g top | q quit \x1b[0m`;

    // Build the full screen
    const output: string[] = [];
    output.push('\x1b[H\x1b[2J'); // Move to top-left and clear screen
    for (const line of visibleLines) {
      output.push(line.slice(0, columns));
    }
    // Pad empty lines
    for (let i = visibleLines.length; i < pageSize; i++) {
      output.push('~');
    }
    output.push(footer);
    write(output.join('\n'));
  }, [scrollOffset, allLines, pageSize, columns, rows, write]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onExit();
      return;
    }
    // j = scroll down 1 line
    if (input === 'j') {
      setScrollOffset((prev) => Math.min(prev + 1, maxOffset));
    }
    // k = scroll up 1 line
    if (input === 'k') {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
    }
    // Ctrl+F = page down
    if (key.ctrl && input === 'f') {
      setScrollOffset((prev) => Math.min(prev + pageSize, maxOffset));
    }
    // Ctrl+B = page up
    if (key.ctrl && input === 'b') {
      setScrollOffset((prev) => Math.max(prev - pageSize, 0));
    }
    // G = go to end
    if (input === 'G') {
      setScrollOffset(maxOffset);
    }
    // g = go to top
    if (input === 'g') {
      setScrollOffset(0);
    }
    // Down arrow = scroll down
    if (key.downArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxOffset));
    }
    // Up arrow = scroll up
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
    }
  });

  // Don't render anything in the Ink tree — we're writing directly to stdout
  return null;
};
