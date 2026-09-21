/**
 * SCLI-621 — Tasks pane (Ctrl+G): live background tasks/monitors/crons view.
 *
 * Covers the pure row-building/formatting helpers plus the App wiring
 * (Ctrl+G binding + pane render) via source inspection, matching the TUI
 * test conventions in this repo.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';
import { taskRowsFromRegistry, formatElapsed } from '../../src/tui/components/TasksPane.js';

const repoRoot = resolve(__dirname, '../..');
function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('SCLI-621 tasks pane row building', () => {
  it('builds live rows with id/type/status/description/line-count/elapsed', () => {
    const registry = new BackgroundTaskRegistry();
    const task = registry.create('bash', 'run the full test suite');
    registry.appendOutput(task.id, 'line one\nline two\nline three');

    const rows = taskRowsFromRegistry(registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: task.id,
      type: 'bash',
      status: 'running',
      description: 'run the full test suite',
      lines: 3,
    });
    expect(rows[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty list for a null registry', () => {
    expect(taskRowsFromRegistry(null)).toEqual([]);
  });

  it('formats elapsed time as compact seconds/minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_000)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(90_000)).toBe('1m30s');
    expect(formatElapsed(3_600_000)).toBe('60m');
  });
});

describe('SCLI-621 tasks pane wiring', () => {
  it('binds Ctrl+G to open the tasks screen', () => {
    const src = read('src/tui/App.tsx');
    expect(src).toMatch(/key\.ctrl && _input === 'g'/);
    expect(src).toMatch(/setScreen\('tasks'\)/);
  });

  it('renders TasksPane with live registry + cron accessors on the tasks screen', () => {
    const src = read('src/tui/App.tsx');
    expect(src).toContain("import { TasksPane } from './components/TasksPane.js'");
    expect(src).toContain("import { getCronJobs } from '../tools/builtin/cron.js'");
    expect(src).toMatch(/screen === 'tasks'[\s\S]*<TasksPane[\s\S]*getTaskRegistry={getTaskRegistry}[\s\S]*getCronJobs={getCronJobs}/);
  });

  it('exposes getCronJobs from the shared cron store', () => {
    const src = read('src/tools/builtin/cron.ts');
    expect(src).toContain('export function getCronJobs');
    expect(src).toMatch(/sharedStore\.listJobs\(false\)/);
  });
});
