/**
 * Proactive file watcher — uses fs.watch (inotify on Linux) for instant,
 * zero-CPU notification when .shizuha-proactive.jsonl is written to.
 * Falls back to 5s polling if fs.watch is unavailable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProactiveEntry {
  ts: number;
  text: string;
  type: string;
  jobId?: string;
}

export function watchProactiveFile(
  workspace: string,
  onMessage: (entry: ProactiveEntry) => void,
): { stop: () => void } {
  const filePath = path.join(workspace, '.shizuha-proactive.jsonl');
  let lastSize = 0;
  try { lastSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch { /* */ }

  // Ensure parent dir exists so fs.watch can monitor it
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  // Touch the file so fs.watch has something to watch
  if (!fs.existsSync(filePath)) {
    try { fs.writeFileSync(filePath, ''); } catch { /* */ }
  }

  function readNewEntries() {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.size <= lastSize) return;

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;

      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as ProactiveEntry;
          if (entry.text) onMessage(entry);
        } catch { /* skip malformed */ }
      }
    } catch { /* retry on next event */ }
  }

  // Primary: fs.watch (uses inotify on Linux — instant, zero CPU)
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;

  try {
    watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === 'change') readNewEntries();
    });
    watcher.unref(); // Don't keep process alive
  } catch {
    // Fallback: poll every 5s (only if fs.watch fails)
    fallbackTimer = setInterval(readNewEntries, 5000);
    fallbackTimer.unref();
  }

  return {
    stop: () => {
      watcher?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
    },
  };
}
