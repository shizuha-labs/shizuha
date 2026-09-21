import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pinPreparedStatements } from '../../src/shared/sqlite-statement-cache.js';
import { StateStore } from '../../src/state/store.js';

describe('pinPreparedStatements', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('returns the same Statement object for the same SQL (keeps it reachable)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-pin-'));
    tmpDirs.push(dir);
    const db = new Database(path.join(dir, 'pin.db'));
    pinPreparedStatements(db);
    db.exec('CREATE TABLE t (id INTEGER)');
    const a = db.prepare('SELECT id FROM t WHERE id = ?');
    const b = db.prepare('SELECT id FROM t WHERE id = ?');
    expect(a).toBe(b);
    a.run(1);
    db.close();
  });

  it('StateStore survives a burst of session writes then forced GC (Aoi gen-28 path)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-store-'));
    tmpDirs.push(dir);
    const store = new StateStore(path.join(dir, 'state.db'));
    const session = store.createSession('test-model', dir);
    for (let i = 0; i < 50; i++) {
      store.appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i}`,
        timestamp: Date.now() + i,
      });
    }
    store.replaceMessages(session.id, []);
    if (typeof globalThis.gc === 'function') globalThis.gc();
    expect(store.loadSession(session.id)?.messages ?? []).toEqual([]);
    store.appendMessage(session.id, { role: 'user', content: 'after-gc', timestamp: Date.now() });
    expect((store.loadSession(session.id)?.messages ?? []).map((m) => m.content)).toEqual(['after-gc']);
    store.close();
  });
});
