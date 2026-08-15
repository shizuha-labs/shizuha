import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/state/store.js';
import Database from 'better-sqlite3';
import { buildProviderPrefixSnapshot } from '../../src/telemetry/provider-prefix-continuity.js';
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

  it('persists inbound processing completion for idempotent Connect replay', () => {
    store.createSessionWithId('processing-session', 'model', '/tmp');
    expect(store.inboundProcessingCompleted('processing-session', 'message-1')).toBe(false);
    store.markInboundProcessingAdmitted('processing-session', 'message-1', 'connect');
    expect(store.inboundProcessingCompleted('processing-session', 'message-1')).toBe(false);
    store.markInboundProcessingCompleted('processing-session', 'message-1');
    expect(store.inboundProcessingCompleted('processing-session', 'message-1')).toBe(true);
    store.createSessionWithId('successor-session', 'model', '/tmp');
    expect(store.inboundProcessingCompleted('successor-session', 'message-1')).toBe(true);
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

    it('defaults kind to turn and round-trips maintenance kind', () => {
      const session = store.createSession('test-model', '/tmp');
      store.saveInterruptCheckpoint(session.id, {
        createdAt: Date.now(),
        promptExcerpt: '(unknown prompt)',
        note: 'Previous turn was interrupted before completion.',
      });
      expect(store.loadSession(session.id)!.interruptCheckpoint!.kind).toBe('turn');

      store.saveInterruptCheckpoint(session.id, {
        createdAt: Date.now(),
        promptExcerpt: '(unknown prompt)',
        note: 'Compacting context (resume)... reading conversation',
        kind: 'maintenance',
      });
      expect(store.loadSession(session.id)!.interruptCheckpoint!.kind).toBe('maintenance');
    });

    it('classifies legacy kind-less compaction frames as maintenance', () => {
      const session = store.createSession('test-model', '/tmp');
      store.saveInterruptCheckpoint(session.id, {
        createdAt: Date.now(),
        promptExcerpt: '(unknown prompt)',
        note: 'Compacting context (resume) (retry) 140/1.0k tok',
      });
      // Simulate a row written by a pre-kind build.
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
        .db.prepare('UPDATE session_interrupt_checkpoints SET kind = NULL WHERE session_id = ?')
        .run(session.id);
      expect(store.loadSession(session.id)!.interruptCheckpoint!.kind).toBe('maintenance');
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

  describe('canonical transcript persistence', () => {
    it('keeps original structured history when the active context is replaced', () => {
      const session = store.createSession('cortex/GLM-5.2', '/tmp');
      const originals = [
        {
          id: 'user-1',
          executionId: 'exec-1',
          role: 'user' as const,
          content: 'original searchable request',
          timestamp: 1000,
        },
        {
          id: 'assistant-1',
          executionId: 'exec-1',
          role: 'assistant' as const,
          content: [{ type: 'tool_use' as const, id: 'tool-1', name: 'read', input: { path: '/tmp/a' } }],
          timestamp: 2000,
        },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, toolUseId: 'tool-1', content: 'structured result' }],
          timestamp: 3000,
        },
      ];
      for (const message of originals) store.appendMessage(session.id, message);

      const bounded = [{
        role: 'user' as const,
        content: '[System Notice] bounded working context',
        timestamp: 4000,
      }];
      store.replaceMessages(session.id, bounded);

      expect(store.loadSession(session.id)!.messages).toEqual(bounded);
      const transcript = store.loadTranscriptMessages(session.id);
      expect(transcript.slice(0, originals.length)).toEqual(originals);
      expect(transcript).toContainEqual(bounded[0]);
      expect(store.searchMessages('searchable').some((row) => row.sessionId === session.id)).toBe(true);
    });

    it('migrates unmatched legacy FTS history once and remains idempotent', () => {
      const legacyPath = path.join(tmpDir, 'legacy.db');
      const db = new Database(legacyPath);
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, model TEXT NOT NULL, cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          total_input_tokens INTEGER DEFAULT 0, total_output_tokens INTEGER DEFAULT 0,
          turn_count INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          session_id UNINDEXED, role UNINDEXED, content, timestamp UNINDEXED
        );
      `);
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, 0, 0, 0)')
        .run('legacy-session', 'model', '/tmp', 1, 1);
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('legacy-session', 'user', 'current row', 20);
      db.prepare('INSERT INTO messages_fts VALUES (?, ?, ?, ?)')
        .run('legacy-session', 'user', 'dropped but recoverable row', 10);
      db.close();

      const migrated = new StateStore(legacyPath);
      expect(migrated.loadTranscriptMessages('legacy-session').map((m) => m.content)).toEqual([
        'dropped but recoverable row',
        'current row',
      ]);
      migrated.close();
      const reopened = new StateStore(legacyPath);
      expect(reopened.loadTranscriptMessages('legacy-session')).toHaveLength(2);
      reopened.close();
    });
  });

  it('persists and replaces provider prefix snapshots for cache-continuity checks', () => {
    const session = store.createSession('DeepSeek-V4-Flash', tmpDir);
    const first = buildProviderPrefixSnapshot({
      model: 'DeepSeek-V4-Flash',
      contextWindow: 262144,
      systemPrompt: 'system',
      tools: [],
      chatMessages: [{ role: 'user', content: 'hello' }],
      createdAt: 111,
    });
    store.saveProviderPrefixSnapshot(session.id, first);
    expect(store.loadProviderPrefixSnapshot(session.id)).toEqual(first);

    const second = buildProviderPrefixSnapshot({
      model: 'DeepSeek-V4-Flash',
      contextWindow: 262144,
      systemPrompt: 'system',
      tools: [],
      chatMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      createdAt: 222,
    });
    store.saveProviderPrefixSnapshot(session.id, second);
    expect(store.loadProviderPrefixSnapshot(session.id)).toEqual(second);
  });

  describe('wire prefix (provable resume identity, operator 2026-08-08)', () => {
    it('round-trips the exact payload bytes and is cleared by any history rewrite', () => {
      const session = store.createSession('DeepSeek-V4-Flash', '/tmp');
      expect(store.loadWirePrefix(session.id)).toBeNull();
      const payload = JSON.stringify([
        { role: 'user', content: [{ type: 'text', text: 'structured' }] },
        { role: 'assistant', content: 'plain' },
      ]);
      store.saveWirePrefix(session.id, 2, payload);
      const loaded = store.loadWirePrefix(session.id);
      expect(loaded?.sourceCount).toBe(2);
      expect(loaded?.messagesJson).toBe(payload); // byte-identical
      // replaceMessages is the rewrite choke-point — it must invalidate.
      store.replaceMessages(session.id, [
        { role: 'user', content: 'rewritten', timestamp: 1 },
      ]);
      expect(store.loadWirePrefix(session.id)).toBeNull();
    });
  });

  describe('provider prefix heads (PLAT-4189 resume pin)', () => {
    it('round-trips the byte-exact prompt head', () => {
      const session = store.createSession('DeepSeek-V4-Flash', '/tmp');
      expect(store.loadProviderPrefixHead(session.id)).toBeNull();
      const head = {
        createdAt: 1234,
        model: 'DeepSeek-V4-Flash',
        systemPrompt: 'exact bytes\n\n---\n\n## Git Context\nBranch: main',
        toolDefs: JSON.stringify([{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }]),
      };
      store.saveProviderPrefixHead(session.id, head);
      expect(store.loadProviderPrefixHead(session.id)).toEqual(head);
      const updated = { ...head, createdAt: 5678, systemPrompt: 'new bytes' };
      store.saveProviderPrefixHead(session.id, updated);
      expect(store.loadProviderPrefixHead(session.id)).toEqual(updated);
    });
  });
});
