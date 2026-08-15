import React, { useState, useEffect, useMemo } from 'react';
import { useStdout, useInput } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { TranscriptEntry } from '../state/types.js';
import { renderMarkdown } from '../utils/markdown.js';
import wrapAnsi from 'wrap-ansi';

interface TranscriptPagerProps {
  entries?: TranscriptEntry[];
  rawContent?: string;
  onExit: () => void;
  /** Main App already owns the alternate screen. Standalone mounts opt in. */
  manageAlternateScreen?: boolean;
}

interface FlattenTranscriptOptions {
  /** Tool details belong in the explicit pager, not the live conversation. */
  includeTools?: boolean;
}

/** Pure helper — exported for unit tests (SCLI-382). */
export function flattenTranscript(
  entries: TranscriptEntry[],
  columns = 80,
  options: FlattenTranscriptOptions = {},
): string {
  const includeTools = options.includeTools ?? true;
  const width = Math.max(20, columns);
  const appendWrapped = (parts: string[], value: string, indent: string): void => {
    const wrapped = wrapAnsi(value, Math.max(4, width - indent.length), {
      hard: true,
      trim: false,
      wordWrap: true,
    });
    parts.push(...wrapped.split('\n').map((line) => `${indent}${line}`));
  };
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.role === 'system') {
      appendWrapped(parts, `\x1b[2m${entry.content}\x1b[0m`, '  ');
    } else if (entry.role === 'user') {
      parts.push(`\x1b[1;34m\u25B6 You\x1b[0m`);
      appendWrapped(parts, renderMarkdown(entry.content, width - 2), '  ');
    } else {
      parts.push(`\x1b[1;32m\u25C6 Shizuha\x1b[0m`);
      if (entry.reasoningSummaries?.length) {
        for (const s of entry.reasoningSummaries) {
          parts.push(`  \x1b[2;3m\u2022 ${s}\x1b[0m`);
        }
      }
      if (entry.content) {
        const rendered = renderMarkdown(entry.content, width - 2);
        appendWrapped(parts, rendered, '  ');
      }
      if (includeTools && entry.toolCalls) {
        for (const tc of entry.toolCalls) {
          const icon = tc.isError ? '\x1b[31m\u2717\x1b[0m' : '\x1b[32m\u2713\x1b[0m';
          const preview = tc.commandPreview ? ` \x1b[2m${tc.commandPreview}\x1b[0m` : '';
          parts.push(`  ${icon} \x1b[1;33m${tc.name}\x1b[0m${preview}${tc.durationMs != null ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : ''}`);
          if (tc.result) {
            const lines = tc.result.split('\n');
            const truncated = lines.length > 10 ? [...lines.slice(0, 5), `  ... +${lines.length - 10} lines ...`, ...lines.slice(-5)] : lines;
            for (const line of truncated) appendWrapped(parts, line, '    ');
          }
        }
      }
    }
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Full-screen alternate-screen pager with vim-style navigation.
 *
 * SCLI-382: must be the ONLY Ink child while open — parent chrome (header /
 * StatusBar) re-paints the alt screen and blanks the middle canvas.
 */
export const TranscriptPager: React.FC<TranscriptPagerProps> = ({
  entries,
  rawContent,
  onExit,
  manageAlternateScreen = true,
}) => {
  const { write } = useStdout();
  const { rows, columns } = useTerminalSize();

  const content = useMemo(
    () => rawContent ?? (entries && entries.length > 0 ? flattenTranscript(entries, columns) : ''),
    [rawContent, entries, columns],
  );
  const allLines = useMemo(() => {
    if (!content) {
      return [
        '',
        '  (empty transcript)',
        '  Nothing to show yet — complete a turn, then press Ctrl+P again.',
        '',
      ];
    }
    return content.split('\n');
  }, [content]);

  // Header + footer take 2 rows
  const pageSize = Math.max(1, rows - 2);
  const maxOffset = Math.max(0, allLines.length - pageSize);
  // Start at the end so the latest response is visible immediately (SCLI-382).
  const [scrollOffset, setScrollOffset] = useState(maxOffset);

  // Keep offset valid when terminal resizes or content changes
  useEffect(() => {
    setScrollOffset((prev) => Math.min(Math.max(0, prev), maxOffset));
  }, [maxOffset]);

  // Enter alternate screen on mount, leave on unmount
  useEffect(() => {
    if (!manageAlternateScreen) return;
    write('\x1b[?1049h'); // enter alternate screen
    write('\x1b[?25l');   // hide cursor
    return () => {
      write('\x1b[?25h');   // show cursor
      write('\x1b[?1049l'); // leave alternate screen
    };
  }, [manageAlternateScreen, write]);

  // Render the visible portion directly via stdout (not Ink layout)
  useEffect(() => {
    const clamped = Math.min(Math.max(0, scrollOffset), maxOffset);
    const visibleLines = allLines.slice(clamped, clamped + pageSize);
    const endLine = Math.min(clamped + pageSize, allLines.length);
    const title = `\x1b[7m Transcript  ·  line ${clamped + 1}-${endLine} of ${allLines.length}  ·  j/k · PgUp/PgDn · g/G · q/Esc exit \x1b[0m`;

    const output: string[] = [];
    output.push('\x1b[H\x1b[2J'); // home + clear
    output.push(title.slice(0, Math.max(0, columns)));
    for (const line of visibleLines) {
      // Avoid slicing mid-ANSI when possible: pad/truncate display width loosely
      output.push(line.length > columns + 32 ? line.slice(0, columns + 32) : line);
    }
    for (let i = visibleLines.length; i < pageSize; i++) {
      output.push('\x1b[2m~\x1b[0m');
    }
    write(output.join('\n'));
  }, [scrollOffset, allLines, pageSize, columns, maxOffset, write]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onExit();
      return;
    }
    if (input === 'j' || key.downArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxOffset));
      return;
    }
    if (input === 'k' || key.upArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
      return;
    }
    // Page down: Ctrl+F, PageDown, space
    if ((key.ctrl && input === 'f') || key.pageDown || input === ' ') {
      setScrollOffset((prev) => Math.min(prev + pageSize, maxOffset));
      return;
    }
    // Page up: Ctrl+B, PageUp
    if ((key.ctrl && input === 'b') || key.pageUp) {
      setScrollOffset((prev) => Math.max(prev - pageSize, 0));
      return;
    }
    if (input === 'G') {
      setScrollOffset(maxOffset);
      return;
    }
    if (input === 'g') {
      setScrollOffset(0);
    }
  });

  // Don't render anything in the Ink tree — we write directly to stdout
  return null;
};
