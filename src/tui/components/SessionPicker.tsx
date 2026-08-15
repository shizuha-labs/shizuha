import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionSummary } from '../state/types.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onCancel: () => void;
  onDelete?: (id: string) => boolean;
}

const MIN_VISIBLE_SESSIONS = 3;
const MAX_VISIBLE_SESSIONS = 16;
// Reserve rows for: App header(2) + StatusBar(2) + border(2) + title(1) + instructions(1)
// + "Showing" text(1) + marginY(2) + marginTop(1) + buffer(2) = 14
const RESERVED_ROWS = 14;

/** Format a timestamp as a relative time string */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function truncateWithEllipsis(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 1) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 1)}\u2026`;
}

function normalizeSingleLine(value: string): string {
  return (value.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function alignScrollTop(selected: number, previousTop: number, itemCount: number, visibleCapacity: number): number {
  const maxStart = Math.max(0, itemCount - visibleCapacity);
  let next = clamp(previousTop, 0, maxStart);
  if (selected < next) next = selected;
  if (selected >= next + visibleCapacity) next = Math.max(0, selected - visibleCapacity + 1);
  return clamp(next, 0, maxStart);
}

export const SessionPicker: React.FC<SessionPickerProps> = ({ sessions, onSelect, onNew, onCancel, onDelete }) => {
  const { rows, columns } = useTerminalSize();
  const [selected, setSelected] = useState(() => (sessions.length > 0 ? sessions.length : 0));
  const [scrollTop, setScrollTop] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Oldest -> newest (newest appears at bottom).
  const orderedSessions = [...sessions].reverse();
  // Items: [New Session, ...existing sessions]
  const visibleCapacity = Math.max(
    MIN_VISIBLE_SESSIONS,
    Math.min(MAX_VISIBLE_SESSIONS, rows - RESERVED_ROWS),
  );
  const itemCount = orderedSessions.length + 1;
  const newSessionIndex = 0;

  // Keep selection and viewport valid as rows/sessions change.
  useEffect(() => {
    setSelected((prev) => {
      const clamped = Math.max(0, Math.min(prev, itemCount - 1));
      return clamped;
    });
  }, [itemCount]);

  useEffect(() => {
    const maxStart = Math.max(0, itemCount - visibleCapacity);
    setScrollTop((prev) => Math.max(0, Math.min(prev, maxStart)));
  }, [itemCount, visibleCapacity]);

  const clampedSelected = clamp(selected, 0, Math.max(0, itemCount - 1));
  const effectiveSelected = clampedSelected;
  const effectiveScrollTop = alignScrollTop(clampedSelected, scrollTop, itemCount, visibleCapacity);

  useEffect(() => {
    if (scrollTop !== effectiveScrollTop) setScrollTop(effectiveScrollTop);
  }, [scrollTop, effectiveScrollTop]);

  const visibleStart = effectiveScrollTop;
  const visibleEnd = Math.min(itemCount, visibleStart + visibleCapacity);

  // Box border + padding consume horizontal room. Keep list rows to one line
  // so viewport height math remains stable in narrow tmux panes.
  const innerWidth = Math.max(24, columns - 6);
  const helpLine = truncateWithEllipsis(
    normalizeSingleLine(
      'Arrows/PgUp/PgDn: navigate | Enter: open | n: new | d: delete | Esc: cancel',
    ),
    innerWidth,
  );

  useInput((input, key) => {
    const pageUp = (key as { pageUp?: boolean }).pageUp ?? false;
    const pageDown = (key as { pageDown?: boolean }).pageDown ?? false;
    const home = (key as { home?: boolean }).home ?? false;
    const end = (key as { end?: boolean }).end ?? false;
    if (confirmDelete) {
      if (input === 'y' || input === 'Y') {
        onDelete?.(confirmDelete);
        setConfirmDelete(null);
        if (effectiveSelected >= itemCount - 1) setSelected(Math.max(0, itemCount - 2));
      } else {
        setConfirmDelete(null);
      }
      return;
    }
    if (key.upArrow) {
      setSelected((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelected((prev) => Math.min(itemCount - 1, prev + 1));
    } else if (pageUp) {
      setSelected((prev) => Math.max(0, prev - visibleCapacity));
    } else if (pageDown) {
      setSelected((prev) => Math.min(itemCount - 1, prev + visibleCapacity));
    } else if (home) {
      setSelected(0);
    } else if (end) {
      setSelected(itemCount - 1);
    } else if (key.return) {
      if (effectiveSelected === newSessionIndex) {
        onNew();
      } else {
        const session = orderedSessions[effectiveSelected - 1];
        if (session) onSelect(session.id);
      }
    } else if (key.escape) {
      onCancel();
    } else if ((key.delete || input === 'd' || input === 'x') && effectiveSelected > 0 && onDelete) {
      const session = orderedSessions[effectiveSelected - 1];
      if (session) setConfirmDelete(session.id);
    } else if ((input === 'n' || input === 'N') && !confirmDelete) {
      onNew();
    }
  });

  const renderSessionRow = (session: SessionSummary, idx: number) => {
    const isSelected = effectiveSelected === idx;
    const tokens = session.totalInputTokens + session.totalOutputTokens;
    const tokenStr = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
    const rawTitle = session.name ?? session.firstMessage ?? session.id.slice(0, 8);
    const firstLine = normalizeSingleLine(rawTitle);
    const relTime = formatRelativeTime(session.updatedAt);
    const prefix = isSelected ? '\u25B6 ' : '  ';
    const meta = `(${session.model} \u00b7 ${session.turnCount} turns \u00b7 ${tokenStr} tokens \u00b7 ${relTime})`;
    const maxTitleLen = Math.max(8, innerWidth - prefix.length - 1 - meta.length);
    const title = truncateWithEllipsis(firstLine, maxTitleLen);
    const rowText = truncateWithEllipsis(`${prefix}${title} ${meta}`, innerWidth);
    return (
      <Text key={session.id} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
        {rowText}
      </Text>
    );
  };

  const visibleRows: React.ReactNode[] = [];
  for (let idx = visibleStart; idx < visibleEnd; idx += 1) {
    if (idx === 0) {
      const isSelected = effectiveSelected === idx;
      visibleRows.push(
        <Text key="new-session" color={isSelected ? 'cyan' : undefined} bold={isSelected}>
          {truncateWithEllipsis(`${isSelected ? '\u25B6 ' : '  '}+ New Session`, innerWidth)}
        </Text>,
      );
    } else {
      const session = orderedSessions[idx - 1];
      if (session) visibleRows.push(renderSessionRow(session, idx));
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">{'\u2630'} Sessions</Text>
      <Text dimColor>{helpLine}</Text>
      {itemCount > visibleCapacity && (
        <Text dimColor>{truncateWithEllipsis(`Showing ${visibleStart + 1}-${visibleEnd} of ${itemCount} items`, innerWidth)}</Text>
      )}
      {confirmDelete && (
        <Text color="yellow">{truncateWithEllipsis(`\u26A0 Delete session ${confirmDelete.slice(0, 8)}? (y/n)`, innerWidth)}</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {visibleRows}
      </Box>
    </Box>
  );
};
