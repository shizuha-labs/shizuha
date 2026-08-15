import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSqliteSessionDatabase } from '../../src/daemon/manager.js';

function makeDb(file: string): Database.Database {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
    CREATE TABLE session_message_transcript (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
    CREATE TABLE messages_fts (session_id TEXT, content TEXT);
    CREATE TABLE session_interrupt_checkpoints (session_id TEXT, checkpoint TEXT);
    CREATE TABLE session_wire_prefix (session_id TEXT, messages_json TEXT);
    CREATE TABLE session_provider_prefix_snapshots (session_id TEXT, payload_hash TEXT);
    CREATE TABLE session_provider_prefix_heads (session_id TEXT, model TEXT);
    CREATE TABLE session_context_token_anchors (session_id TEXT, message_count INTEGER);
    CREATE TABLE session_inbound_processing (session_id TEXT, message_id TEXT);
    CREATE TABLE session_recovery_heads (session_id TEXT, episode_id TEXT);
    CREATE TABLE session_recovery_deferred (session_id TEXT, message_id TEXT);
  `);
  return db;
}

describe('resetSqliteSessionDatabase', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes only the targeted session rows when the database is writable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-session-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const db = makeDb(dbPath);
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('agent-session-a');
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('agent-session-b');
    db.prepare('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)').run('m-a', 'agent-session-a', 'hello');
    db.prepare('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)').run('m-b', 'agent-session-b', 'keep');
    db.prepare('INSERT INTO session_message_transcript (id, session_id, content) VALUES (?, ?, ?)').run('t-a', 'agent-session-a', 'hello');
    db.prepare('INSERT INTO session_message_transcript (id, session_id, content) VALUES (?, ?, ?)').run('t-b', 'agent-session-b', 'keep');
    db.prepare('INSERT INTO messages_fts (session_id, content) VALUES (?, ?)').run('agent-session-a', 'hello');
    db.prepare('INSERT INTO messages_fts (session_id, content) VALUES (?, ?)').run('agent-session-b', 'keep');
    db.prepare('INSERT INTO session_interrupt_checkpoints (session_id, checkpoint) VALUES (?, ?)').run('agent-session-a', 'cp-a');
    db.prepare('INSERT INTO session_interrupt_checkpoints (session_id, checkpoint) VALUES (?, ?)').run('agent-session-b', 'cp-b');
    db.prepare('INSERT INTO session_wire_prefix (session_id, messages_json) VALUES (?, ?)').run('agent-session-a', '[poison]');
    db.prepare('INSERT INTO session_wire_prefix (session_id, messages_json) VALUES (?, ?)').run('agent-session-b', '[keep]');
    db.prepare('INSERT INTO session_provider_prefix_snapshots (session_id, payload_hash) VALUES (?, ?)').run('agent-session-a', 'snap-a');
    db.prepare('INSERT INTO session_provider_prefix_heads (session_id, model) VALUES (?, ?)').run('agent-session-a', 'm');
    db.prepare('INSERT INTO session_context_token_anchors (session_id, message_count) VALUES (?, ?)').run('agent-session-a', 979);
    db.prepare('INSERT INTO session_inbound_processing (session_id, message_id) VALUES (?, ?)').run('agent-session-a', 'in-a');
    db.prepare('INSERT INTO session_recovery_heads (session_id, episode_id) VALUES (?, ?)').run('agent-session-a', 'ep-a');
    db.prepare('INSERT INTO session_recovery_deferred (session_id, message_id) VALUES (?, ?)').run('agent-session-a', 'def-a');
    db.close();

    resetSqliteSessionDatabase(dbPath, 'agent-session-a');

    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([{ id: 'agent-session-b' }]);
    expect(verify.prepare('SELECT id, session_id, content FROM messages ORDER BY id').all()).toEqual([
      { id: 'm-b', session_id: 'agent-session-b', content: 'keep' },
    ]);
    expect(verify.prepare('SELECT id, session_id, content FROM session_message_transcript ORDER BY id').all()).toEqual([
      { id: 't-b', session_id: 'agent-session-b', content: 'keep' },
    ]);
    expect(verify.prepare('SELECT session_id, checkpoint FROM session_interrupt_checkpoints ORDER BY session_id').all()).toEqual([
      { session_id: 'agent-session-b', checkpoint: 'cp-b' },
    ]);
    expect(verify.prepare('SELECT session_id, messages_json FROM session_wire_prefix ORDER BY session_id').all()).toEqual([
      { session_id: 'agent-session-b', messages_json: '[keep]' },
    ]);
    expect(verify.prepare('SELECT count(*) AS n FROM session_provider_prefix_snapshots').get()).toEqual({ n: 0 });
    expect(verify.prepare('SELECT count(*) AS n FROM session_provider_prefix_heads').get()).toEqual({ n: 0 });
    expect(verify.prepare('SELECT count(*) AS n FROM session_context_token_anchors').get()).toEqual({ n: 0 });
    expect(verify.prepare('SELECT count(*) AS n FROM session_inbound_processing').get()).toEqual({ n: 0 });
    expect(verify.prepare('SELECT count(*) AS n FROM session_recovery_heads').get()).toEqual({ n: 0 });
    expect(verify.prepare('SELECT count(*) AS n FROM session_recovery_deferred').get()).toEqual({ n: 0 });
    verify.close();
  });

  it('falls back to deleting the database files when sqlite is readonly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-session-ro-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const db = makeDb(dbPath);
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run('agent-session-a');
    db.prepare('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)').run('m-a', 'agent-session-a', 'hello');
    db.pragma('journal_mode = WAL');
    db.close();

    const txSpy = vi.spyOn(Database.prototype, 'transaction').mockImplementation(() => {
      throw new Error('attempt to write a readonly database');
    });

    resetSqliteSessionDatabase(dbPath, 'agent-session-a');

    txSpy.mockRestore();

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
