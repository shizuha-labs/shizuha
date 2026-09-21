import type Database from 'better-sqlite3';

/**
 * Keep better-sqlite3 Statement objects reachable for the life of the Database.
 *
 * Node 22 + better-sqlite3 11.x (ObjectWrap): Statement::~Statement calls
 * node::RemoveEnvironmentCleanupHook, which CHECK_NOT_NULL(env). V8's CppHeap
 * can GC those wrappers with no current Environment — gen-28 fleet SIGABRT
 * after listen + AgentAvailability, then again after a heartbeat that did
 * Pulse reads and wrote session rows. Pinning each unique SQL statement
 * until db.close() stops that destructor during the run.
 */
export function pinPreparedStatements(db: Database.Database): void {
  const cache = new Map<string, Database.Statement>();
  const origPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const existing = cache.get(sql);
    if (existing) return existing;
    const stmt = origPrepare(sql);
    cache.set(sql, stmt);
    return stmt;
  }) as typeof db.prepare;
}
