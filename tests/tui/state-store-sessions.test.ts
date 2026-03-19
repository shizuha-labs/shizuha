import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/state/store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('StateStore.listSessions', () => {
  let store: StateStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-test-'));
    store = new StateStore(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no sessions', () => {
    const sessions = store.listSessions();
    expect(sessions).toEqual([]);
  });

  it('returns created sessions ordered by updated_at DESC', () => {
    const s1 = store.createSession('model-a', '/tmp/a');
    const s2 = store.createSession('model-b', '/tmp/b');

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    // Most recent first (rowid tiebreaker when updated_at is identical)
    expect(sessions[0]!.id).toBe(s2.id);
    expect(sessions[1]!.id).toBe(s1.id);
  });

  it('returns correct fields', () => {
    const s = store.createSession('test-model', '/home/test');
    store.updateTokens(s.id, 100, 50);

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    const found = sessions[0]!;
    expect(found.id).toBe(s.id);
    expect(found.model).toBe('test-model');
    expect(found.cwd).toBe('/home/test');
    expect(found.turnCount).toBe(1);
    expect(found.totalInputTokens).toBe(100);
    expect(found.totalOutputTokens).toBe(50);
    expect(found.createdAt).toBeGreaterThan(0);
    expect(found.updatedAt).toBeGreaterThan(0);
  });

  it('respects limit parameter', () => {
    store.createSession('m1', '/a');
    store.createSession('m2', '/b');
    store.createSession('m3', '/c');

    const sessions = store.listSessions(2);
    expect(sessions).toHaveLength(2);
  });

  it('prioritizes preferred cwd when provided', () => {
    const other = store.createSession('m-other', '/workspace/other');
    const preferred = store.createSession('m-preferred', '/workspace/current');

    const sessions = store.listSessions(10, '/workspace/current');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.id).toBe(preferred.id);
    expect(sessions[1]!.id).toBe(other.id);
  });

  it('accumulates token updates', () => {
    const s = store.createSession('test-model', '/tmp');
    store.updateTokens(s.id, 100, 50);
    store.updateTokens(s.id, 200, 150);

    const sessions = store.listSessions();
    expect(sessions[0]!.totalInputTokens).toBe(300);
    expect(sessions[0]!.totalOutputTokens).toBe(200);
    expect(sessions[0]!.turnCount).toBe(2);
  });
});
