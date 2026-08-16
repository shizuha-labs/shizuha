/**
 * Lock-file view of "is the fleet supervisor up?"
 *
 * The TUI uses this to avoid racing `shizuha update` against `shizuha up`.
 * The supervisor itself keeps a richer check in daemon/state.ts (daemon.json
 * fallback + tini/ancestor guards).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function cmdlineLooksLikeShizuhaDaemon(cmdline: string): boolean {
  const parts = cmdline.split('\0').filter(Boolean);
  const hasNode = parts.some((part) => /(^|\/)node(\.exe)?$/.test(part));
  const hasShizuhaJs = parts.some((part) => part.endsWith('shizuha.js') || part.endsWith('/shizuha.js'));
  const hasDaemonVerb = parts.includes('up') || parts.some((part) => part.includes('SHIZUHA_DAEMON'));
  return hasNode && hasShizuhaJs && hasDaemonVerb;
}

function pidLockPath(home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''): string {
  return path.join(home, '.shizuha', 'daemon.pid');
}

export function isDaemonRunning(): boolean {
  const lockPath = pidLockPath();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(lockPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdlineLooksLikeShizuhaDaemon(cmdline);
  } catch {
    // /proc missing (macOS) — PID liveness is the best we have.
    return true;
  }
}
