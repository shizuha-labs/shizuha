/**
 * Idle-boundary self-update for ordinary host-installed TUI sessions.
 *
 * The official installer remains the single update path.  This layer only
 * decides when it is safe to invoke it and how to resume the same durable TUI
 * session afterward.  Immutable container/pod runtimes are always excluded;
 * Hive/runtime-image rollout owns those installations.
 */
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { PermissionMode } from '../permissions/types.js';
import {
  automaticUpdatesEnabled,
  checkForUpdate,
  isSourceInstall,
  readInstalledSha,
  runInstaller,
} from '../commands/update.js';
import { isDaemonRunning } from '../shared/is-daemon-running.js';

const NORMAL_CHECK_INTERVAL_MS = 15 * 60_000;
const DAEMON_WAIT_RETRY_MS = 30_000;
const FAILURE_RETRY_MS = 5 * 60_000;

let nextCheckAt = 0;
let inFlight = false;
// Capture the artifact identity before another local process can replace the
// installed tree. This lets a long-running TUI notice that the daemon already
// updated the files and restart itself without reinstalling them.
const processInstalledSha = readInstalledSha();

export interface TuiAutoUpdateState {
  ready: boolean;
  isProcessing: boolean;
  hasPendingApproval: boolean;
  queuedPromptCount: number;
  runningTaskCount: number;
  hasDraftInput: boolean;
  onPromptScreen: boolean;
}

export interface TuiRestartContext {
  cwd: string;
  sessionId: string | null;
  model?: string;
  mode: PermissionMode;
}

export function tuiIsSafeToUpdate(state: TuiAutoUpdateState): boolean {
  return state.ready
    && !state.isProcessing
    && !state.hasPendingApproval
    && state.queuedPromptCount === 0
    && state.runningTaskCount === 0
    && !state.hasDraftInput
    && state.onPromptScreen;
}

export function buildTuiRestartArgs(ctx: TuiRestartContext): string[] {
  if (ctx.sessionId) {
    return ['resume', ctx.sessionId, '--cwd', ctx.cwd, '--mode', ctx.mode];
  }
  const args = ['--cwd', ctx.cwd, '--mode', ctx.mode];
  if (ctx.model) args.push('--model', ctx.model);
  return args;
}

export type TuiAutoUpdateResult =
  | { action: 'none' }
  | { action: 'waiting-for-daemon' }
  | { action: 'restart'; version: string | null };

export async function maybeAutoUpdateTui(
  state: TuiAutoUpdateState,
  now = Date.now(),
): Promise<TuiAutoUpdateResult> {
  if (!tuiIsSafeToUpdate(state) || inFlight || now < nextCheckAt) return { action: 'none' };
  if (!automaticUpdatesEnabled() || isSourceInstall()) {
    nextCheckAt = Number.POSITIVE_INFINITY;
    return { action: 'none' };
  }

  inFlight = true;
  try {
    const check = await checkForUpdate();
    const runningArtifactIsCurrent = Boolean(
      processInstalledSha && check.latestSha && processInstalledSha === check.latestSha,
    );
    if (runningArtifactIsCurrent) {
      nextCheckAt = now + NORMAL_CHECK_INTERVAL_MS;
      return { action: 'none' };
    }

    // Another local process (normally the daemon's idle updater) may already
    // have installed the release. Only this TUI process is stale: restart it
    // directly without downloading/installing the same artifact again.
    if (check.latestSha && readInstalledSha() === check.latestSha) {
      return { action: 'restart', version: check.latestVersion };
    }

    if (!check.updateAvailable) {
      nextCheckAt = now + NORMAL_CHECK_INTERVAL_MS;
      return { action: 'none' };
    }

    // The daemon owns several independent sessions and has a stronger
    // all-agents-idle gate. Do not let one idle TUI interrupt a busy daemon;
    // wait for it to install, then the branch above restarts this TUI.
    if (isDaemonRunning()) {
      nextCheckAt = now + DAEMON_WAIT_RETRY_MS;
      return { action: 'waiting-for-daemon' };
    }

    const code = await runInstaller({ quiet: true });
    if (code !== 0) throw new Error(`installer exited with status ${code}`);
    return { action: 'restart', version: check.latestVersion };
  } catch {
    nextCheckAt = now + FAILURE_RETRY_MS;
    return { action: 'none' };
  } finally {
    inFlight = false;
  }
}

export function restartInstalledTui(ctx: TuiRestartContext): ChildProcess {
  const home = process.env['SHIZUHA_DIR'] ?? path.join(process.env['HOME'] ?? os.homedir(), '.shizuha');
  const executable = path.join(home, 'bin', 'shizuha');
  const child = spawn(executable, buildTuiRestartArgs(ctx), {
    cwd: ctx.cwd,
    stdio: 'inherit',
    env: { ...process.env, SHIZUHA_AUTO_UPDATE_RESTARTED: '1' },
  });
  return child;
}

export function __resetTuiAutoUpdateForTest(): void {
  nextCheckAt = 0;
  inFlight = false;
}
