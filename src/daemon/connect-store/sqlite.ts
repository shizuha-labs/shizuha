/**
 * SQLite store for the daemon's mini-Connect.
 *
 * Mirrors the subset of shizuha-connect's PostgreSQL schema that matters for
 * single-user, single-process daemon operation. The wire-level event vocabulary
 * (see MESSAGING_PROTOCOL.md) is identical to the real platform's so clients
 * (browser, Kotlin, agents) can't tell the difference.
 *
 * DB file: ~/.shizuha/connect.db (WAL mode, mode 0o600).
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface User {
  id: number;
  username: string;
  email: string | null;
  passwordHash: string | null;
  isAgent: boolean;
  agentId: string | null;
  displayName: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  conversationType: 'direct' | 'group';
  name: string | null;
  directKey: string | null;
  createdById: number | null;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Participant {
  id: string;
  conversationId: string;
  userId: number;
  participantType: 'human' | 'agent' | 'system';
  agentId: string | null;
  isAdmin: boolean;
  lastReadAt: string | null;
  unreadCount: number;
  hasLeft: boolean;
  joinedAt: string;
}

export interface DirectMessage {
  id: string;
  conversationId: string;
  senderId: number;
  senderIsAgent: boolean;
  agentId: string | null;
  content: string;
  clientMessageId: string | null;
  seqNum: number;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
}

function defaultDbPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'connect.db');
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildDirectKey(a: number, b: number): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}:${hi}`;
}

export class ConnectStore {
  private db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }

    this.migrate();
  }

  close(): void { this.db.close(); }

  // ── Schema ──────────────────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS auth_users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        email         TEXT,
        password_hash TEXT,
        is_agent      INTEGER NOT NULL DEFAULT 0,
        agent_id      TEXT UNIQUE,
        display_name  TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_users_agent_id ON auth_users(agent_id);

      CREATE TABLE IF NOT EXISTS conversations (
        id                   TEXT PRIMARY KEY,
        conversation_type    TEXT NOT NULL DEFAULT 'direct'
                               CHECK(conversation_type IN ('direct','group')),
        name                 TEXT,
        direct_key           TEXT,
        created_by_id        INTEGER,
        message_count        INTEGER NOT NULL DEFAULT 0,
        last_message_at      TEXT,
        last_message_preview TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_key
        ON conversations(direct_key)
        WHERE conversation_type='direct' AND direct_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_conv_last_msg
        ON conversations(last_message_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_participants (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id          INTEGER NOT NULL,
        participant_type TEXT NOT NULL DEFAULT 'human'
                           CHECK(participant_type IN ('human','agent','system')),
        agent_id         TEXT,
        is_admin         INTEGER NOT NULL DEFAULT 0,
        last_read_at     TEXT,
        unread_count     INTEGER NOT NULL DEFAULT 0,
        has_left         INTEGER NOT NULL DEFAULT 0,
        joined_at        TEXT NOT NULL,
        UNIQUE(conversation_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_user
        ON conversation_participants(user_id, has_left);

      CREATE TABLE IF NOT EXISTS direct_messages (
        id                 TEXT PRIMARY KEY,
        conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id          INTEGER NOT NULL,
        sender_is_agent    INTEGER NOT NULL DEFAULT 0,
        agent_id           TEXT,
        content            TEXT NOT NULL,
        client_message_id  TEXT,
        seq_num            INTEGER NOT NULL,
        created_at         TEXT NOT NULL,
        edited_at          TEXT,
        is_deleted         INTEGER NOT NULL DEFAULT 0,
        UNIQUE(conversation_id, client_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dm_conv_seq
        ON direct_messages(conversation_id, seq_num);
      CREATE INDEX IF NOT EXISTS idx_dm_conv_created
        ON direct_messages(conversation_id, created_at);

      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `);
  }

  // ── Users ───────────────────────────────────────────────────────────────

  createUser(opts: {
    username: string;
    email?: string;
    passwordHash?: string;
    isAgent?: boolean;
    agentId?: string;
    displayName?: string;
  }): User {
    const stmt = this.db.prepare(`
      INSERT INTO auth_users (username, email, password_hash, is_agent, agent_id, display_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      opts.username,
      opts.email ?? null,
      opts.passwordHash ?? null,
      opts.isAgent ? 1 : 0,
      opts.agentId ?? null,
      opts.displayName ?? null,
      nowIso(),
    );
    const id = Number(info.lastInsertRowid);
    return this.getUserById(id)!;
  }

  upsertUser(opts: {
    username: string;
    email?: string;
    passwordHash?: string;
    isAgent?: boolean;
    agentId?: string;
    displayName?: string;
  }): User {
    const upsert = this.db.transaction(() => {
      const byUsername = this.getUserByUsername(opts.username);
      const byAgentId = opts.agentId ? this.getUserByAgentId(opts.agentId) : null;

      if (byUsername && byAgentId && byUsername.id !== byAgentId.id) {
        throw new Error(
          `Cannot reconcile mini-Connect user "${opts.username}": `
          + `agent_id "${opts.agentId}" already belongs to "${byAgentId.username}"`,
        );
      }

      // agent_id is the stable platform identity; username is mutable. Looking
      // up both keys makes daemon startup idempotent across agent renames while
      // preserving the existing row id (and therefore all conversation links).
      const existing = byAgentId ?? byUsername;
      if (existing) {
        this.db.prepare(`
          UPDATE auth_users
             SET username = ?,
                 email = COALESCE(?, email),
                 password_hash = COALESCE(?, password_hash),
                 is_agent = ?,
                 agent_id = COALESCE(?, agent_id),
                 display_name = COALESCE(?, display_name)
           WHERE id = ?
        `).run(
          opts.username,
          opts.email ?? null,
          opts.passwordHash ?? null,
          opts.isAgent ? 1 : 0,
          opts.agentId ?? null,
          opts.displayName ?? null,
          existing.id,
        );
        return this.getUserById(existing.id)!;
      }
      return this.createUser(opts);
    });

    // Serialize the read-both-keys/update sequence across daemon listeners or
    // processes sharing connect.db so concurrent bootstrap cannot race insert.
    return upsert.immediate();
  }

  getUserById(id: number): User | null {
    const row = this.db.prepare(`SELECT * FROM auth_users WHERE id = ?`).get(id) as any;
    return row ? rowToUser(row) : null;
  }

  getUserByUsername(username: string): User | null {
    const row = this.db.prepare(`SELECT * FROM auth_users WHERE username = ?`).get(username) as any;
    return row ? rowToUser(row) : null;
  }

  getUserByAgentId(agentId: string): User | null {
    const row = this.db.prepare(`SELECT * FROM auth_users WHERE agent_id = ?`).get(agentId) as any;
    return row ? rowToUser(row) : null;
  }

  listUsers(): User[] {
    const rows = this.db.prepare(`SELECT * FROM auth_users ORDER BY id`).all() as any[];
    return rows.map(rowToUser);
  }

  setPassword(userId: number, passwordHash: string): void {
    this.db.prepare(`UPDATE auth_users SET password_hash = ? WHERE id = ?`).run(passwordHash, userId);
  }

  // ── Conversations ───────────────────────────────────────────────────────

  /** Atomic find-or-create for a 1:1 DM. Closes TOCTOU via UNIQUE(direct_key). */
  findOrCreateDirectConversation(
    userAId: number,
    userBId: number,
    opts?: { creatorId?: number; participantTypes?: Record<number, 'human' | 'agent' | 'system'>; agentIds?: Record<number, string> },
  ): Conversation {
    const directKey = buildDirectKey(userAId, userBId);
    const existing = this.db.prepare(
      `SELECT * FROM conversations WHERE conversation_type='direct' AND direct_key = ?`
    ).get(directKey) as any;
    if (existing) return rowToConversation(existing);

    return this.db.transaction(() => {
      // Re-check inside the txn — partial unique index closes any race.
      const inner = this.db.prepare(
        `SELECT * FROM conversations WHERE conversation_type='direct' AND direct_key = ?`
      ).get(directKey) as any;
      if (inner) return rowToConversation(inner);

      const id = crypto.randomUUID();
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO conversations (id, conversation_type, direct_key, created_by_id, created_at, updated_at)
        VALUES (?, 'direct', ?, ?, ?, ?)
      `).run(id, directKey, opts?.creatorId ?? null, now, now);

      const participantStmt = this.db.prepare(`
        INSERT INTO conversation_participants
          (id, conversation_id, user_id, participant_type, agent_id, is_admin, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const uid of [userAId, userBId]) {
        const ptype = opts?.participantTypes?.[uid] ?? 'human';
        const aid = opts?.agentIds?.[uid] ?? null;
        participantStmt.run(crypto.randomUUID(), id, uid, ptype, aid, 0, now);
      }
      return this.getConversationById(id)!;
    })();
  }

  createGroupConversation(opts: {
    name: string;
    creatorId: number;
    participantUserIds: number[];
    participantTypes?: Record<number, 'human' | 'agent' | 'system'>;
    agentIds?: Record<number, string>;
  }): Conversation {
    return this.db.transaction(() => {
      const id = crypto.randomUUID();
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO conversations (id, conversation_type, name, created_by_id, created_at, updated_at)
        VALUES (?, 'group', ?, ?, ?, ?)
      `).run(id, opts.name, opts.creatorId, now, now);

      const participantStmt = this.db.prepare(`
        INSERT INTO conversation_participants
          (id, conversation_id, user_id, participant_type, agent_id, is_admin, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const allIds = new Set([opts.creatorId, ...opts.participantUserIds]);
      for (const uid of allIds) {
        const ptype = opts.participantTypes?.[uid] ?? 'human';
        const aid = opts.agentIds?.[uid] ?? null;
        participantStmt.run(
          crypto.randomUUID(), id, uid, ptype, aid,
          uid === opts.creatorId ? 1 : 0, now,
        );
      }
      return this.getConversationById(id)!;
    })();
  }

  getConversationById(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as any;
    return row ? rowToConversation(row) : null;
  }

  listUserConversations(userId: number): Conversation[] {
    const rows = this.db.prepare(`
      SELECT c.*
        FROM conversations c
        JOIN conversation_participants p ON p.conversation_id = c.id
       WHERE p.user_id = ? AND p.has_left = 0
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
    `).all(userId) as any[];
    return rows.map(rowToConversation);
  }

  listParticipants(conversationId: string): Participant[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_participants WHERE conversation_id = ?
    `).all(conversationId) as any[];
    return rows.map(rowToParticipant);
  }

  isParticipant(conversationId: string, userId: number): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM conversation_participants
       WHERE conversation_id = ? AND user_id = ? AND has_left = 0
    `).get(conversationId, userId);
    return !!row;
  }

  // ── Messages ────────────────────────────────────────────────────────────

  /**
   * Create a message with monotonic seq_num (per conversation), update the
   * conversation's last_message_at + preview, and return the persisted row.
   * Returns the existing message if `clientMessageId` was already used in this
   * conversation (idempotent — same as real Connect's UNIQUE constraint).
   */
  createMessage(opts: {
    conversationId: string;
    senderId: number;
    senderIsAgent?: boolean;
    agentId?: string | null;
    content: string;
    clientMessageId?: string | null;
  }): DirectMessage {
    return this.db.transaction(() => {
      // Idempotency: if this conversation already has a message with the same
      // client_message_id, return it instead of duplicating.
      if (opts.clientMessageId) {
        const dup = this.db.prepare(`
          SELECT * FROM direct_messages
           WHERE conversation_id = ? AND client_message_id = ?
        `).get(opts.conversationId, opts.clientMessageId) as any;
        if (dup) return rowToMessage(dup);
      }

      const maxRow = this.db.prepare(`
        SELECT COALESCE(MAX(seq_num), 0) AS m FROM direct_messages WHERE conversation_id = ?
      `).get(opts.conversationId) as { m: number };
      const seqNum = maxRow.m + 1;

      const id = crypto.randomUUID();
      const now = nowIso();
      this.db.prepare(`
        INSERT INTO direct_messages
          (id, conversation_id, sender_id, sender_is_agent, agent_id, content,
           client_message_id, seq_num, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        opts.conversationId,
        opts.senderId,
        opts.senderIsAgent ? 1 : 0,
        opts.agentId ?? null,
        opts.content,
        opts.clientMessageId ?? null,
        seqNum,
        now,
      );

      // Update conversation rollups.
      this.db.prepare(`
        UPDATE conversations
           SET message_count = message_count + 1,
               last_message_at = ?,
               last_message_preview = ?,
               updated_at = ?
         WHERE id = ?
      `).run(now, opts.content.slice(0, 100), now, opts.conversationId);

      // Bump unread counts for everyone except the sender.
      this.db.prepare(`
        UPDATE conversation_participants
           SET unread_count = unread_count + 1
         WHERE conversation_id = ? AND user_id != ? AND has_left = 0
      `).run(opts.conversationId, opts.senderId);

      return this.getMessageById(id)!;
    })();
  }

  getMessageById(id: string): DirectMessage | null {
    const row = this.db.prepare(`SELECT * FROM direct_messages WHERE id = ?`).get(id) as any;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Paginated message list. Default order is chronological (oldest → newest)
   * for clients that page from the top. Pass `before` (seq_num) to fetch the
   * previous page and `limit` to cap the response.
   */
  listMessages(
    conversationId: string,
    opts?: { limit?: number; before?: number },
  ): DirectMessage[] {
    const limit = Math.min(opts?.limit ?? 200, 1000);
    const rows = opts?.before
      ? this.db.prepare(`
          SELECT * FROM direct_messages
           WHERE conversation_id = ? AND seq_num < ?
           ORDER BY seq_num DESC LIMIT ?
        `).all(conversationId, opts.before, limit) as any[]
      : this.db.prepare(`
          SELECT * FROM direct_messages
           WHERE conversation_id = ?
           ORDER BY seq_num DESC LIMIT ?
        `).all(conversationId, limit) as any[];
    // Reverse so callers always get chronological order.
    return rows.reverse().map(rowToMessage);
  }

  /**
   * Mark messages up to and including `messageId` as read for `userId`.
   * Returns the IDs that newly transitioned (were unread before this call).
   * Mirrors UserChatConsumer._persist_read_receipt cascade behaviour.
   */
  markAsRead(conversationId: string, userId: number, messageId: string): string[] {
    return this.db.transaction(() => {
      const target = this.db.prepare(`
        SELECT seq_num FROM direct_messages WHERE id = ? AND conversation_id = ?
      `).get(messageId, conversationId) as { seq_num: number } | undefined;
      if (!target) return [];

      const part = this.db.prepare(`
        SELECT last_read_at FROM conversation_participants
         WHERE conversation_id = ? AND user_id = ?
      `).get(conversationId, userId) as { last_read_at: string | null } | undefined;
      if (!part) return [];

      const newlyRead = this.db.prepare(`
        SELECT id FROM direct_messages
         WHERE conversation_id = ?
           AND seq_num <= ?
           AND sender_id != ?
           AND (? IS NULL OR created_at > ?)
         ORDER BY seq_num ASC
      `).all(
        conversationId, target.seq_num, userId,
        part.last_read_at, part.last_read_at,
      ) as Array<{ id: string }>;

      const now = nowIso();
      this.db.prepare(`
        UPDATE conversation_participants
           SET last_read_at = ?, unread_count = 0
         WHERE conversation_id = ? AND user_id = ?
      `).run(now, conversationId, userId);

      return newlyRead.map(r => r.id);
    })();
  }
}

// ── Row mappers ───────────────────────────────────────────────────────────

function rowToUser(r: any): User {
  return {
    id: r.id,
    username: r.username,
    email: r.email ?? null,
    passwordHash: r.password_hash ?? null,
    isAgent: !!r.is_agent,
    agentId: r.agent_id ?? null,
    displayName: r.display_name ?? null,
    createdAt: r.created_at,
  };
}

function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    conversationType: r.conversation_type,
    name: r.name ?? null,
    directKey: r.direct_key ?? null,
    createdById: r.created_by_id ?? null,
    messageCount: r.message_count,
    lastMessageAt: r.last_message_at ?? null,
    lastMessagePreview: r.last_message_preview ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToParticipant(r: any): Participant {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    participantType: r.participant_type,
    agentId: r.agent_id ?? null,
    isAdmin: !!r.is_admin,
    lastReadAt: r.last_read_at ?? null,
    unreadCount: r.unread_count,
    hasLeft: !!r.has_left,
    joinedAt: r.joined_at,
  };
}

function rowToMessage(r: any): DirectMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    senderIsAgent: !!r.sender_is_agent,
    agentId: r.agent_id ?? null,
    content: r.content,
    clientMessageId: r.client_message_id ?? null,
    seqNum: r.seq_num,
    createdAt: r.created_at,
    editedAt: r.edited_at ?? null,
    isDeleted: !!r.is_deleted,
  };
}
