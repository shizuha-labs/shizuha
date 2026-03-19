import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/state/store.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('StateStore extras', () => {
  let store: StateStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-store-test-'));
    store = new StateStore(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('deleteSession', () => {
    it('deletes an existing session and its messages', () => {
      const session = store.createSession('test-model', '/tmp');
      store.appendMessage(session.id, { role: 'user', content: 'hello', timestamp: Date.now() });
      store.appendMessage(session.id, { role: 'assistant', content: 'hi', timestamp: Date.now() });

      const deleted = store.deleteSession(session.id);
      expect(deleted).toBe(true);

      const loaded = store.loadSession(session.id);
      expect(loaded).toBeNull();
    });

    it('returns false for nonexistent session', () => {
      const deleted = store.deleteSession('nonexistent-id');
      expect(deleted).toBe(false);
    });

    it('does not affect other sessions', () => {
      const s1 = store.createSession('model1', '/tmp');
      const s2 = store.createSession('model2', '/tmp');
      store.appendMessage(s1.id, { role: 'user', content: 'msg1', timestamp: Date.now() });
      store.appendMessage(s2.id, { role: 'user', content: 'msg2', timestamp: Date.now() });

      store.deleteSession(s1.id);

      const loaded = store.loadSession(s2.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(1);
    });
  });

  describe('tool approvals', () => {
    it('saves and loads tool approvals', () => {
      store.saveToolApproval('bash');
      store.saveToolApproval('write_file');

      const approvals = store.loadToolApprovals();
      expect(approvals).toContain('bash');
      expect(approvals).toContain('write_file');
    });

    it('handles duplicate saves (INSERT OR IGNORE)', () => {
      store.saveToolApproval('bash');
      store.saveToolApproval('bash');

      const approvals = store.loadToolApprovals();
      expect(approvals.filter((a) => a === 'bash')).toHaveLength(1);
    });

    it('removes tool approvals', () => {
      store.saveToolApproval('bash');
      store.saveToolApproval('write_file');

      store.removeToolApproval('bash');

      const approvals = store.loadToolApprovals();
      expect(approvals).not.toContain('bash');
      expect(approvals).toContain('write_file');
    });

    it('returns empty array when no approvals', () => {
      const approvals = store.loadToolApprovals();
      expect(approvals).toEqual([]);
    });
  });

  describe('interrupt checkpoints', () => {
    it('saves and loads interrupt checkpoint on session', () => {
      const session = store.createSession('test-model', '/tmp');
      store.saveInterruptCheckpoint(session.id, {
        createdAt: Date.now(),
        promptExcerpt: 'resume-checkpoint',
        note: 'Previous turn was interrupted before completion.',
      });

      const loaded = store.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.interruptCheckpoint).toBeTruthy();
      expect(loaded!.interruptCheckpoint!.promptExcerpt).toBe('resume-checkpoint');
      expect(loaded!.interruptCheckpoint!.note).toContain('interrupted');
    });

    it('clears interrupt checkpoint', () => {
      const session = store.createSession('test-model', '/tmp');
      store.saveInterruptCheckpoint(session.id, {
        createdAt: Date.now(),
        promptExcerpt: 'resume-checkpoint',
        note: 'Previous turn was interrupted before completion.',
      });

      store.clearInterruptCheckpoint(session.id);
      const loaded = store.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.interruptCheckpoint).toBeUndefined();
    });
  });

  describe('message identity persistence', () => {
    it('preserves external message ids and execution ids across load', () => {
      const session = store.createSession('test-model', '/tmp');
      store.appendMessage(session.id, {
        id: 'msg-user-1',
        executionId: 'exec-1',
        role: 'user',
        content: 'hello',
        timestamp: 1000,
      });
      store.appendMessage(session.id, {
        id: 'msg-assistant-1',
        executionId: 'exec-1',
        role: 'assistant',
        content: 'hi',
        timestamp: 2000,
      });

      const loaded = store.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toEqual([
        {
          id: 'msg-user-1',
          executionId: 'exec-1',
          role: 'user',
          content: 'hello',
          timestamp: 1000,
        },
        {
          id: 'msg-assistant-1',
          executionId: 'exec-1',
          role: 'assistant',
          content: 'hi',
          timestamp: 2000,
        },
      ]);
    });
  });
});
