/**
 * Runtime-update availability check for the daemon (operator directive
 * 2026-07-05). Notify-by-default: a loud log line when a newer release is
 * published. Host binary installs self-update by default, but only after the
 * manager confirms every runtime session is idle. Immutable container/pod
 * installs never self-update; Hive/runtime-image rollout owns those binaries.
 * Never throws — a broken updater must not affect the daemon.
 */
import {
  automaticUpdatesEnabled,
  checkForUpdate,
  isSourceInstall,
  scheduleInstaller,
} from '../commands/update.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const IDLE_RETRY_MS = 5 * 1000;

export interface UpdateCheckerOptions {
  log?: (msg: string) => void;
  isIdle?: () => boolean;
  applyUpdate?: () => Promise<number>;
  check?: typeof checkForUpdate;
  sourceInstall?: () => boolean;
  updatesEnabled?: () => boolean;
  startupDelayMs?: number;
  checkIntervalMs?: number;
  idleRetryMs?: number;
}

export function updateCanApply(isIdle: () => boolean = () => true): boolean {
  try { return isIdle(); } catch { return false; }
}

export function startUpdateChecker(options: UpdateCheckerOptions | ((msg: string) => void) = {}): () => void {
  const normalized = typeof options === 'function' ? { log: options } : options;
  const log = normalized.log ?? console.log;
  const isIdle = normalized.isIdle ?? (() => true);
  const check = normalized.check ?? checkForUpdate;
  const sourceInstall = normalized.sourceInstall ?? isSourceInstall;
  const updatesEnabled = normalized.updatesEnabled ?? automaticUpdatesEnabled;
  const applyUpdate = normalized.applyUpdate ?? (async () => {
    await scheduleInstaller();
    return 0;
  });
  const startupDelayMs = normalized.startupDelayMs ?? STARTUP_DELAY_MS;
  const checkIntervalMs = normalized.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const idleRetryMs = normalized.idleRetryMs ?? IDLE_RETRY_MS;
  let pending = false;
  let running = false;
  let applied = false;
  let idleRetry: NodeJS.Timeout | null = null;

  const stopIdleRetry = (): void => {
    if (idleRetry) clearInterval(idleRetry);
    idleRetry = null;
  };

  const applyPending = async (): Promise<void> => {
    if (!pending || running || applied || !updateCanApply(isIdle)) return;
    running = true;
    try {
      log('[update] All sessions idle — installing the latest Shizuha runtime and restarting…');
      const code = await applyUpdate();
      if (code !== 0) throw new Error(`installer exited with status ${code}`);
      applied = true;
      pending = false;
      stopIdleRetry();
    } catch (err) {
      log(`[update] apply deferred after failure: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  const detect = async (): Promise<void> => {
    if (running || applied) return;
    try {
      if (sourceInstall()) return;
      const result = await check();
      if (!result.updateAvailable) return;
      log(`[update] Newer Shizuha runtime available (${result.reason}).`);
      if (!updatesEnabled()) {
        log('[update] Automatic updates disabled; run: shizuha update');
        return;
      }
      pending = true;
      if (!updateCanApply(isIdle)) {
        log('[update] Waiting for all runtime sessions to become idle…');
        if (!idleRetry) {
          idleRetry = setInterval(() => { void applyPending(); }, idleRetryMs);
          idleRetry.unref?.();
        }
        return;
      }
      await applyPending();
    } catch (err) {
      log(`[update] check skipped: ${(err as Error).message}`);
    }
  };

  const startup = setTimeout(() => { void detect(); }, startupDelayMs);
  const checks = setInterval(() => { void detect(); }, checkIntervalMs);
  startup.unref?.(); checks.unref?.();
  return () => {
    clearTimeout(startup);
    clearInterval(checks);
    stopIdleRetry();
  };
}
