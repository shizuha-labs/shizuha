/**
 * Append-only event log for dashboard message reliability.
 *
 * Kafka-style design: server writes events with auto-incrementing sequence
 * numbers per agent. Clients track their own cursor (last-seen seq). On
 * reconnect, the client says "give me everything after seq X" and the server
 * replays from the log. Zero per-client state on the server.
 *
 * Schema:
 *   event_log(seq INTEGER PK AUTOINCREMENT, agent_id TEXT, event TEXT, ts INTEGER)
 *   Index on (agent_id, seq) for fast cursor-based replay.
 *
 * Retention: events older than 24h are reaped by the daemon tick.
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Event types worth persisting (affect chat reconstruction). */
const DURABLE_EVENT_TYPES = new Set([
  'content',
  'tool_start',
  'tool_complete',
  'complete',
  'error',
  'session_start',
  'user_message',
  'proactive_message',
]);

/** Check whether an event should be persisted to the log. */
export function isDurableEvent(event: Record<string, unknown>): boolean {
  const type = event.type as string;
  if (DURABLE_EVENT_TYPES.has(type)) return true;
  // Gateway WS wraps events: { type: 'stream_event', event: { type: 'content', ... } }
  if (type === 'stream_event' && event.event) {
    const innerType = (event.event as Record<string, unknown>).type as string;
    return DURABLE_EVENT_TYPES.has(innerType);
  }
  // execution_complete → complete, execution_error → error
  if (type === 'execution_complete' || type === 'execution_error') return true;
  return false;
}

export interface ReplayedEvent {
  seq: number;
  ts: number;
  event: Record<string, unknown>;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_REPLAY_LIMIT = 2000;

export class EventLog {
  private db: Database.Database;
  private appendStmt: Database.Statement;
  private replayStmt: Database.Statement;
  private reapStmt: Database.Statement;
  private latestSeqStmt: Database.Statement;

  constructor(dbPath?: string) {
    const dir = dbPath
      ? path.dirname(dbPath)
      : path.join(process.env['HOME'] ?? '.', '.shizuha');
    fs.mkdirSync(dir, { recursive: true });
    const file = dbPath ?? path.join(dir, 'event-log.db');

    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id  TEXT NOT NULL,
        event     TEXT NOT NULL,
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_log_agent_seq
        ON event_log(agent_id, seq);
    `);

    this.appendStmt = this.db.prepare(
      'INSERT INTO event_log (agent_id, event, ts) VALUES (?, ?, ?)',
    );
    this.replayStmt = this.db.prepare(
      'SELECT seq, event, ts FROM event_log WHERE agent_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    );
    this.reapStmt = this.db.prepare(
      'DELETE FROM event_log WHERE ts < ?',
    );
    this.latestSeqStmt = this.db.prepare(
      'SELECT MAX(seq) AS latest FROM event_log WHERE agent_id = ?',
    );
  }

  /**
   * Append an event to the log. Returns the assigned sequence number.
   * Only call this for durable events (use isDurableEvent() to check).
   */
  append(agentId: string, event: Record<string, unknown>): number {
    const result = this.appendStmt.run(agentId, JSON.stringify(event), Date.now());
    return Number(result.lastInsertRowid);
  }

  /**
   * Replay events for an agent after a given cursor (sequence number).
   * Returns events in order, each tagged with its seq.
   */
  replay(agentId: string, afterSeq: number, limit = DEFAULT_REPLAY_LIMIT): ReplayedEvent[] {
    const rows = this.replayStmt.all(agentId, afterSeq, limit) as Array<{
      seq: number;
      event: string;
      ts: number;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      event: JSON.parse(r.event) as Record<string, unknown>,
    }));
  }

  /**
   * Get the latest sequence number for an agent.
   * Returns 0 if no events exist.
   */
  latestSeq(agentId: string): number {
    const row = this.latestSeqStmt.get(agentId) as { latest: number | null } | undefined;
    return row?.latest ?? 0;
  }

  /**
   * Remove events older than the given retention period.
   * Returns the number of events deleted.
   */
  reap(retentionMs = DEFAULT_RETENTION_MS): number {
    const cutoff = Date.now() - retentionMs;
    const result = this.reapStmt.run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
