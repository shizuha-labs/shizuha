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
  /** PLAT-7382: model-only scroll — no render; the terminal-native scroll
   *  region sequence is the visual. Keeps the model consistent for the next
   *  natural repaint without a full-viewport-block rewrite. */
  scrollBySilent: (rows: number) => void;
  pageBy: (pages: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  /** PLAT-7382: the viewport's absolute 1-indexed screen rows for the
   *  DECSTBM region (top = aboveChromeRows + 1, bottom = above + height). */
  getGeometry: () => { top: number; bottom: number } | null;
  remeasure: () => void;
}

interface ConversationViewportProps {
  completedEntries: TranscriptEntry[];
  liveEntry?: TranscriptEntry | null;
  columns: number;
  rows: number;
  /** PLAT-7382: measured height of the chrome rendered above this viewport
   *  (error/status/header/welcome-art). The App measures it; the viewport
   *  combines it with its own measured height for the absolute region. */
  aboveChromeRows?: number;
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

/**
 * Rows the conversation viewport may occupy. Passing the full terminal
 * height here makes Yoga clip the newest lines under the composer — the
 * live "scroll down and the answer is gone" failure.
 */
export function remainingViewportRows(
  terminalRows: number,
  aboveChromeRows: number,
  belowChromeRows: number,
): number {
  return Math.max(
    1,
    Math.floor(terminalRows) - Math.max(0, aboveChromeRows) - Math.max(0, belowChromeRows),
  );
}

/** Wheel/Pg delta that actually moves, or 0 at either edge (no overscroll). */
export function clampedScrollDelta(
  currentTop: number | null,
  maxTop: number,
  delta: number,
): number {
  const cur = currentTop ?? maxTop;
  const next = Math.min(maxTop, Math.max(0, cur + delta));
  return next - cur;
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
  aboveChromeRows = 0,
}, ref) => {
  const width = Math.max(20, columns - 2);
  // `rows` is the remaining viewport, not the full terminal. An oversized
  // explicit height lets Yoga paint newest transcript lines under the composer.
  const preferredHeight = Math.max(1, rows);
  const containerRef = useRef<DOMElement>(null);
  const [height, setHeight] = useState(preferredHeight);
  useEffect(() => {
    setHeight((previous) => previous === preferredHeight ? previous : preferredHeight);
  }, [preferredHeight]);
  const syncMeasuredHeight = useCallback(() => {
    if (!containerRef.current) return;
    const measured = Math.max(1, Math.floor(measureElement(containerRef.current).height));
    // Cap at remaining rows (never over-slice). Ignore a 1-row collapse before
    // Yoga has allocated the flex child.
    const next = measured >= 2 && measured <= preferredHeight ? measured : preferredHeight;
    setHeight((previous) => previous === next ? previous : next);
  }, [preferredHeight]);

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

  // PLAT-7382: the ref is the AUTHORITATIVE scroll model; the tick state is
  // only the render trigger for the programmatic (keyboard) paths. The wheel
  // path (scrollBySilent) updates the ref alone — no render — because the
  // terminal-native scroll-region sequence is the visual; a state-driven
  // repaint would rewrite the viewport block the terminal just scrolled.
  const requestedTopRef = useRef<number | null>(null);
  const [, setRenderTick] = useState(0);
  const requestRender = useCallback(() => setRenderTick((t) => t + 1), []);
  const aboveChromeRowsRef = useRef(aboveChromeRows);
  aboveChromeRowsRef.current = aboveChromeRows;

  const clampRequested = useCallback((next: number): number | null => {
    const clamped = Math.min(maxTopRef.current, Math.max(0, next));
    return clamped >= maxTopRef.current ? null : clamped;
  }, []);

  useImperativeHandle(ref, () => ({
    scrollBy: (delta: number) => {
      const applied = clampedScrollDelta(requestedTopRef.current, maxTopRef.current, delta);
      if (applied === 0) return;
      const current = requestedTopRef.current ?? maxTopRef.current;
      requestedTopRef.current = clampRequested(current + applied);
      requestRender();
    },
    scrollBySilent: (delta: number) => {
      // Same as scrollBy: a silent model-only shift left the terminal showing
      // blank cells (PLAT-7382). Always repaint so newly revealed rows exist.
      const applied = clampedScrollDelta(requestedTopRef.current, maxTopRef.current, delta);
      if (applied === 0) return;
      const current = requestedTopRef.current ?? maxTopRef.current;
      requestedTopRef.current = clampRequested(current + applied);
      requestRender();
    },
    pageBy: (pages: number) => {
      const current = requestedTopRef.current ?? maxTopRef.current;
      requestedTopRef.current = clampRequested(
        current + pages * Math.max(1, heightRef.current - 2),
      );
      requestRender();
    },
    scrollToTop: () => {
      requestedTopRef.current = 0;
      requestRender();
    },
    scrollToBottom: () => {
      requestedTopRef.current = null;
      requestRender();
    },
    getGeometry: () => {
      if (heightRef.current < 1) return null;
      const top = aboveChromeRowsRef.current + 1;
      return { top, bottom: aboveChromeRowsRef.current + heightRef.current };
    },
    remeasure: syncMeasuredHeight,
  }), [syncMeasuredHeight, requestRender, clampRequested]);

  // Reflow changes line identities. Following the bottom is the only stable,
  // unsurprising position after a terminal-width change.
  useEffect(() => {
    requestedTopRef.current = null;
    requestRender();
  }, [width, requestRender]);

  const top = resolveViewportTop(totalLines, height, requestedTopRef.current);
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
