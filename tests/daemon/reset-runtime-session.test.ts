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
    CREATE TABLE messages_fts (session_id TEXT, content TEXT);
    CREATE TABLE session_interrupt_checkpoints (session_id TEXT, checkpoint TEXT);
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
    db.prepare('INSERT INTO messages_fts (session_id, content) VALUES (?, ?)').run('agent-session-a', 'hello');
    db.prepare('INSERT INTO messages_fts (session_id, content) VALUES (?, ?)').run('agent-session-b', 'keep');
    db.prepare('INSERT INTO session_interrupt_checkpoints (session_id, checkpoint) VALUES (?, ?)').run('agent-session-a', 'cp-a');
    db.prepare('INSERT INTO session_interrupt_checkpoints (session_id, checkpoint) VALUES (?, ?)').run('agent-session-b', 'cp-b');
    db.close();

    resetSqliteSessionDatabase(dbPath, 'agent-session-a');

    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([{ id: 'agent-session-b' }]);
    expect(verify.prepare('SELECT id, session_id, content FROM messages ORDER BY id').all()).toEqual([
      { id: 'm-b', session_id: 'agent-session-b', content: 'keep' },
    ]);
    expect(verify.prepare('SELECT session_id, checkpoint FROM session_interrupt_checkpoints ORDER BY session_id').all()).toEqual([
      { session_id: 'agent-session-b', checkpoint: 'cp-b' },
    ]);
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
