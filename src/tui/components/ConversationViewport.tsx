import React, {
  useCallback,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import type { TranscriptEntry } from '../state/types.js';
import { flattenTranscript } from './TranscriptPager.js';

export interface ConversationViewportHandle {
  scrollBy: (rows: number) => void;
  pageBy: (pages: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  remeasure: () => void;
}

interface ConversationViewportProps {
  completedEntries: TranscriptEntry[];
  liveEntry?: TranscriptEntry | null;
  columns: number;
  rows: number;
}

export function resolveViewportTop(
  totalLines: number,
  rows: number,
  requestedTop: number | null,
): number {
  const maxTop = Math.max(0, totalLines - Math.max(1, rows));
  if (requestedTop === null) return maxTop;
  return Math.min(maxTop, Math.max(0, requestedTop));
}

function sliceLineSources(
  completed: string[],
  live: string[],
  start: number,
  end: number,
): string[] {
  const visible: string[] = [];
  const completedEnd = Math.min(end, completed.length);
  if (start < completedEnd) {
    visible.push(...completed.slice(start, completedEnd));
  }
  if (end > completed.length) {
    const liveStart = Math.max(0, start - completed.length);
    const liveEnd = Math.max(0, end - completed.length);
    visible.push(...live.slice(liveStart, liveEnd));
  }
  return visible;
}

/**
 * Source-backed conversation viewport. The transcript remains complete in
 * memory/SQLite; only the rows visible in the terminal participate in Ink
 * layout. A null requestedTop means follow the live bottom.
 */
export const ConversationViewport = forwardRef<ConversationViewportHandle, ConversationViewportProps>(({
  completedEntries,
  liveEntry,
  columns,
  rows,
}, ref) => {
  const width = Math.max(20, columns - 2);
  const preferredHeight = Math.max(1, rows);
  const containerRef = useRef<DOMElement>(null);
  const [height, setHeight] = useState(preferredHeight);
  const syncMeasuredHeight = useCallback(() => {
    if (!containerRef.current) return;
    const measured = Math.max(1, Math.floor(measureElement(containerRef.current).height));
    setHeight((previous) => previous === measured ? previous : measured);
  }, []);

  // The composer/status/progress chrome has variable height. Yoga allocates
  // this flex child the exact remaining terminal rows; use that measured value
  // for source slicing so the transcript fills the space without hiding its
  // final line behind an oversized virtual window.
  useEffect(syncMeasuredHeight);
  const completedLines = useMemo(() => {
    // The live surface is conversational, not a command log. Detailed tool
    // cards remain available in the explicit transcript pager (Ctrl+P).
    const text = flattenTranscript(completedEntries, width, { includeTools: false });
    return text ? text.split('\n') : [];
  }, [completedEntries, width]);
  const liveLines = useMemo(() => {
    if (!liveEntry) return [];
    const text = flattenTranscript([liveEntry], width, { includeTools: false });
    return text ? text.split('\n') : [];
  }, [liveEntry, width]);

  const totalLines = completedLines.length + liveLines.length;
  const maxTop = Math.max(0, totalLines - height);
  const maxTopRef = useRef(maxTop);
  const heightRef = useRef(height);
  maxTopRef.current = maxTop;
  heightRef.current = height;

  // null is a sticky bottom anchor: streaming output advances beneath it. A
  // numeric top remains stable while the user reads older content.
  const [requestedTop, setRequestedTop] = useState<number | null>(null);

  useImperativeHandle(ref, () => ({
    scrollBy: (delta: number) => {
      setRequestedTop((previous) => {
        const current = previous ?? maxTopRef.current;
        const next = Math.min(maxTopRef.current, Math.max(0, current + delta));
        return next >= maxTopRef.current ? null : next;
      });
    },
    pageBy: (pages: number) => {
      setRequestedTop((previous) => {
        const current = previous ?? maxTopRef.current;
        const next = Math.min(
          maxTopRef.current,
          Math.max(0, current + pages * Math.max(1, heightRef.current - 2)),
        );
        return next >= maxTopRef.current ? null : next;
      });
    },
    scrollToTop: () => setRequestedTop(0),
    scrollToBottom: () => setRequestedTop(null),
    remeasure: syncMeasuredHeight,
  }), [syncMeasuredHeight]);

  // Reflow changes line identities. Following the bottom is the only stable,
  // unsurprising position after a terminal-width change.
  useEffect(() => {
    setRequestedTop(null);
  }, [width]);

  const top = resolveViewportTop(totalLines, height, requestedTop);
  const visible = sliceLineSources(completedLines, liveLines, top, top + height);
  const topPadding = Math.max(0, height - visible.length);
  const frame = `${'\n'.repeat(topPadding)}${visible.join('\n')}`;

  return (
    <Box
      ref={containerRef}
      height={preferredHeight}
      minHeight={1}
      flexGrow={1}
      flexShrink={1}
      overflow="hidden"
      paddingX={1}
      flexDirection="column"
    >
      <Text>{frame}</Text>
    </Box>
  );
});

ConversationViewport.displayName = 'ConversationViewport';
