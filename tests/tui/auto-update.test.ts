import { describe, expect, it } from 'vitest';

import { automaticUpdatesEnabled, isManagedRuntimeEnvironment } from '../../src/commands/update.js';
import { buildTuiRestartArgs, tuiIsSafeToUpdate } from '../../src/tui/auto-update.js';

describe('host runtime automatic updates', () => {
  it('never self-updates immutable Kubernetes or container runtimes', () => {
    expect(isManagedRuntimeEnvironment({ KUBERNETES_SERVICE_HOST: '10.43.0.1' }, () => false)).toBe(true);
    expect(isManagedRuntimeEnvironment({}, (file) => file === '/.dockerenv')).toBe(true);
    expect(automaticUpdatesEnabled({ SHIZUHA_AUTO_UPDATE: '1', KUBERNETES_SERVICE_HOST: '10.43.0.1' }, () => false)).toBe(false);
  });

  it('defaults host installs on and preserves an explicit opt-out', () => {
    expect(automaticUpdatesEnabled({}, () => false)).toBe(true);
    expect(automaticUpdatesEnabled({ SHIZUHA_AUTO_UPDATE: '0' }, () => false)).toBe(false);
  });
});

describe('TUI idle update boundary', () => {
  const idle = {
    ready: true,
    isProcessing: false,
    hasPendingApproval: false,
    queuedPromptCount: 0,
    runningTaskCount: 0,
    hasDraftInput: false,
    onPromptScreen: true,
  };

  it('updates only when the whole interactive surface is idle', () => {
    expect(tuiIsSafeToUpdate(idle)).toBe(true);
    expect(tuiIsSafeToUpdate({ ...idle, isProcessing: true })).toBe(false);
    expect(tuiIsSafeToUpdate({ ...idle, hasPendingApproval: true })).toBe(false);
    expect(tuiIsSafeToUpdate({ ...idle, queuedPromptCount: 1 })).toBe(false);
    expect(tuiIsSafeToUpdate({ ...idle, runningTaskCount: 1 })).toBe(false);
    expect(tuiIsSafeToUpdate({ ...idle, hasDraftInput: true })).toBe(false);
  });

  it('restarts into the same durable session and working directory', () => {
    expect(buildTuiRestartArgs({
      cwd: '/work/repo', sessionId: 'session-123', model: 'cortex/model', mode: 'supervised',
    })).toEqual(['resume', 'session-123', '--cwd', '/work/repo', '--mode', 'supervised']);
    expect(buildTuiRestartArgs({
      cwd: '/work/repo', sessionId: null, model: 'cortex/model', mode: 'autonomous',
    })).toEqual(['--cwd', '/work/repo', '--mode', 'autonomous', '--model', 'cortex/model']);
  });
});
