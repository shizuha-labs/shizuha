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

  it('restores token anchors only for an unchanged append-only message prefix', () => {
    const s = store.createSession('test-model', '/tmp');
    const baseline = [
      { role: 'user' as const, content: 'first', timestamp: 1 },
      { role: 'assistant' as const, content: 'second', timestamp: 2 },
    ];
    store.saveContextTokenAnchor(s.id, {
      model: 'test-model',
      providerInputTokens: 42_000,
      providerPromptEstimate: 0,
      rawPromptTokens: 38_000,
    }, baseline);

    expect(store.loadContextTokenAnchor(s.id, 'test-model', [
      ...baseline,
      { role: 'user' as const, content: 'growth', timestamp: 3 },
    ])).toMatchObject({
      providerInputTokens: 42_000,
      rawPromptTokens: 38_000,
      messageCount: 2,
    });
    expect(store.loadContextTokenAnchor(s.id, 'other-model', baseline)).toBeNull();
    expect(store.loadContextTokenAnchor(s.id, 'test-model', [
      { ...baseline[0]!, content: 'rewritten' },
      baseline[1]!,
    ])).toBeNull();

    // Prefix rewrites invalidate the absolute position but not the model's
    // tokenizer calibration. Resume sanitation must retain this evidence.
    expect(store.loadTokenizerCalibration(s.id, 'test-model')).toMatchObject({
      providerInputTokens: 42_000,
      rawPromptTokens: 38_000,
      ratio: 42_000 / 38_000,
    });
    expect(store.loadTokenizerCalibration(s.id, 'other-model')).toBeNull();
  });

  it('does not treat a provider fallback estimate as tokenizer evidence', () => {
    const s = store.createSession('test-model', '/tmp');
    const baseline = [{ role: 'user' as const, content: 'first', timestamp: 1 }];
    store.saveContextTokenAnchor(s.id, {
      model: 'test-model',
      providerInputTokens: 55_000,
      providerPromptEstimate: 55_000,
      rawPromptTokens: 38_000,
    }, baseline);

    expect(store.loadTokenizerCalibration(s.id, 'test-model')).toBeNull();
  });
});
