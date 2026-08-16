import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inert } from '../utils/display.js';

const HEARTBEAT_FILENAME = 'HEARTBEAT.md';

/** Temp-write prefix inside the workspace; never a plausible workspace object. */
const TEMP_PREFIX = `.${HEARTBEAT_FILENAME}.tmp-`;

/**
 * Resolve the bundled template path.
 *
 * Templates are emitted next to the bundle by build-rt.mjs / esbuild.config.js,
 * then staged into the release tarball by rt-build/build-dist.sh. Layouts:
 *   - dev (tsx):          src/daemon/templates/HEARTBEAT.md  (here = src/daemon)
 *   - dev bundle (dist/): dist/templates/HEARTBEAT.md        (here = dist)
 *   - release tarball:    lib/templates/HEARTBEAT.md         (here = lib, bundle = lib/shizuha.js)
 *
 * `here/templates` covers all three; `here/../templates` is a belt-and-suspenders
 * fallback for a bundle nested one level below its templates dir.
 */
function resolveTemplatePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'templates', HEARTBEAT_FILENAME),          // dev src/daemon, dist/, or tarball lib/
    path.join(here, '..', 'templates', HEARTBEAT_FILENAME),    // fallback (here = subdir of templates)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `HEARTBEAT template not found — looked in: ${candidates.join(', ')}`,
  );
}

let _cachedTemplate: string | null = null;

export function getHeartbeatTemplate(): string {
  if (_cachedTemplate === null) {
    _cachedTemplate = fs.readFileSync(resolveTemplatePath(), 'utf-8');
  }
  return _cachedTemplate;
}

/**
 * Seed HEARTBEAT.md into a newly-provisioned agent workspace.
 *
 * Idempotent: if the file already exists (including as a symlink — detected
 * WITHOUT following it) we leave it alone so operator customizations survive
 * across daemon restarts. Use `reseedHeartbeatTemplate` (or the `shizuha
 * reseed-heartbeat` CLI) for forced refresh.
 *
 * Never throws — heartbeat seeding is best-effort and must not block workspace
 * provisioning if the template is missing or the FS is read-only. SCLI-435:
 * the write is no-follow + atomic, so a symlink/FIFO planted at the target can
 * neither redirect the write outside the workspace nor hang provisioning.
 */
export function seedHeartbeatTemplate(workspaceDir: string): void {
  try {
    const target = path.join(workspaceDir, HEARTBEAT_FILENAME);
    // No-follow existence check: anything at the target (incl. a dangling
    // symlink) means "already seeded" — never follow or overwrite it.
    try {
      fs.lstatSync(target);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    writeFileAtomic(target, getHeartbeatTemplate());
  } catch (err) {
    console.error(`[heartbeat-template] seed failed for ${workspaceDir}:`, err);
  }
}

function statKind(stats: fs.Stats): string {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFIFO()) return 'FIFO';
  if (stats.isSocket()) return 'socket';
  if (stats.isDirectory()) return 'directory';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isCharacterDevice()) return 'character device';
  return `unexpected(${stats.mode.toString(8)})`;
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function defaultWorkspacesRoot(): string {
  return path.join(os.homedir(), '.shizuha', 'workspaces');
}

/**
 * Canonicalize and validate a reseed destination (SCLI-435).
 *
 * - the workspace must be a real (non-symlink) directory that resolves beneath
 *   the canonical workspaces root — no outside-HOME escape,
 * - the `HEARTBEAT.md` destination is checked with `lstat` (no follow): any
 *   existing symlink / FIFO / socket / directory / device is REJECTED without
 *   ever being opened, so a malicious or stale object can neither redirect the
 *   write outside the root nor block the command.
 *
 * Returns the canonical (realpath'd) target path. Throws a bounded,
 * control-safe message on rejection.
 */
function validatedTarget(workspaceDir: string, root: string): string {
  const rootReal = fs.realpathSync(root);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(workspaceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('workspace does not exist');
    }
    throw new Error('cannot stat workspace');
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error('refusing symlinked workspace directory');
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`workspace is not a directory (${statKind(dirStat)})`);
  }
  const dirReal = fs.realpathSync(workspaceDir);
  if (!isWithin(rootReal, dirReal)) {
    throw new Error('workspace resolves outside the workspaces root');
  }
  const target = path.join(dirReal, HEARTBEAT_FILENAME);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target); // no-follow
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw new Error('cannot stat HEARTBEAT.md');
  }
  if (st.isSymbolicLink()) {
    throw new Error('HEARTBEAT.md is a symlink — refusing to write outside the workspace');
  }
  if (!st.isFile()) {
    throw new Error(`HEARTBEAT.md is not a regular file (${statKind(st)})`);
  }
  return target;
}

/**
 * Atomic regular-file write: temp file (same directory, `wx` no-clobber),
 * write, fsync, then rename over the validated regular target. Unless the
 * destination was validated already, the final `rename` replaces the path node
 * itself (never follows a symlink) and either fully lands or leaves the prior
 * object untouched — no partial/forged HEARTBEAT.md.
 */
function writeFileAtomic(target: string, content: string): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Validate a reseed destination WITHOUT writing. Used by the CLI's `--dry-run`
 * so it can predict the exact bytes and the exact per-workspace action (write
 * vs reject) of the real run.
 */
export function inspectHeartbeatTarget(
  workspaceDir: string,
  root: string,
): { ok: true; target: string; bytes: number } | { ok: false; reason: string } {
  try {
    const target = validatedTarget(workspaceDir, root);
    return { ok: true, target, bytes: Buffer.byteLength(getHeartbeatTemplate(), 'utf-8') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: inert(msg, 200) };
  }
}

/**
 * Force-rewrite HEARTBEAT.md in a workspace. Used by `shizuha reseed-heartbeat`
 * to bulk-refresh the template after the canonical version has been updated.
 *
 * SCLI-435: the write is contained to the canonical workspaces root, rejects
 * symlink/FIFO/socket/directory targets without following them (bounded — a
 * FIFO can no longer hang the command), is atomic (temp + fsync + rename), and
 * never reports success for a rejected/outside destination.
 */
export function reseedHeartbeatTemplate(workspaceDir: string, opts?: { root?: string }): { written: boolean; reason?: string } {
  try {
    const root = opts?.root ?? defaultWorkspacesRoot();
    const info = inspectHeartbeatTarget(workspaceDir, root);
    if (!info.ok) return { written: false, reason: info.reason };
    writeFileAtomic(info.target, getHeartbeatTemplate());
    return { written: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { written: false, reason: inert(msg, 200) };
  }
}
