import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../agent/types.js';
import type { InterruptCheckpoint, Session } from './types.js';
import type { ProviderPrefixSnapshot } from '../telemetry/provider-prefix-continuity.js';
import { stableJson } from '../telemetry/prefix-fingerprint.js';

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export type ExpensiveTurnRecoveryStatus =
  | 'guard_tripped'
  | 'recovery_pending'
  | 'verified'
  | 'exhausted';

export interface ExpensiveTurnRecoveryCounters {
  preserved: number;
  coalesced: number;
  dropped: number;
  deferred: number;
  replayed: number;
}

export interface ExpensiveTurnRecoveryState {
  sessionId: string;
  episodeId: string;
  activeGeneration: number;
  fencedGeneration: number;
  targetGeneration: number;
  state: ExpensiveTurnRecoveryStatus;
  attempts: number;
  sourceMessageCount: number;
  sourcePromptTokens: number;
  compactionOutcome: string | null;
  lastOutcome: string | null;
  counters: ExpensiveTurnRecoveryCounters;
  createdAt: number;
  updatedAt: number;
}

export interface DeferredRecoveryMessage {
  messageId: string;
  messageClass: string;
  payload: string;
}

export interface SessionContextTokenAnchor {
  model: string;
  providerInputTokens: number;
  providerPromptEstimate: number;
  rawPromptTokens: number;
  messageCount: number;
  updatedAt: number;
}

/**
 * Tokenizer calibration is model-scoped provider evidence, not a context
 * position. Unlike an absolute token anchor it remains valid when sanitation,
 * compaction, or trimming rewrites the message prefix.
 */
export interface SessionTokenizerCalibration {
  model: string;
  providerInputTokens: number;
  rawPromptTokens: number;
  ratio: number;
  updatedAt: number;
}

interface StoredMessageRow {
  message_id: string | null;
  execution_id: string | null;
  role: string;
  content: string;
  timestamp: number;
}

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
      -- The messages table is the mutable provider-context projection. This separate
      -- append-only table is the canonical transcript: compaction and emergency
      -- fitting may rewrite the projection but must never erase history.
      CREATE TABLE IF NOT EXISTS session_message_transcript (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        source_message_row_id INTEGER,
        message_id TEXT,
        execution_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        provenance TEXT NOT NULL DEFAULT 'active_insert'
      );
      CREATE TABLE IF NOT EXISTS state_store_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_interrupt_checkpoints (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        prompt_excerpt TEXT NOT NULL,
        note TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_provider_prefix_snapshots (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        model TEXT NOT NULL,
        context_window INTEGER,
        system_prompt_hash TEXT NOT NULL,
        tool_schema_hash TEXT NOT NULL,
        tool_names TEXT NOT NULL,
        chat_message_hashes TEXT NOT NULL,
        chat_message_count INTEGER NOT NULL,
        total_message_count INTEGER,
        canonical_message_prefix_hash TEXT,
        system_tool_prefix_hash TEXT,
        payload_shape_hint TEXT,
        payload_hash TEXT NOT NULL
      );
      -- Byte-exact provider prefix head (system prompt + tool defs) as last
      -- sent. On process resume the gateway re-adopts this serialization
      -- verbatim when only volatile composition inputs changed, so a restart
      -- never cold-rebuilds a warm KV cache (PLAT-4189 resume pin).
      CREATE TABLE IF NOT EXISTS session_provider_prefix_heads (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        tool_defs TEXT NOT NULL
      );
      -- The exact provider-wire message payload (ChatMessage[] JSON) last
      -- SENT for this session, plus how many internal messages it covered.
      -- Resume replays these bytes VERBATIM as the payload prefix — the next
      -- payload is stored_prefix ++ convert(new internal tail) BY
      -- CONSTRUCTION, so restart re-serialization divergence is impossible
      -- (operator 2026-08-08: "mathematically provable same
      -- re-serialization"). Any history rewrite invalidates the row via
      -- replaceMessages, the single choke-point every rewrite already calls.
      CREATE TABLE IF NOT EXISTS session_wire_prefix (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        source_count INTEGER NOT NULL,
        messages_json TEXT NOT NULL
      );
      -- Provider-tokenizer truth must survive process resume. The prefix hash
      -- makes the anchor usable only while the mutable working set still starts
      -- with the exact request that produced it.
      CREATE TABLE IF NOT EXISTS session_context_token_anchors (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        provider_input_tokens INTEGER NOT NULL,
        provider_prompt_estimate INTEGER NOT NULL,
        raw_prompt_tokens INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        message_prefix_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_recovery_heads (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL,
        active_generation INTEGER NOT NULL DEFAULT 0,
        fenced_generation INTEGER NOT NULL,
        target_generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        source_message_count INTEGER NOT NULL,
        source_prompt_tokens INTEGER NOT NULL,
        compaction_outcome TEXT,
        last_outcome TEXT,
        counters TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_recovery_deferred (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_class TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'deferred',
        created_at INTEGER NOT NULL,
        replayed_at INTEGER,
        UNIQUE(session_id, episode_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS session_inbound_processing (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'admitted',
        admitted_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_session_message_transcript_session
        ON session_message_transcript(session_id, timestamp, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_message_transcript_source
        ON session_message_transcript(source_message_row_id)
        WHERE source_message_row_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_recovery_deferred_session
        ON session_recovery_deferred(session_id, episode_id, state, id);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        timestamp UNINDEXED
      );

      -- Compatibility guard for already-running runtimes during a rolling
      -- upgrade: their loaded appendMessage()/replaceMessages() implementations
      -- still write only the messages table. The database trigger archives every future
      -- active-row insertion before those old processes can later delete it.
      CREATE TRIGGER IF NOT EXISTS archive_active_message_insert
      AFTER INSERT ON messages
      BEGIN
        INSERT OR IGNORE INTO session_message_transcript (
          session_id, source_message_row_id, message_id, execution_id,
          role, content, timestamp, provenance
        ) VALUES (
          NEW.session_id, NEW.id, NEW.message_id, NEW.execution_id,
          NEW.role, NEW.content, NEW.timestamp, 'active_insert'
        );
      END;
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
    const checkpointCols = this.db.pragma('table_info(session_interrupt_checkpoints)') as Array<{ name: string }>;
    if (!checkpointCols.some((c) => c.name === 'kind')) {
      this.db.exec('ALTER TABLE session_interrupt_checkpoints ADD COLUMN kind TEXT');
    }
    const prefixCols = this.db.pragma('table_info(session_provider_prefix_snapshots)') as Array<{ name: string }>;
    if (!prefixCols.some((c) => c.name === 'total_message_count')) {
      this.db.exec('ALTER TABLE session_provider_prefix_snapshots ADD COLUMN total_message_count INTEGER');
    }
    if (!prefixCols.some((c) => c.name === 'canonical_message_prefix_hash')) {
      this.db.exec('ALTER TABLE session_provider_prefix_snapshots ADD COLUMN canonical_message_prefix_hash TEXT');
    }
    if (!prefixCols.some((c) => c.name === 'system_tool_prefix_hash')) {
      this.db.exec('ALTER TABLE session_provider_prefix_snapshots ADD COLUMN system_tool_prefix_hash TEXT');
    }
    if (!prefixCols.some((c) => c.name === 'payload_shape_hint')) {
      this.db.exec('ALTER TABLE session_provider_prefix_snapshots ADD COLUMN payload_shape_hint TEXT');
    }
    if (!prefixCols.some((c) => c.name === 'system_prompt_section_hashes')) {
      this.db.exec('ALTER TABLE session_provider_prefix_snapshots ADD COLUMN system_prompt_section_hashes TEXT');
    }

    // One-time, crash-safe transcript bootstrap. Current structured rows are
    // copied first; unmatched legacy FTS ghosts recover plain-text history that
    // an older replaceMessages() already deleted. Structured pre-upgrade rows
    // that were destroyed cannot be reconstructed, but every future insert is
    // protected by the database trigger above.
    const migrateTranscript = this.db.transaction(() => {
      const claimed = this.db.prepare(
        `INSERT OR IGNORE INTO state_store_migrations (name, applied_at)
         VALUES ('canonical-transcript-v1', ?)`,
      ).run(Date.now());
      if (claimed.changes !== 1) return;

      this.db.exec(`
        INSERT OR IGNORE INTO session_message_transcript (
          session_id, source_message_row_id, message_id, execution_id,
          role, content, timestamp, provenance
        )
        SELECT session_id, id, message_id, execution_id,
               role, content, timestamp, 'migration'
        FROM messages;

        INSERT INTO session_message_transcript (
          session_id, source_message_row_id, message_id, execution_id,
          role, content, timestamp, provenance
        )
        SELECT f.session_id, NULL, NULL, NULL,
               f.role, f.content, CAST(f.timestamp AS INTEGER), 'fts_recovered'
        FROM messages_fts AS f
        WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id)
          AND NOT EXISTS (
            SELECT 1
            FROM session_message_transcript t
            WHERE t.session_id = f.session_id
              AND t.role = f.role
              AND t.content = f.content
              AND t.timestamp = CAST(f.timestamp AS INTEGER)
          );
      `);
    });
    migrateTranscript.immediate();
  }

  inboundProcessingCompleted(_sessionId: string, messageId: string): boolean {
    const row = this.db.prepare(
      `SELECT state FROM session_inbound_processing
       WHERE message_id = ?`,
    ).get(messageId) as { state: string } | undefined;
    return row?.state === 'completed';
  }

  markInboundProcessingAdmitted(sessionId: string, messageId: string, channelType: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO session_inbound_processing
       (message_id, session_id, channel_type, state, admitted_at)
       VALUES (?, ?, ?, 'admitted', ?)`,
    ).run(messageId, sessionId, channelType, Date.now());
  }

  markInboundProcessingCompleted(_sessionId: string, messageId: string): void {
    this.db.prepare(
      `UPDATE session_inbound_processing
       SET state = 'completed', completed_at = ?
       WHERE message_id = ?`,
    ).run(Date.now(), messageId);
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

  saveContextTokenAnchor(
    sessionId: string,
    anchor: Omit<SessionContextTokenAnchor, 'messageCount' | 'updatedAt'>,
    baselineMessages: Message[],
  ): void {
    const messageCount = baselineMessages.length;
    this.db.prepare(
      `INSERT INTO session_context_token_anchors (
         session_id, model, provider_input_tokens, provider_prompt_estimate,
         raw_prompt_tokens, message_count, message_prefix_hash, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         model = excluded.model,
         provider_input_tokens = excluded.provider_input_tokens,
         provider_prompt_estimate = excluded.provider_prompt_estimate,
         raw_prompt_tokens = excluded.raw_prompt_tokens,
         message_count = excluded.message_count,
         message_prefix_hash = excluded.message_prefix_hash,
         updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      anchor.model,
      anchor.providerInputTokens,
      anchor.providerPromptEstimate,
      anchor.rawPromptTokens,
      messageCount,
      hashJson(baselineMessages),
      Date.now(),
    );
  }

  /**
   * Return provider-tokenizer truth only when the current working set is an
   * append-only continuation of the exact request that produced the anchor.
   * Compaction, sanitation, trim, or reorder invalidates it automatically.
   */
  loadContextTokenAnchor(
    sessionId: string,
    model: string,
    currentMessages: Message[],
  ): SessionContextTokenAnchor | null {
    const row = this.db.prepare(
      `SELECT model, provider_input_tokens, provider_prompt_estimate,
              raw_prompt_tokens, message_count, message_prefix_hash, updated_at
       FROM session_context_token_anchors WHERE session_id = ?`,
    ).get(sessionId) as {
      model: string;
      provider_input_tokens: number;
      provider_prompt_estimate: number;
      raw_prompt_tokens: number;
      message_count: number;
      message_prefix_hash: string;
      updated_at: number;
    } | undefined;
    if (!row || row.model !== model || row.message_count > currentMessages.length) return null;
    if (hashJson(currentMessages.slice(0, row.message_count)) !== row.message_prefix_hash) return null;
    return {
      model: row.model,
      providerInputTokens: row.provider_input_tokens,
      providerPromptEstimate: row.provider_prompt_estimate,
      rawPromptTokens: row.raw_prompt_tokens,
      messageCount: row.message_count,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Restore the provider tokenizer ratio even when the exact context-position
   * anchor no longer matches. A row whose provider input equals the provider's
   * own preflight estimate is not evidence: vLLM uses that estimate as a usage
   * fallback when the server omits prompt_tokens.
   */
  loadTokenizerCalibration(
    sessionId: string,
    model: string,
  ): SessionTokenizerCalibration | null {
    const row = this.db.prepare(
      `SELECT model, provider_input_tokens, provider_prompt_estimate,
              raw_prompt_tokens, updated_at
       FROM session_context_token_anchors WHERE session_id = ?`,
    ).get(sessionId) as {
      model: string;
      provider_input_tokens: number;
      provider_prompt_estimate: number;
      raw_prompt_tokens: number;
      updated_at: number;
    } | undefined;
    if (!row || row.model !== model
      || row.provider_input_tokens <= 0 || row.raw_prompt_tokens <= 0
      || (row.provider_prompt_estimate > 0
        && row.provider_input_tokens === row.provider_prompt_estimate)) {
      return null;
    }
    const ratio = row.provider_input_tokens / row.raw_prompt_tokens;
    // Match VllmProvider's evidence bounds. Tiny test/fallback counts and
    // pathological samples are not representative tokenizer observations.
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 2.0) return null;
    return {
      model: row.model,
      providerInputTokens: row.provider_input_tokens,
      rawPromptTokens: row.raw_prompt_tokens,
      ratio,
      updatedAt: row.updated_at,
    };
  }

  /** Latest exact provider-prefix snapshot used to detect resume/cache rewrites. */
  loadProviderPrefixSnapshot(sessionId: string): ProviderPrefixSnapshot | null {
    const row = this.db.prepare(
      `SELECT created_at, model, context_window, system_prompt_hash, tool_schema_hash,
              tool_names, chat_message_hashes, chat_message_count, total_message_count,
              canonical_message_prefix_hash, system_tool_prefix_hash, payload_shape_hint,
              payload_hash, system_prompt_section_hashes
       FROM session_provider_prefix_snapshots WHERE session_id = ?`,
    ).get(sessionId) as {
      created_at: number;
      model: string;
      context_window: number | null;
      system_prompt_hash: string;
      tool_schema_hash: string;
      tool_names: string;
      chat_message_hashes: string;
      chat_message_count: number;
      total_message_count: number | null;
      canonical_message_prefix_hash: string | null;
      system_tool_prefix_hash: string | null;
      payload_shape_hint: string | null;
      payload_hash: string;
      system_prompt_section_hashes: string | null;
    } | undefined;
    if (!row) return null;
    let systemPromptSectionHashes: Array<{ label: string; hash: string }> | undefined;
    if (row.system_prompt_section_hashes) {
      try {
        const parsed = JSON.parse(row.system_prompt_section_hashes) as unknown;
        if (Array.isArray(parsed)) systemPromptSectionHashes = parsed as Array<{ label: string; hash: string }>;
      } catch { /* legacy/corrupt — attribution simply degrades to whole-prompt */ }
    }
    const chatMessageHashes = JSON.parse(row.chat_message_hashes) as string[];
    const toolNames = JSON.parse(row.tool_names) as string[];
    const canonicalMessagePrefixHash = row.canonical_message_prefix_hash ?? hashJson(chatMessageHashes);
    const systemToolPrefixHash = row.system_tool_prefix_hash ?? hashJson({
      systemPromptHash: row.system_prompt_hash,
      toolSchemaHash: row.tool_schema_hash,
    });
    const payloadShapeHint = row.payload_shape_hint === 'compaction' || row.payload_shape_hint === 'emergency-trim'
      ? row.payload_shape_hint
      : undefined;
    return {
      createdAt: row.created_at,
      model: row.model,
      ...(row.context_window != null ? { contextWindow: row.context_window } : {}),
      systemPromptHash: row.system_prompt_hash,
      ...(systemPromptSectionHashes ? { systemPromptSectionHashes } : {}),
      toolSchemaHash: row.tool_schema_hash,
      systemToolPrefixHash,
      toolNames,
      chatMessageHashes,
      chatMessageCount: row.chat_message_count,
      totalMessageCount: row.total_message_count ?? row.chat_message_count,
      canonicalMessagePrefixHash,
      ...(payloadShapeHint ? { payloadShapeHint } : {}),
      payloadHash: row.payload_hash,
    };
  }

  saveProviderPrefixSnapshot(sessionId: string, snapshot: ProviderPrefixSnapshot): void {
    this.db.prepare(
      `INSERT INTO session_provider_prefix_snapshots (
         session_id, created_at, model, context_window, system_prompt_hash,
         tool_schema_hash, tool_names, chat_message_hashes, chat_message_count,
         total_message_count, canonical_message_prefix_hash, system_tool_prefix_hash,
         payload_shape_hint, payload_hash, system_prompt_section_hashes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         created_at = excluded.created_at,
         model = excluded.model,
         context_window = excluded.context_window,
         system_prompt_hash = excluded.system_prompt_hash,
         tool_schema_hash = excluded.tool_schema_hash,
         tool_names = excluded.tool_names,
         chat_message_hashes = excluded.chat_message_hashes,
         chat_message_count = excluded.chat_message_count,
         total_message_count = excluded.total_message_count,
         canonical_message_prefix_hash = excluded.canonical_message_prefix_hash,
         system_tool_prefix_hash = excluded.system_tool_prefix_hash,
         payload_shape_hint = excluded.payload_shape_hint,
         payload_hash = excluded.payload_hash,
         system_prompt_section_hashes = excluded.system_prompt_section_hashes`,
    ).run(
      sessionId,
      snapshot.createdAt,
      snapshot.model,
      snapshot.contextWindow ?? null,
      snapshot.systemPromptHash,
      snapshot.toolSchemaHash,
      JSON.stringify(snapshot.toolNames),
      JSON.stringify(snapshot.chatMessageHashes),
      snapshot.chatMessageCount,
      snapshot.totalMessageCount,
      snapshot.canonicalMessagePrefixHash,
      snapshot.systemToolPrefixHash,
      snapshot.payloadShapeHint ?? null,
      snapshot.payloadHash,
      snapshot.systemPromptSectionHashes ? JSON.stringify(snapshot.systemPromptSectionHashes) : null,
    );
  }

  /** Byte-exact provider prefix head (system prompt + tool defs) as last sent (PLAT-4189 resume pin). */
  loadProviderPrefixHead(sessionId: string): {
    createdAt: number; model: string; systemPrompt: string; toolDefs: string;
  } | null {
    const row = this.db.prepare(
      `SELECT created_at, model, system_prompt, tool_defs
       FROM session_provider_prefix_heads WHERE session_id = ?`,
    ).get(sessionId) as {
      created_at: number; model: string; system_prompt: string; tool_defs: string;
    } | undefined;
    if (!row) return null;
    return {
      createdAt: row.created_at,
      model: row.model,
      systemPrompt: row.system_prompt,
      toolDefs: row.tool_defs,
    };
  }

  saveProviderPrefixHead(
    sessionId: string,
    head: { createdAt: number; model: string; systemPrompt: string; toolDefs: string },
  ): void {
    this.db.prepare(
      `INSERT INTO session_provider_prefix_heads (session_id, created_at, model, system_prompt, tool_defs)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         created_at = excluded.created_at,
         model = excluded.model,
         system_prompt = excluded.system_prompt,
         tool_defs = excluded.tool_defs`,
    ).run(sessionId, head.createdAt, head.model, head.systemPrompt, head.toolDefs);
  }

  /** Provider-wire payload prefix as last SENT (see table comment). */
  loadWirePrefix(sessionId: string): { sourceCount: number; messagesJson: string } | null {
    const row = this.db.prepare(
      'SELECT source_count, messages_json FROM session_wire_prefix WHERE session_id = ?',
    ).get(sessionId) as { source_count: number; messages_json: string } | undefined;
    if (!row) return null;
    return { sourceCount: row.source_count, messagesJson: row.messages_json };
  }

  saveWirePrefix(sessionId: string, sourceCount: number, messagesJson: string): void {
    this.db.prepare(
      `INSERT INTO session_wire_prefix (session_id, created_at, source_count, messages_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         created_at = excluded.created_at,
         source_count = excluded.source_count,
         messages_json = excluded.messages_json`,
    ).run(sessionId, Date.now(), sourceCount, messagesJson);
  }

  clearWirePrefix(sessionId: string): void {
    this.db.prepare('DELETE FROM session_wire_prefix WHERE session_id = ?').run(sessionId);
  }

  /** Replace all messages in a session (after compaction) */
  replaceMessages(sessionId: string, messages: Message[]): void {
    // Any history REWRITE invalidates the frozen wire prefix: the stored
    // payload no longer corresponds to the internal history, and the next
    // payload must be a fresh serialization (cache-breaking by nature).
    try { this.clearWirePrefix(sessionId); } catch { /* table may predate */ }
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

  /**
   * Load the append-only canonical transcript for audit/history surfaces.
   * The active provider context remains loadSession(id).messages.
   *
   * Projection rewrites performed by pre-upgrade processes can re-insert kept
   * rows with new SQLite ids. De-duplicate identical logical messages here
   * while retaining chronological ordering and every distinct original.
   */
  loadTranscriptMessages(sessionId: string): Message[] {
    const rows = this.db.prepare(
      `SELECT message_id, execution_id, role, content, timestamp
       FROM session_message_transcript
       WHERE session_id = ?
       ORDER BY timestamp, id`,
    ).all(sessionId) as StoredMessageRow[];
    const seen = new Set<string>();
    return this.deserializeMessages(rows).filter((message) => {
      const key = stableJson({
        id: message.id ?? null,
        executionId: message.executionId ?? null,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp ?? null,
      });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private recoveryStateFromRow(row: any): ExpensiveTurnRecoveryState {
    const counters = JSON.parse(row.counters) as ExpensiveTurnRecoveryCounters;
    return {
      sessionId: row.session_id,
      episodeId: row.episode_id,
      activeGeneration: row.active_generation,
      fencedGeneration: row.fenced_generation,
      targetGeneration: row.target_generation,
      state: row.state,
      attempts: row.attempts,
      sourceMessageCount: row.source_message_count,
      sourcePromptTokens: row.source_prompt_tokens,
      compactionOutcome: row.compaction_outcome ?? null,
      lastOutcome: row.last_outcome ?? null,
      counters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  loadExpensiveTurnRecovery(sessionId: string): ExpensiveTurnRecoveryState | null {
    const row = this.db.prepare(
      'SELECT * FROM session_recovery_heads WHERE session_id = ?',
    ).get(sessionId) as any;
    return row ? this.recoveryStateFromRow(row) : null;
  }

  /**
   * Fence the current transcript generation and durably detach queued feed in
   * one transaction.  Re-entering while an episode is unfinished is
   * idempotent and returns the already-authoritative episode.
   */
  beginExpensiveTurnRecovery(
    sessionId: string,
    episodeId: string,
    sourceMessageCount: number,
    sourcePromptTokens: number,
    deferred: readonly DeferredRecoveryMessage[],
    counters: ExpensiveTurnRecoveryCounters,
  ): ExpensiveTurnRecoveryState {
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const existing = this.loadExpensiveTurnRecovery(sessionId);
      if (existing && (existing.state === 'guard_tripped' || existing.state === 'recovery_pending')) {
        // A second guard can trip while the first episode's recovery heartbeat
        // is running. The caller has already detached the live inbox, so that
        // newly-drained feed must join the authoritative episode in this same
        // transaction rather than being lost on the idempotent re-entry path.
        const insertDeferred = this.db.prepare(
          `INSERT OR IGNORE INTO session_recovery_deferred
             (session_id, episode_id, message_id, message_class, payload, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'deferred', ?)`,
        );
        for (const item of deferred) {
          insertDeferred.run(
            sessionId,
            existing.episodeId,
            item.messageId,
            item.messageClass,
            item.payload,
            now,
          );
        }
        const mergedCounters: ExpensiveTurnRecoveryCounters = {
          preserved: existing.counters.preserved + counters.preserved,
          coalesced: existing.counters.coalesced + counters.coalesced,
          dropped: existing.counters.dropped + counters.dropped,
          deferred: existing.counters.deferred + counters.deferred,
          replayed: existing.counters.replayed + counters.replayed,
        };
        this.db.prepare(
          'UPDATE session_recovery_heads SET counters = ?, updated_at = ? WHERE session_id = ? AND episode_id = ?',
        ).run(JSON.stringify(mergedCounters), now, sessionId, existing.episodeId);
        return this.loadExpensiveTurnRecovery(sessionId)!;
      }
      const activeGeneration = existing?.activeGeneration ?? 0;
      const targetGeneration = activeGeneration + 1;
      this.db.prepare(
        `INSERT INTO session_recovery_heads (
           session_id, episode_id, active_generation, fenced_generation,
           target_generation, state, attempts, source_message_count,
           source_prompt_tokens, compaction_outcome, last_outcome, counters,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'guard_tripped', 0, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           episode_id = excluded.episode_id,
           fenced_generation = excluded.fenced_generation,
           target_generation = excluded.target_generation,
           state = excluded.state,
           attempts = 0,
           source_message_count = excluded.source_message_count,
           source_prompt_tokens = excluded.source_prompt_tokens,
           compaction_outcome = NULL,
           last_outcome = NULL,
           counters = excluded.counters,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      ).run(
        sessionId,
        episodeId,
        activeGeneration,
        activeGeneration,
        targetGeneration,
        sourceMessageCount,
        sourcePromptTokens,
        JSON.stringify(counters),
        now,
        now,
      );
      const insertDeferred = this.db.prepare(
        `INSERT OR IGNORE INTO session_recovery_deferred
           (session_id, episode_id, message_id, message_class, payload, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'deferred', ?)`,
      );
      for (const item of deferred) {
        insertDeferred.run(
          sessionId,
          episodeId,
          item.messageId,
          item.messageClass,
          item.payload,
          now,
        );
      }
      return this.loadExpensiveTurnRecovery(sessionId)!;
    });
    return txn();
  }

  /** Atomically publish the bounded successor head and make it authoritative. */
  commitExpensiveTurnSuccessor(
    sessionId: string,
    episodeId: string,
    messages: readonly Message[],
    compactionOutcome: string,
  ): ExpensiveTurnRecoveryState {
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const state = this.loadExpensiveTurnRecovery(sessionId);
      if (!state || state.episodeId !== episodeId) {
        throw new Error(`Recovery episode ${episodeId} is not authoritative for ${sessionId}`);
      }
      const del = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
      const ins = this.db.prepare(
        'INSERT INTO messages (session_id, message_id, execution_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      );
      del.run(sessionId);
      for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        ins.run(sessionId, msg.id ?? null, msg.executionId ?? null, msg.role, content, msg.timestamp ?? now);
      }
      this.db.prepare(
        `UPDATE session_recovery_heads
         SET active_generation = target_generation,
             state = 'recovery_pending',
             compaction_outcome = ?,
             updated_at = ?
         WHERE session_id = ? AND episode_id = ?`,
      ).run(compactionOutcome, now, sessionId, episodeId);
      return this.loadExpensiveTurnRecovery(sessionId)!;
    });
    return txn();
  }

  appendExpensiveTurnRecoveryDeferred(
    sessionId: string,
    episodeId: string,
    deferred: readonly DeferredRecoveryMessage[],
    countersDelta: ExpensiveTurnRecoveryCounters,
  ): ExpensiveTurnRecoveryState {
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const state = this.loadExpensiveTurnRecovery(sessionId);
      if (!state || state.episodeId !== episodeId) {
        throw new Error(`Recovery episode ${episodeId} is not authoritative for ${sessionId}`);
      }
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO session_recovery_deferred
           (session_id, episode_id, message_id, message_class, payload, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'deferred', ?)`,
      );
      for (const item of deferred) {
        insert.run(sessionId, episodeId, item.messageId, item.messageClass, item.payload, now);
      }
      const counters: ExpensiveTurnRecoveryCounters = {
        preserved: state.counters.preserved + countersDelta.preserved,
        coalesced: state.counters.coalesced + countersDelta.coalesced,
        dropped: state.counters.dropped + countersDelta.dropped,
        deferred: state.counters.deferred + countersDelta.deferred,
        replayed: state.counters.replayed + countersDelta.replayed,
      };
      this.db.prepare(
        'UPDATE session_recovery_heads SET counters = ?, updated_at = ? WHERE session_id = ? AND episode_id = ?',
      ).run(JSON.stringify(counters), now, sessionId, episodeId);
      return this.loadExpensiveTurnRecovery(sessionId)!;
    });
    return txn();
  }

  recordExpensiveTurnRecoveryAttempt(
    sessionId: string,
    episodeId: string,
    outcome: string,
    terminal: 'verified' | 'exhausted' | null,
  ): ExpensiveTurnRecoveryState {
    const now = Date.now();
    this.db.prepare(
      `UPDATE session_recovery_heads
       SET attempts = attempts + 1,
           state = COALESCE(?, state),
           last_outcome = ?,
           updated_at = ?
       WHERE session_id = ? AND episode_id = ?`,
    ).run(terminal, outcome, now, sessionId, episodeId);
    const state = this.loadExpensiveTurnRecovery(sessionId);
    if (!state || state.episodeId !== episodeId) {
      throw new Error(`Recovery episode ${episodeId} disappeared for ${sessionId}`);
    }
    return state;
  }

  listDeferredRecoveryMessages(sessionId: string, episodeId: string): DeferredRecoveryMessage[] {
    return this.db.prepare(
      `SELECT message_id AS messageId, message_class AS messageClass, payload
       FROM session_recovery_deferred
       WHERE session_id = ? AND episode_id = ? AND state != 'replayed'
       ORDER BY id`,
    ).all(sessionId, episodeId) as DeferredRecoveryMessage[];
  }

  /**
   * Durably record that one deferred row is being handed to the live inbox.
   * Startup treats both `deferred` and `releasing` as unacknowledged, so a
   * crash on either side of the in-memory enqueue is safe-at-least-once.
   */
  markDeferredRecoveryMessageReleasing(sessionId: string, episodeId: string, messageId: string): boolean {
    const result = this.db.prepare(
      `UPDATE session_recovery_deferred
       SET state = 'releasing'
       WHERE session_id = ? AND episode_id = ? AND message_id = ? AND state != 'replayed'`,
    ).run(sessionId, episodeId, messageId);
    return result.changes === 1;
  }

  /**
   * SCLI-415: per-state counts for one episode's deferred ledger.
   *
   * A monotonically growing `releasing` count with a flat `replayed` is the
   * ratchet signature (live evidence: releasing=65, replayed=8); a converging
   * drain shows `releasing` pinned at <= 1 while `replayed` climbs. Without
   * these split counts the two are indistinguishable from the outside.
   */
  countDeferredRecoveryMessagesByState(
    sessionId: string,
    episodeId: string,
  ): { deferred: number; releasing: number; replayed: number } {
    const rows = this.db.prepare(
      `SELECT state, COUNT(*) AS n
       FROM session_recovery_deferred
       WHERE session_id = ? AND episode_id = ?
       GROUP BY state`,
    ).all(sessionId, episodeId) as { state: string; n: number }[];
    const counts = { deferred: 0, releasing: 0, replayed: 0 };
    for (const row of rows) {
      if (row.state === 'deferred') counts.deferred = row.n;
      else if (row.state === 'releasing') counts.releasing = row.n;
      else if (row.state === 'replayed') counts.replayed = row.n;
    }
    return counts;
  }

  /** Acknowledge exactly one row only after the inbox finished processing it. */
  markDeferredRecoveryMessageReplayed(sessionId: string, episodeId: string, messageId: string): boolean {
    const now = Date.now();
    const txn = this.db.transaction((): boolean => {
      const result = this.db.prepare(
        `UPDATE session_recovery_deferred
         SET state = 'replayed', replayed_at = ?
         WHERE session_id = ? AND episode_id = ? AND message_id = ? AND state != 'replayed'`,
      ).run(now, sessionId, episodeId, messageId);
      if (result.changes !== 1) return false;
      const state = this.loadExpensiveTurnRecovery(sessionId);
      if (!state || state.episodeId !== episodeId) return true;
      const counters = { ...state.counters, replayed: state.counters.replayed + 1 };
      this.db.prepare(
        'UPDATE session_recovery_heads SET counters = ?, updated_at = ? WHERE session_id = ? AND episode_id = ?',
      ).run(JSON.stringify(counters), now, sessionId, episodeId);
      return true;
    });
    return txn();
  }

  private loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT message_id, execution_id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as StoredMessageRow[];

    return this.deserializeMessages(rows);
  }

  private deserializeMessages(rows: StoredMessageRow[]): Message[] {
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
      this.db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM session_message_transcript WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM session_interrupt_checkpoints WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM session_context_token_anchors WHERE session_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return txn();
  }

  /** Save or replace an interrupted-turn checkpoint for a session */
  saveInterruptCheckpoint(sessionId: string, checkpoint: InterruptCheckpoint): void {
    this.db.prepare(
      `INSERT INTO session_interrupt_checkpoints (session_id, created_at, prompt_excerpt, note, kind)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         created_at = excluded.created_at,
         prompt_excerpt = excluded.prompt_excerpt,
         note = excluded.note,
         kind = excluded.kind`,
    ).run(sessionId, checkpoint.createdAt, checkpoint.promptExcerpt, checkpoint.note, checkpoint.kind ?? 'turn');
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
      'SELECT created_at, prompt_excerpt, note, kind FROM session_interrupt_checkpoints WHERE session_id = ?',
    ).get(sessionId) as { created_at: number; prompt_excerpt: string; note: string; kind: string | null } | undefined;
    if (!row) return null;
    // Legacy rows (pre-kind builds): compaction lifecycle frames are
    // recognizable by their note prefix; everything else was a turn checkpoint.
    const kind: InterruptCheckpoint['kind'] = row.kind === 'maintenance' || row.kind === 'turn'
      ? row.kind
      : (/^(Compacting context|Context compaction)/.test(row.note) ? 'maintenance' : 'turn');
    return {
      createdAt: row.created_at,
      promptExcerpt: row.prompt_excerpt,
      note: row.note,
      kind,
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
