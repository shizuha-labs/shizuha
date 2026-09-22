import type Database from 'better-sqlite3';

/**
 * WAL hygiene for long-lived better-sqlite3 stores.
 *
 * Root cause class (SCLI-762): stores opened with `journal_mode = WAL` and
 * nothing else grow an unbounded `-wal` file under continuous readers. The
 * default auto-checkpoint (~1000 pages on COMMIT) is starved whenever a
 * long-lived reader holds a snapshot, and SQLite never shrinks the WAL file
 * below its high-water mark on its own — even across process restarts.
 *
 * Fix shape (SCLI-763):
 *  1. `journal_size_limit` caps the WAL file: after any successful checkpoint
 *     that resets the WAL, SQLite truncates the file to this limit.
 *  2. A low-frequency PASSIVE checkpoint migrates committed frames back into
 *     the main DB so the WAL can reset. PASSIVE never blocks readers or
 *     writers; when readers starve it, it simply no-ops and retries next tick.
 *  3. A best-effort TRUNCATE checkpoint on close (when this connection holds
 *     no open transaction) resets the file immediately on shutdown.
 *
 * All checkpoint calls are best-effort: a failure (e.g. a concurrent checkpoint
 * from another process, or a busy DB) must never break store construction,
 * operation, or close.
 */

/** Default WAL high-water cap: 64 MiB. */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** Default periodic checkpoint interval: 1 hour. */
export const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

/** Set the WAL size limit on a WAL-mode database. Idempotent. */
export function limitWalSize(db: Database.Database, sizeLimitBytes: number = WAL_SIZE_LIMIT_BYTES): void {
  db.pragma(`journal_size_limit = ${Math.max(0, Math.floor(sizeLimitBytes))}`);
}

/**
 * Run one best-effort PASSIVE checkpoint. Skips while a transaction is open on
 * this connection (checkpointing inside a transaction is a no-op anyway) and
 * swallows errors — starvation is handled by retrying on the next tick.
 */
export function walCheckpointPassive(db: Database.Database): void {
  if (db.inTransaction) return;
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    /* best-effort — next periodic tick retries */
  }
}

/**
 * Run one best-effort TRUNCATE checkpoint (resets the WAL file to zero on
 * success, subject to journal_size_limit). Intended for close paths.
 */
export function walCheckpointTruncate(db: Database.Database): void {
  if (db.inTransaction) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best-effort */
  }
}

/**
 * Start a low-frequency periodic PASSIVE checkpoint timer for a long-lived
 * store. The timer is unref'd so it never keeps the process alive, and the
 * returned stop function is idempotent. Call the stop function from the
 * store's close path.
 */
export function startWalCheckpointTimer(
  db: Database.Database,
  intervalMs: number = WAL_CHECKPOINT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => walCheckpointPassive(db), intervalMs);
  // Never hold the event loop open for hygiene work.
  (timer as { unref?: () => void }).unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
