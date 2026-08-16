import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ currentText: 'a', rootPath: '/tmp', sessionId: 'session-a' }));

// Mock the vscode module since it's not available in test environment
vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      const root = mockState.rootPath;
      return [{ uri: { scheme: 'file', fsPath: root, toString: () => `file://${root}` } }];
    },
    getWorkspaceFolder: vi.fn().mockImplementation((uri) => uri.fsPath.startsWith(`${mockState.rootPath}/`)
      ? { uri: { scheme: 'file', fsPath: mockState.rootPath, toString: () => `file://${mockState.rootPath}` } }
      : undefined),
    openTextDocument: vi.fn().mockImplementation(async (input) => input?.content !== undefined
      ? { uri: { toString: () => 'untitled://test' }, lineCount: 1, getText: () => input.content }
      : { uri: input, lineCount: 1, getText: () => mockState.currentText }),
    applyEdit: vi.fn().mockResolvedValue(true),
  },
  window: {
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showTextDocument: vi.fn().mockResolvedValue(undefined),
    // SCLI-321: the diff preview doc uri is 'untitled://test' (openTextDocument
    // mock); expose it as an open diff tab so closePreviewTab can match + close it.
    tabGroups: {
      all: [
        { tabs: [{ input: { modified: { toString: () => 'untitled://test' } } }] },
      ],
      close: vi.fn().mockResolvedValue(undefined),
    },
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  Uri: {
    file: (path: string) => ({ path, fsPath: path, scheme: 'file', toString: () => `file://${path}` }),
  },
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  WorkspaceEdit: class {
    replace = vi.fn();
    createFile = vi.fn();
    insert = vi.fn();
  },
}));

import { FileDiffHandler, resolveWorkspaceTarget, type DiffActionResult } from '../extensions/vscode/src/file-diff.js';
import type { DiffProposedPayload } from '../src/local-core-protocol.js';

describe('FileDiffHandler', () => {
  it('tracks pending diffs and rejects them', async () => {
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler((r) => results.push(r));

    expect(handler.pendingCount).toBe(0);

    const diff: DiffProposedPayload = {
      file_path: 'test.ts',
      original_content: 'const a = 1;',
      proposed_content: 'const a = 2;',
      description: 'Update constant',
      language: 'typescript',
    };

    const pending = await handler.handleDiffProposed(diff);
    expect(pending.filePath).toBe('test.ts');
    expect(pending.proposedContent).toBe('const a = 2;');
    expect(handler.pendingCount).toBe(1);

    const result = await handler.rejectDiff(pending.id);
    expect(result).toBeDefined();
    expect(result!.action).toBe('rejected');
    expect(result!.filePath).toBe('test.ts');
    expect(handler.pendingCount).toBe(0);
  });

  it('handles unsupported diffs without opening preview', async () => {
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler((r) => results.push(r));

    const diff: DiffProposedPayload = {
      file_path: 'large.bin',
      proposed_content: '',
      unsupported: true,
      unsupported_reason: 'Binary file, 50MB exceeds limit.',
    };

    const pending = await handler.handleDiffProposed(diff);
    expect(pending.unsupported).toBe(true);
    expect(pending.unsupportedReason).toBe('Binary file, 50MB exceeds limit.');
    expect(handler.pendingCount).toBe(1);

    // Reject unsupported diff
    const result = await handler.rejectDiff(pending.id);
    expect(result).toBeDefined();
    expect(result!.action).toBe('rejected');
    expect(handler.pendingCount).toBe(0);
  });

  it('rejects all pending diffs', async () => {
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler((r) => results.push(r));

    await handler.handleDiffProposed({
      file_path: 'a.ts',
      original_content: 'a',
      proposed_content: 'b',
    });
    await handler.handleDiffProposed({
      file_path: 'b.ts',
      original_content: 'c',
      proposed_content: 'd',
    });

    expect(handler.pendingCount).toBe(2);

    const rejected = await handler.rejectAll();
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.action === 'rejected')).toBe(true);
    expect(handler.pendingCount).toBe(0);
  });

  it('returns undefined for unknown diff id', async () => {
    const handler = new FileDiffHandler(() => {});
    const result = await handler.acceptDiff('nonexistent');
    expect(result).toBeUndefined();
  });

  it('reserveDiffId returns sequential IDs', () => {
    const handler = new FileDiffHandler(() => {});
    expect(handler.reserveDiffId()).toBe('diff-1');
    expect(handler.reserveDiffId()).toBe('diff-2');
    expect(handler.reserveDiffId()).toBe('diff-3');
  });

  it('accepts a preassigned ID from reserveDiffId', async () => {
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler((r) => results.push(r));

    const diffId = handler.reserveDiffId();
    expect(diffId).toBe('diff-1');

    const pending = await handler.handleDiffProposed({
      file_path: 'test.ts',
      original_content: 'a',
      proposed_content: 'b',
    }, diffId);

    expect(pending.id).toBe('diff-1');
    expect(handler.pendingCount).toBe(1);

    const result = await handler.rejectDiff('diff-1');
    expect(result).toBeDefined();
    expect(result!.diffId).toBe('diff-1');
    expect(handler.pendingCount).toBe(0);
  });

  it('closes the specific preview tab by URI, not the active editor', async () => {
    const vscode = await import('vscode');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = vscode.window as any;
    win.tabGroups.close.mockClear();
    vscode.commands.executeCommand.mockClear();

    const handler = new FileDiffHandler(() => {});
    const pending = await handler.handleDiffProposed({
      file_path: 'x.ts',
      original_content: 'a',
      proposed_content: 'b',
      language: 'typescript',
    });

    await handler.rejectDiff(pending.id);

    // The stored preview tab (uri 'untitled://test') is closed via tabGroups...
    expect(win.tabGroups.close).toHaveBeenCalledTimes(1);
    const closedTab = win.tabGroups.close.mock.calls[0][0];
    expect(closedTab.input.modified.toString()).toBe('untitled://test');
    // ...and closeActiveEditor is NEVER used (would close a focused chat webview
    // or unrelated editor).
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'workbench.action.closeActiveEditor',
    );
  });

  it('rejects absolute, traversal, sibling-root, and symlink-escape targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shizuha-diff-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'shizuha-diff-outside-'));
    await mkdir(join(root, 'safe'));
    await symlink(outside, join(root, 'escape'));

    await expect(resolveWorkspaceTarget(root, '/tmp/absolute.ts')).rejects.toThrow(/relative workspace path/);
    await expect(resolveWorkspaceTarget(root, '../sibling.ts')).rejects.toThrow(/traversal/);
    await expect(resolveWorkspaceTarget(root, `${outside}/sibling.ts`)).rejects.toThrow(/relative workspace path/);
    await expect(resolveWorkspaceTarget(root, 'escape/secret.ts')).rejects.toThrow(/symlink/);
    await expect(resolveWorkspaceTarget(root, 'safe/new.ts')).resolves.toBe(join(root, 'safe', 'new.ts'));
  });

  it('fails closed when current file bytes differ from the previewed original', async () => {
    const vscode = await import('vscode');
    mockState.currentText = 'changed after preview';
    vscode.workspace.applyEdit.mockClear();
    const handler = new FileDiffHandler(() => {});
    const pending = await handler.handleDiffProposed({
      file_path: 'stale.ts',
      original_content: 'previewed original',
      proposed_content: 'replacement',
    });

    await expect(handler.acceptDiff(pending.id)).resolves.toBeUndefined();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    mockState.currentText = 'a';
  });

  it('rechecks bytes inside the commit lock after the preflight read', async () => {
    const vscode = await import('vscode');
    vscode.workspace.applyEdit.mockClear();
    const handler = new FileDiffHandler(() => {});
    const pending = await handler.handleDiffProposed({
      file_path: 'concurrent.ts', original_content: 'a', proposed_content: 'agent',
    });
    vscode.workspace.openTextDocument
      .mockImplementationOnce(async (uri) => ({ uri, lineCount: 1, getText: () => 'a' }))
      .mockImplementationOnce(async (uri) => ({ uri, lineCount: 1, getText: () => 'user edit' }));

    await expect(handler.acceptDiff(pending.id)).resolves.toBeUndefined();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it('does not overwrite a file that appeared after a new-file preview', async () => {
    const vscode = await import('vscode');
    const target = join('/tmp', `shizuha-diff-appeared-${process.pid}.ts`);
    await writeFile(target, 'user content');
    vscode.workspace.applyEdit.mockClear();
    const handler = new FileDiffHandler(() => {});
    const pending = await handler.handleDiffProposed({
      file_path: target.slice('/tmp/'.length),
      proposed_content: 'agent replacement',
    });
    await expect(handler.acceptDiff(pending.id)).resolves.toBeUndefined();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it('does not carry a proposal across workspace-root or core-session changes', async () => {
    const vscode = await import('vscode');
    const rootA = await mkdtemp(join(tmpdir(), 'shizuha-diff-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'shizuha-diff-b-'));
    await writeFile(join(rootA, 'same.txt'), 'a');
    await writeFile(join(rootB, 'same.txt'), 'a');
    mockState.rootPath = rootA;
    mockState.sessionId = 'session-a';
    mockState.currentText = 'a';
    vscode.workspace.applyEdit.mockClear();
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler((result) => results.push(result), () => mockState.sessionId);
    const pending = await handler.handleDiffProposed({
      file_path: 'same.txt',
      original_content: 'a',
      proposed_content: 'b',
    }, undefined, 'session-a');

    mockState.rootPath = rootB;
    mockState.sessionId = 'session-b';
    await expect(handler.acceptDiff(pending.id)).resolves.toBeUndefined();
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(results).toEqual([]);

    mockState.rootPath = '/tmp';
    mockState.sessionId = 'session-a';
  });

  it('serializes a paused accept against disconnect invalidation before commit', async () => {
    const vscode = await import('vscode');
    const root = await mkdtemp(join(tmpdir(), 'shizuha-diff-race-'));
    await writeFile(join(root, 'same.txt'), 'a');
    mockState.rootPath = root;
    mockState.sessionId = 'session-a';
    mockState.currentText = 'a';
    vscode.workspace.applyEdit.mockClear();
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler((result) => results.push(result), () => mockState.sessionId, () => 7);
    const pending = await handler.handleDiffProposed({
      file_path: 'same.txt', original_content: 'a', proposed_content: 'b',
    }, undefined, 'session-a');

    let releaseRead!: () => void;
    const pausedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    vscode.workspace.openTextDocument.mockImplementationOnce(async (uri) => {
      await pausedRead;
      return { uri, lineCount: 1, getText: () => 'a' };
    });
    const accept = handler.acceptDiff(pending.id);
    await Promise.resolve();
    const invalidate = handler.rejectAll();
    releaseRead();

    await expect(accept).resolves.toBeUndefined();
    await expect(invalidate).resolves.toMatchObject([{ action: 'rejected' }]);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(results.map((result) => result.action)).toEqual(['rejected']);

    mockState.rootPath = '/tmp';
    mockState.sessionId = 'session-a';
  });

  it('does not insert a late A proposal after disconnect while its preview is opening', async () => {
    const vscode = await import('vscode');
    const root = await mkdtemp(join(tmpdir(), 'shizuha-diff-preview-race-'));
    mockState.rootPath = root;
    mockState.sessionId = 'session-a';
    let generation = 11;
    const results: DiffActionResult[] = [];
    const handler = new FileDiffHandler(
      (result) => results.push(result),
      () => mockState.sessionId,
      () => generation,
    );
    let releasePreview!: () => void;
    const previewPaused = new Promise<void>((resolve) => { releasePreview = resolve; });
    vscode.commands.executeCommand.mockImplementationOnce(async () => previewPaused);

    const proposal = handler.handleDiffProposed({
      file_path: 'late.txt', original_content: 'a', proposed_content: 'b',
    }, undefined, 'session-a', 11);
    while (handler.pendingCount === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    generation = 12;
    mockState.sessionId = 'session-b';
    const rejected = await handler.rejectAll();
    releasePreview();

    await expect(proposal).rejects.toThrow(/ownership changed/);
    expect(rejected).toMatchObject([{ action: 'rejected', sessionId: 'session-a', connectionGeneration: 11 }]);
    expect(handler.pendingCount).toBe(0);
    expect(results).toEqual(rejected);

    mockState.rootPath = '/tmp';
    mockState.sessionId = 'session-a';
  });
});
