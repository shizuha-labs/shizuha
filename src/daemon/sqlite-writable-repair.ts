import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteWritableRepairResult = 'absent' | 'writable' | 'repaired';

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

function isWritable(filePath: string): boolean {
  try {
    // Root's access(2) capability reports mode-0444 legacy artifacts writable,
    // which made the root-running CI image skip the repair and turned these
    // tests into a false red. Permission bits are the durable object contract;
    // accessSync still catches ownership/ACL denial for non-root runtimes.
    if ((fs.statSync(filePath).mode & 0o222) === 0) return false;
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function assertHealthyDatabase(db: Database.Database, label: string): void {
  const result = db.pragma('quick_check', { simple: true });
  if (result !== 'ok') {
    throw new Error(`${label} failed SQLite quick_check: ${String(result)}`);
  }
}

/**
 * Repair a legacy SQLite database that is readable but not writable by the
 * current daemon user.
 *
 * Older root-running agent runtimes left database/WAL/SHM files owned by root.
 * The hardened runtime now runs as an unprivileged user, but still owns the
 * workspace directory. SQLite cannot open that legacy WAL set read-write and
 * the child otherwise exits every five seconds forever.
 *
 * Use SQLite's online backup API rather than byte-copying a WAL database. The
 * backup folds every committed WAL page into a standalone, integrity-checked
 * replacement in the same directory. Renaming that replacement over the
 * original is atomic and naturally gives it the current runtime user's
 * ownership. No privilege or recursive workspace ownership change is needed.
 */
export async function ensureWritableSqliteDatabase(
  dbPath: string,
): Promise<SqliteWritableRepairResult> {
  if (!fs.existsSync(dbPath)) return 'absent';

  const artifacts = [
    dbPath,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`),
  ].filter((candidate) => fs.existsSync(candidate));
  if (artifacts.every(isWritable)) return 'writable';

  const parentDir = path.dirname(dbPath);
  if (!isWritable(parentDir)) {
    throw new Error(
      `state database is not writable and its workspace directory cannot host a rootless repair: ${dbPath}`,
    );
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const replacement = path.join(parentDir, `.${path.basename(dbPath)}.writable-repair-${nonce}`);
  let source: Database.Database | null = null;
  let candidate: Database.Database | null = null;

  try {
    source = new Database(dbPath, { readonly: true, fileMustExist: true });
    assertHealthyDatabase(source, 'source database');
    await source.backup(replacement);
    source.close();
    source = null;

    candidate = new Database(replacement);
    // A standalone DELETE-journal database has no WAL/SHM ownership coupling.
    // StateStore may opt back into WAL after it owns the canonical path.
    candidate.pragma('journal_mode = DELETE');
    assertHealthyDatabase(candidate, 'repaired database');
    candidate.exec('BEGIN IMMEDIATE; ROLLBACK;');
    candidate.close();
    candidate = null;
    fs.chmodSync(replacement, 0o600);

    // POSIX rename over an existing file is atomic when the directory is
    // writable, even if the old inode belongs to root. The verified backup
    // already contains the committed WAL state; discard legacy sidecars before
    // opening the replacement.
    fs.renameSync(replacement, dbPath);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
      fs.rmSync(`${replacement}${suffix}`, { force: true });
    }

    const verify = new Database(dbPath);
    try {
      assertHealthyDatabase(verify, 'installed database');
      verify.exec('BEGIN IMMEDIATE; ROLLBACK;');
    } finally {
      verify.close();
    }
    fs.chmodSync(dbPath, 0o600);
    return 'repaired';
  } catch (error) {
    try { source?.close(); } catch { /* best effort */ }
    try { candidate?.close(); } catch { /* best effort */ }
    for (const suffix of ['', ...SQLITE_SIDECAR_SUFFIXES]) {
      fs.rmSync(`${replacement}${suffix}`, { force: true });
    }
    throw error;
  }
}
