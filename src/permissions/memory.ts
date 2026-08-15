import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * SQLite-backed permission memory — persists tool approvals across sessions.
 */
export class PermissionMemory {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dir = dbPath ? path.dirname(dbPath) : path.join(process.env['HOME'] ?? '.', '.config', 'shizuha');
    fs.mkdirSync(dir, { recursive: true });
    const file = dbPath ?? path.join(dir, 'permissions.db');

    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        tool TEXT NOT NULL,
        pattern TEXT,
        decision TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (tool, pattern)
      )
    `);
  }

  /** Record an approval */
  approve(tool: string, pattern?: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO approvals (tool, pattern, decision) VALUES (?, ?, ?)')
      .run(tool, pattern ?? null, 'allow');
  }

  /** Check if tool is approved */
  isApproved(tool: string, _pattern?: string): boolean {
    const row = this.db
      .prepare('SELECT decision FROM approvals WHERE tool = ?')
      .get(tool) as { decision: string } | undefined;
    return row?.decision === 'allow';
  }

  close(): void {
    this.db.close();
  }
}
