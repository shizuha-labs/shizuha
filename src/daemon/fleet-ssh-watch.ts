import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FleetSshCredentialWatch {
  close(): void;
}

export interface FleetSshCredentialWatchOptions {
  sshRootDir: string;
  onCredentialReady: (username: string) => void;
  debounceMs?: number;
}

function hasPrivateKey(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) =>
      entry.isFile()
      && !entry.name.endsWith('.pub')
      && entry.name !== 'known_hosts'
      && entry.name !== 'config',
    );
  } catch {
    return false;
  }
}

/**
 * Watch the per-agent fleet-SSH store and emit a readiness edge when material
 * appears. This lets a failed privileged start clear its exponential backoff
 * immediately instead of waiting for the generic one-minute reconcile tick.
 */
export function watchFleetSshCredentialStores(
  options: FleetSshCredentialWatchOptions,
): FleetSshCredentialWatch {
  const debounceMs = Math.max(25, options.debounceMs ?? 250);
  const watchers = new Map<string, fs.FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  fs.mkdirSync(options.sshRootDir, { recursive: true, mode: 0o700 });

  const signalIfReady = (username: string): void => {
    if (closed || !username) return;
    const existing = timers.get(username);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(username);
      if (!closed && hasPrivateKey(path.join(options.sshRootDir, username))) {
        options.onCredentialReady(username);
      }
    }, debounceMs);
    timer.unref?.();
    timers.set(username, timer);
  };

  const syncAgentWatchers = (): void => {
    if (closed) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(options.sshRootDir, { withFileTypes: true });
    } catch {
      return;
    }
    const current = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
    for (const [username, watcher] of watchers) {
      if (current.has(username)) continue;
      watcher.close();
      watchers.delete(username);
    }
    for (const username of current) {
      if (watchers.has(username)) continue;
      try {
        const watcher = fs.watch(path.join(options.sshRootDir, username), { persistent: false }, () => {
          signalIfReady(username);
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(username);
        });
        watchers.set(username, watcher);
        signalIfReady(username);
      } catch {
        // A concurrent directory removal is harmless; the root watcher will
        // retry when the next filesystem edge arrives.
      }
    }
  };

  syncAgentWatchers();
  const rootWatcher = fs.watch(options.sshRootDir, { persistent: false }, (_event, filename) => {
    syncAgentWatchers();
    const username = String(filename ?? '').split(path.sep)[0];
    if (username) signalIfReady(username);
  });
  rootWatcher.on('error', () => {
    // The daemon's regular desired-state reconcile remains the fallback if the
    // credential root becomes temporarily unavailable.
    rootWatcher.close();
  });

  return {
    close(): void {
      if (closed) return;
      closed = true;
      rootWatcher.close();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
