import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Message } from '../agent/types.js';
import type { InterruptCheckpoint, Session } from './types.js';

export class StateStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dir = dbPath ? path.dirname(dbPath) : path.join(process.env['HOME'] ?? '.', '.config', 'shizuha');
    fs.mkdirSync(dir, { recursive: true });
    const file = dbPath ?? path.join(dir, 'state.db');

    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        turn_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT,
        execution_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE TABLE IF NOT EXISTS session_interrupt_checkpoints (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        prompt_excerpt TEXT NOT NULL,
        note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        timestamp UNINDEXED
      );
    `);
    // Migration: add name column if missing
    const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'name')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN name TEXT');
    }
    const messageCols = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    if (!messageCols.some((c) => c.name === 'message_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN message_id TEXT');
    }
    if (!messageCols.some((c) => c.name === 'execution_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN execution_id TEXT');
    }
  }

  /** Create a new session */
  createSession(model: string, cwd: string): Session {
    const id = randomUUID();
    return this.createSessionWithId(id, model, cwd);
  }

  /** Create a session with a specific ID (for eternal agent sessions). */
  createSessionWithId(id: string, model: string, cwd: string): Session {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id, model, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, model, cwd, now, now);
    return {
      id,
      model,
      cwd,
      createdAt: now,
      updatedAt: now,
      messages: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
    };
  }

  /** Load a session by ID */
  loadSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {
      id: string;
      model: string;
      cwd: string;
      created_at: number;
      updated_at: number;
      total_input_tokens: number;
      total_output_tokens: number;
      turn_count: number;
    } | undefined;
    if (!row) return null;

    const messages = this.loadMessages(id);
    const interruptCheckpoint = this.loadInterruptCheckpoint(id);
    return {
      id: row.id,
      model: row.model,
      cwd: row.cwd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      turnCount: row.turn_count,
      ...(interruptCheckpoint ? { interruptCheckpoint } : {}),
    };
  }

  /** Append a message to a session */
  appendMessage(sessionId: string, message: Message): void {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const timestamp = message.timestamp ?? Date.now();
    this.db
      .prepare('INSERT INTO messages (session_id, message_id, execution_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, message.id ?? null, message.executionId ?? null, message.role, content, timestamp);
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);

    // Index text content for full-text search
    this.indexMessage(sessionId, message.role, content, timestamp);
  }

  /** Index a message in the FTS5 table for full-text search */
  indexMessage(sessionId: string, role: string, content: string, timestamp: number): void {
    // Only index plain text content — skip tool results, images, and structured blocks
    if (!content || typeof content !== 'string') return;
    // Skip JSON-encoded content blocks (tool results, multimodal)
    if (content.startsWith('[') || content.startsWith('{')) return;
    try {
      this.db
        .prepare('INSERT INTO messages_fts (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(sessionId, role, content, timestamp);
    } catch {
      // Silently ignore FTS indexing errors — non-critical
    }
  }

  /** Search across all session messages using FTS5 full-text search */
  searchMessages(query: string, limit = 20): Array<{
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
    rank: number;
  }> {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, role, content, timestamp, rank
         FROM messages_fts
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as Array<{
      sessionId: string;
      role: string;
      content: string;
      timestamp: number;
      rank: number;
    }>;
  }

  /** Update session token counts */
  updateTokens(sessionId: string, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        'UPDATE sessions SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ?, turn_count = turn_count + 1, updated_at = ? WHERE id = ?',
      )
      .run(inputTokens, outputTokens, Date.now(), sessionId);
  }

  /** Replace all messages in a session (after compaction) */
  replaceMessages(sessionId: string, messages: Message[]): void {
    const del = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const ins = this.db.prepare(
      'INSERT INTO messages (session_id, message_id, execution_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const txn = this.db.transaction(() => {
      del.run(sessionId);
      for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        ins.run(sessionId, msg.id ?? null, msg.executionId ?? null, msg.role, content, msg.timestamp ?? Date.now());
      }
    });
    txn();
  }

  private loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT message_id, execution_id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{
        message_id: string | null;
        execution_id: string | null;
        role: string;
        content: string;
        timestamp: number;
      }>;

    return rows.map((r) => {
      let content: string | unknown[];
      try {
        const parsed = JSON.parse(r.content);
        content = Array.isArray(parsed) ? parsed : r.content;
      } catch {
        content = r.content;
      }
      return {
        ...(r.message_id ? { id: r.message_id } : {}),
        ...(r.execution_id ? { executionId: r.execution_id } : {}),
        role: r.role as Message['role'],
        content: content as string,
        timestamp: r.timestamp,
      };
    });
  }

  /** List recent sessions (for TUI session picker) */
  listSessions(limit = 20, preferredCwd?: string): Array<{
    id: string;
    model: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    name?: string;
    firstMessage?: string;
  }> {
    const rows = preferredCwd
      ? this.db
          .prepare(
            `SELECT s.id, s.model, s.cwd, s.created_at, s.updated_at, s.turn_count,
                    s.total_input_tokens, s.total_output_tokens, s.name,
                    (SELECT substr(m.content, 1, 80) FROM messages m
                     WHERE m.session_id = s.id AND m.role = 'user'
                     ORDER BY m.id ASC LIMIT 1) AS first_message
             FROM sessions s
             ORDER BY CASE
                      WHEN s.cwd = ? THEN 0
                      WHEN s.cwd LIKE ? THEN 1
                      WHEN ? LIKE (s.cwd || '/%') THEN 1
                      ELSE 2
                    END,
                    s.updated_at DESC, s.rowid DESC
             LIMIT ?`,
          )
          .all(preferredCwd, `${preferredCwd}/%`, preferredCwd, limit) as Array<{
        id: string;
        model: string;
        cwd: string;
        created_at: number;
        updated_at: number;
        turn_count: number;
        total_input_tokens: number;
        total_output_tokens: number;
        name: string | null;
        first_message: string | null;
      }>
      : this.db
          .prepare(
            `SELECT s.id, s.model, s.cwd, s.created_at, s.updated_at, s.turn_count,
                    s.total_input_tokens, s.total_output_tokens, s.name,
                    (SELECT substr(m.content, 1, 80) FROM messages m
                     WHERE m.session_id = s.id AND m.role = 'user'
                     ORDER BY m.id ASC LIMIT 1) AS first_message
             FROM sessions s ORDER BY s.updated_at DESC, s.rowid DESC LIMIT ?`,
          )
          .all(limit) as Array<{
      id: string;
      model: string;
      cwd: string;
      created_at: number;
      updated_at: number;
      turn_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      name: string | null;
      first_message: string | null;
    }>;
    return rows.map((r) => {
      let firstMessage = r.first_message ?? undefined;
      // Handle JSON content: extract text from content blocks
      if (firstMessage && firstMessage.startsWith('[')) {
        try {
          const parsed = JSON.parse(firstMessage);
          if (Array.isArray(parsed)) {
            const textBlock = parsed.find((b: { type?: string; text?: string }) => b.type === 'text' && b.text);
            if (textBlock) firstMessage = String(textBlock.text).slice(0, 80);
          }
        } catch { /* use as-is */ }
      }
      return {
        id: r.id,
        model: r.model,
        cwd: r.cwd,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        turnCount: r.turn_count,
        totalInputTokens: r.total_input_tokens,
        totalOutputTokens: r.total_output_tokens,
        name: r.name ?? undefined,
        firstMessage,
      };
    });
  }

  /** Rename a session */
  renameSession(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  }

  /** Fork a session — copies all messages to a new session */
  forkSession(id: string): Session | null {
    const original = this.loadSession(id);
    if (!original) return null;
    const forked = this.createSession(original.model, original.cwd);
    const ins = this.db.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    );
    const txn = this.db.transaction(() => {
      for (const msg of original.messages) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        ins.run(forked.id, msg.role, content, msg.timestamp ?? Date.now());
      }
    });
    txn();
    forked.messages = [...original.messages];
    forked.totalInputTokens = original.totalInputTokens;
    forked.totalOutputTokens = original.totalOutputTokens;
    forked.turnCount = original.turnCount;
    this.db.prepare(
      'UPDATE sessions SET total_input_tokens = ?, total_output_tokens = ?, turn_count = ? WHERE id = ?',
    ).run(original.totalInputTokens, original.totalOutputTokens, original.turnCount, forked.id);
    return forked;
  }

  /** Delete a session and all its messages */
  deleteSession(id: string): boolean {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM session_interrupt_checkpoints WHERE session_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return txn();
  }

  /** Save or replace an interrupted-turn checkpoint for a session */
  saveInterruptCheckpoint(sessionId: string, checkpoint: InterruptCheckpoint): void {
    this.db.prepare(
      `INSERT INTO session_interrupt_checkpoints (session_id, created_at, prompt_excerpt, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         created_at = excluded.created_at,
         prompt_excerpt = excluded.prompt_excerpt,
         note = excluded.note`,
    ).run(sessionId, checkpoint.createdAt, checkpoint.promptExcerpt, checkpoint.note);
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  /** Clear an interrupted-turn checkpoint once processing resumes/completes */
  clearInterruptCheckpoint(sessionId: string): void {
    this.db.prepare('DELETE FROM session_interrupt_checkpoints WHERE session_id = ?').run(sessionId);
  }

  private loadInterruptCheckpoint(sessionId: string): InterruptCheckpoint | null {
    const row = this.db.prepare(
      'SELECT created_at, prompt_excerpt, note FROM session_interrupt_checkpoints WHERE session_id = ?',
    ).get(sessionId) as { created_at: number; prompt_excerpt: string; note: string } | undefined;
    if (!row) return null;
    return {
      createdAt: row.created_at,
      promptExcerpt: row.prompt_excerpt,
      note: row.note,
    };
  }

  /** Load persistent tool approvals */
  loadToolApprovals(): string[] {
    this.ensureToolApprovalsTable();
    const rows = this.db.prepare('SELECT tool_name FROM tool_approvals').all() as Array<{ tool_name: string }>;
    return rows.map((r) => r.tool_name);
  }

  /** Save a persistent tool approval */
  saveToolApproval(toolName: string): void {
    this.ensureToolApprovalsTable();
    this.db.prepare(
      'INSERT OR IGNORE INTO tool_approvals (tool_name, created_at) VALUES (?, ?)',
    ).run(toolName, Date.now());
  }

  /** Remove a persistent tool approval */
  removeToolApproval(toolName: string): void {
    this.ensureToolApprovalsTable();
    this.db.prepare('DELETE FROM tool_approvals WHERE tool_name = ?').run(toolName);
  }

  private ensureToolApprovalsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_approvals (
        tool_name TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
  }

  /** Delete interrupt checkpoints older than the given epoch ms. Returns count deleted. */
  pruneOldCheckpoints(olderThanMs: number): number {
    const result = this.db
      .prepare('DELETE FROM session_interrupt_checkpoints WHERE created_at < ?')
      .run(olderThanMs);
    return result.changes;
  }

  /** Run VACUUM to reclaim unused space. */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /** Execute raw SQL (for extensions like UsageTracker to create tables). */
  execSQL(sql: string): void {
    this.db.exec(sql);
  }

  /** Prepare a SQL statement (for extensions like UsageTracker). */
  prepareSQL(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}
