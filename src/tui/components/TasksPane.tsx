import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getComposerTheme } from '../utils/composerTheme.js';
import type { BackgroundTaskRegistry } from '../../tasks/registry.js';

/** Cron job summary used by the tasks pane (SCLI-621). */
export interface TasksPaneCron {
  id: string;
  name: string;
  schedule: string;
  nextRunAt: string;
}

interface TasksPaneProps {
  /** Live registry accessor — the pane polls it on an interval. */
  getTaskRegistry: () => BackgroundTaskRegistry | null;
  /** Optional cron accessor (shared store; null when the cron system is off). */
  getCronJobs?: () => TasksPaneCron[] | null;
  onExit: () => void;
}

interface TaskRow {
  id: string;
  type: string;
  status: string;
  description: string;
  lines: number;
  elapsedMs: number;
}

const STATUS_COLOR: Record<string, string> = {
  running: 'green',
  pending: 'yellow',
  completed: 'dim',
  failed: 'red',
  killed: 'yellow',
};

/** Build display rows from a live registry (pure — unit-testable). */
export function taskRowsFromRegistry(registry: BackgroundTaskRegistry | null): TaskRow[] {
  if (!registry) return [];
  return registry.list().map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    description: t.description,
    lines: t.output.split('\n').length,
    elapsedMs: Date.now() - t.createdAt,
  }));
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem > 0 ? `${rem}s` : ''}`;
}

/**
 * Tasks pane (Ctrl+G) — live view of background tasks and cron jobs.
 *
 * SCLI-621: Grok Build's TUI has a tasks pane showing running subagents,
 * background tasks, monitors, and /loop tasks with live line-count badges.
 * This pane lists every background task in the registry plus active cron jobs,
 * refreshing from the shared poll loop so it stays live without blocking the
 * prompt.
 */
export const TasksPane: React.FC<TasksPaneProps> = ({ getTaskRegistry, getCronJobs, onExit }) => {
  const theme = getComposerTheme();
  const bg = theme.background;
  const chrome = theme.background;

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [crons, setCrons] = useState<TasksPaneCron[] | null>(null);

  useInput((input, key) => {
    // Dismiss keys — fully consumed, never leak to the composer.
    if (key.escape || input === 'q' || input === 'Q' || key.return) {
      onExit();
      return;
    }
  });

  useEffect(() => {
    const refresh = () => {
      setTasks(taskRowsFromRegistry(getTaskRegistry()));
      setCrons(getCronJobs?.() ?? null);
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    interval.unref?.();
    return () => clearInterval(interval);
  }, [getTaskRegistry, getCronJobs]);

  const runningCount = tasks.filter((t) => t.status === 'running' || t.status === 'pending').length;

  return (
    <Box flexDirection="column" marginY={1} paddingX={2} paddingY={1}>
      <Text bold backgroundColor={bg}> Tasks </Text>
      <Text dimColor backgroundColor={bg}> Esc or q closes   ·   {runningCount} running · {tasks.length} total{tasks.length > 0 ? ' · refreshes live' : ''}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Background Tasks </Text>
        {tasks.length === 0 ? (
          <Text dimColor backgroundColor={bg}>   No background tasks.</Text>
        ) : (
          tasks.map((t) => (
            <Text key={t.id} dimColor backgroundColor={bg}>
              {'  '}
              <Text color={STATUS_COLOR[t.status] ?? 'white'}>{t.status.padEnd(9)}</Text>
              <Text color="cyan">{t.id}</Text>
              {'  '}
              <Text color="yellow">[{t.type}]</Text>
              {'  '}
              {t.description.length > 48 ? `${t.description.slice(0, 45)}...` : t.description}
              {'  · '}
              <Text color="magenta">{t.lines} lines</Text>
              {' · '}
              <Text color="green">{formatElapsed(t.elapsedMs)}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Cron Jobs </Text>
        {crons === null ? (
          <Text dimColor backgroundColor={bg}>   Cron system not initialized (interactive session).</Text>
        ) : crons.length === 0 ? (
          <Text dimColor backgroundColor={bg}>   No active cron jobs.</Text>
        ) : (
          crons.map((c) => (
            <Text key={c.id} dimColor backgroundColor={bg}>
              {'  '}
              <Text color="cyan">{c.id}</Text>
              {'  '}
              {c.name}
              {'  · '}
              <Text color="yellow">{c.schedule}</Text>
              {' · next '}
              <Text color="green">{new Date(c.nextRunAt).toLocaleString()}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
};
