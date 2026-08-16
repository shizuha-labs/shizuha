import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWritableSqliteDatabase } from '../../src/daemon/sqlite-writable-repair.js';

describe('ensureWritableSqliteDatabase', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-writable-repair-'));
    tempDirs.push(dir);
    return path.join(dir, '.shizuha-state.db');
  }

  it('leaves an already-writable database untouched', async () => {
    const dbPath = tempDbPath();
    const db = new Database(dbPath);
    db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('kept')");
    db.close();
    const before = fs.statSync(dbPath);

    await expect(ensureWritableSqliteDatabase(dbPath)).resolves.toBe('writable');

    const after = fs.statSync(dbPath);
    expect(after.ino).toBe(before.ino);
  });

  it('replaces a read-only legacy database without losing its committed state', async () => {
    const dbPath = tempDbPath();
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('preserved')");
    db.close();
    fs.chmodSync(dbPath, 0o444);
    const before = fs.statSync(dbPath);

    await expect(ensureWritableSqliteDatabase(dbPath)).resolves.toBe('repaired');

    const after = fs.statSync(dbPath);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    const verify = new Database(dbPath);
    expect(verify.prepare('SELECT value FROM proof').pluck().get()).toBe('preserved');
    expect(() => verify.exec("INSERT INTO proof VALUES ('writable')")).not.toThrow();
    verify.close();
  });

  it('does not replace a corrupt read-only source', async () => {
    const dbPath = tempDbPath();
    const original = Buffer.from('not a sqlite database');
    fs.writeFileSync(dbPath, original, { mode: 0o444 });

    await expect(ensureWritableSqliteDatabase(dbPath)).rejects.toThrow();

    expect(fs.readFileSync(dbPath)).toEqual(original);
    expect(
      fs.readdirSync(path.dirname(dbPath)).filter((name) => name.includes('.writable-repair-')),
    ).toEqual([]);
  });

  it('reports an absent database without creating one', async () => {
    const dbPath = tempDbPath();

    await expect(ensureWritableSqliteDatabase(dbPath)).resolves.toBe('absent');
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
