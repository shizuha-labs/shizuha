import * as vscode from 'vscode';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { DiffProposedPayload, DiffApplyResult } from '../../../src/local-core-protocol.js';

/**
 * Pending diff state: a diff_proposed event that the user hasn't acted on yet.
 */
export interface PendingDiff {
  id: string;
  filePath: string;
  originalContent?: string;
  proposedContent: string;
  description?: string;
  language?: string;
  unsupported: boolean;
  unsupportedReason?: string;
  /** Proposal-time ownership boundary. Acceptance must match all three. */
  workspaceRootUri: string;
  canonicalTarget: string;
  sessionId: string;
  connectionGeneration: number;
  invalidationEpoch: number;
  /** The VS Code tab/editor used to show the diff preview. */
  previewTab?: vscode.TextDocument;
  /** Read-only virtual documents owned by this preview. */
  previewUris?: string[];
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

export async function resolveWorkspaceTarget(rootPath: string, candidate: string): Promise<string> {
  if (!candidate || candidate.includes('\0') || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new Error('Diff file_path must be a relative workspace path.');
  }
  const segments = candidate.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Diff file_path contains an empty or traversal segment.');
  }
  const canonicalRoot = await realpath(rootPath);
  const lexicalTarget = path.resolve(rootPath, ...segments);
  if (!isWithin(path.resolve(rootPath), lexicalTarget)) throw new Error('Diff target escapes the workspace root.');

  const existing = await nearestExistingPath(lexicalTarget);
  const canonicalExisting = await realpath(existing);
  const suffix = path.relative(existing, lexicalTarget);
  const canonicalTarget = path.resolve(canonicalExisting, suffix);
  if (!isWithin(canonicalRoot, canonicalTarget)) throw new Error('Diff target escapes the workspace through a symlink.');
  return canonicalTarget;
}

export type DiffAction = 'accepted' | 'rejected' | 'partial';

export interface DiffActionResult {
  diffId: string;
  filePath: string;
  action: DiffAction;
  sessionId: string;
  connectionGeneration: number;
}

/**
 * Mediates file/diff preview, apply, and reject through the extension host.
 *
 * The webview must never mutate workspace files directly. All apply/reject
 * actions flow through this handler, which uses VS Code's native diff editor
 * APIs and reports results back to the core protocol.
 */
export class FileDiffHandler {
  private pendingDiffs: Map<string, PendingDiff> = new Map();
  private seq = 0;
  private readonly onDiffResult: (result: DiffActionResult) => void;
  private readonly currentSessionId: () => string | undefined;
  private readonly currentConnectionGeneration: () => number;
  private invalidationEpoch = 0;
  private commitTail: Promise<void> = Promise.resolve();
  private readonly previewContents = new Map<string, string>();
  private readonly readonlyPreviewProviderAvailable: boolean;

  constructor(
    onDiffResult: (result: DiffActionResult) => void,
    currentSessionId: () => string | undefined = () => 'test-session',
    currentConnectionGeneration: () => number = () => 0,
  ) {
    this.onDiffResult = onDiffResult;
    this.currentSessionId = currentSessionId;
    this.currentConnectionGeneration = currentConnectionGeneration;
    const registerProvider = (vscode.workspace as unknown as {
      registerTextDocumentContentProvider?: (
        scheme: string,
        provider: { provideTextDocumentContent(uri: vscode.Uri): string },
      ) => unknown;
    }).registerTextDocumentContentProvider;
    this.readonlyPreviewProviderAvailable = typeof registerProvider === 'function';
    if (registerProvider) {
      registerProvider.call(vscode.workspace, 'shizuha-diff', {
        provideTextDocumentContent: (uri) => this.previewContents.get(uri.toString()) ?? '',
      });
    }
  }

  /** Number of pending (unacted) diffs. */
  get pendingCount(): number {
    return this.pendingDiffs.size;
  }

  /** Snapshot of pending diffs for UI display. */
  pendingSnapshot(): PendingDiff[] {
    return Array.from(this.pendingDiffs.values());
  }

  /**
   * Synchronously reserve a diff ID without creating a pending diff.
   * The caller passes the returned ID to both handleDiffProposed and
   * ChatSessionState.handleEvent so they use the same authoritative ID.
   */
  reserveDiffId(): string {
    return this.nextId();
  }

  /**
   * Handle a diff_proposed event from the core.
   * Opens a VS Code diff preview and records the pending diff.
   *
   * @param diff - The diff payload from the core.
   * @param preassignedId - An ID from reserveDiffId(), or undefined to auto-generate.
   */
  async handleDiffProposed(
    diff: DiffProposedPayload,
    preassignedId?: string,
    proposalSessionId = this.currentSessionId(),
    proposalConnectionGeneration = this.currentConnectionGeneration(),
  ): Promise<PendingDiff> {
    const id = preassignedId ?? this.nextId();
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || root.uri.scheme !== 'file') throw new Error('Open one local file workspace before previewing a diff.');
    if (!proposalSessionId) throw new Error('A live core session is required before previewing a diff.');
    const proposalWorkspaceRootUri = root.uri.toString();
    const proposalInvalidationEpoch = this.invalidationEpoch;
    const canonicalTarget = await resolveWorkspaceTarget(root.uri.fsPath, diff.file_path);
    if (this.invalidationEpoch !== proposalInvalidationEpoch
      || this.currentSessionId() !== proposalSessionId
      || this.currentConnectionGeneration() !== proposalConnectionGeneration
      || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== proposalWorkspaceRootUri) {
      throw new Error('Diff ownership changed while preparing the proposal.');
    }
    const pending: PendingDiff = {
      id,
      filePath: diff.file_path,
      originalContent: diff.original_content,
      proposedContent: diff.proposed_content,
      description: diff.description,
      language: diff.language,
      unsupported: diff.unsupported === true,
      unsupportedReason: diff.unsupported_reason,
      workspaceRootUri: proposalWorkspaceRootUri,
      canonicalTarget,
      sessionId: proposalSessionId,
      connectionGeneration: proposalConnectionGeneration,
      invalidationEpoch: proposalInvalidationEpoch,
    };

    // Register before any UI await so disconnect()/rejectAll() can invalidate
    // a proposal while VS Code is opening the preview.
    this.pendingDiffs.set(id, pending);

    if (pending.unsupported) {
      // Show an error message for unsupported files instead of a diff preview
      const reason = pending.unsupportedReason || 'File is too large or binary for diff preview.';
      void vscode.window.showWarningMessage(
        `Shizuha: Cannot preview diff for ${diff.file_path} — ${reason}`,
        'Reject',
      ).then((choice: string | undefined) => {
        if (choice === 'Reject') {
          this.rejectDiff(id);
        }
      });
      return pending;
    }

    // Open a VS Code diff preview
    try {
      const previewTab = await this.openDiffPreview(pending);
      pending.previewTab = previewTab;
      if (this.pendingDiffs.get(id) !== pending
        || this.invalidationEpoch !== proposalInvalidationEpoch
        || this.currentSessionId() !== proposalSessionId
        || this.currentConnectionGeneration() !== proposalConnectionGeneration) {
        void this.closePreviewTab(pending);
        throw new Error('Diff ownership changed while opening the preview.');
      }
    } catch (err) {
      if (this.pendingDiffs.get(id) !== pending) throw err;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Shizuha: Failed to open diff preview: ${message}`);
    }
    return pending;
  }

  /**
   * Accept a pending diff — applies the proposed content to the file.
   * Returns the action result for reporting back to the core.
   */
  async acceptDiff(diffId: string): Promise<DiffActionResult | undefined> {
    if (vscode.workspace.isTrusted === false) {
      void vscode.window.showWarningMessage('Shizuha: Trust this workspace before applying agent-proposed file changes.');
      return undefined;
    }
    const pending = this.pendingDiffs.get(diffId);
    if (!pending) {
      void vscode.window.showWarningMessage(`Shizuha: No pending diff found for id "${diffId}".`);
      return undefined;
    }

    if (pending.unsupported) {
      void vscode.window.showWarningMessage(
        `Shizuha: Cannot apply diff for ${pending.filePath} — ${pending.unsupportedReason || 'unsupported file type'}.`,
      );
      return undefined;
    }

    try {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root || root.uri.scheme !== 'file') throw new Error('Open one local file workspace before applying a diff.');
      if (root.uri.toString() !== pending.workspaceRootUri) {
        throw new Error('Workspace root changed after the diff proposal; refresh the proposal.');
      }
      if (this.currentSessionId() !== pending.sessionId) {
        throw new Error('Core session changed after the diff proposal; refresh the proposal.');
      }
      if (this.currentConnectionGeneration() !== pending.connectionGeneration) {
        throw new Error('Core connection changed after the diff proposal; refresh the proposal.');
      }
      const target = await resolveWorkspaceTarget(root.uri.fsPath, pending.filePath);
      if (target !== pending.canonicalTarget) {
        throw new Error('Canonical diff target changed after the proposal; refresh the proposal.');
      }
      const uri = vscode.Uri.file(target);
      const owner = vscode.workspace.getWorkspaceFolder(uri);
      if (!owner || owner.uri.toString() !== root.uri.toString()) {
        throw new Error('Diff target is not owned by the active workspace root.');
      }
      const workspaceEdit = new vscode.WorkspaceEdit();

      // Never clobber bytes that changed after the preview was created.
      if (pending.originalContent !== undefined) {
        const current = await vscode.workspace.openTextDocument(uri);
        if (current.getText() !== pending.originalContent) {
          throw new Error('File changed after the diff preview; refresh the proposal before applying.');
        }
        const fullRange = new vscode.Range(0, 0, current.lineCount, 0);
        workspaceEdit.replace(uri, fullRange, pending.proposedContent);
      } else {
        try {
          await lstat(target);
          throw new Error('Diff proposed a new file but the target now exists.');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        workspaceEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        const fullRange = new vscode.Range(0, 0, 0, 0);
        workspaceEdit.insert(uri, fullRange.start, pending.proposedContent);
      }

      return await this.withCommitLock(async () => {
        // This is the single linearization point. disconnect()/rejectAll()
        // increments invalidationEpoch before waiting for this lock, so a
        // paused pre-commit accept can never apply after a session switch.
        if (this.pendingDiffs.get(diffId) !== pending
          || this.invalidationEpoch !== pending.invalidationEpoch
          || this.currentSessionId() !== pending.sessionId
          || this.currentConnectionGeneration() !== pending.connectionGeneration
          || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== pending.workspaceRootUri) {
          throw new Error('Diff ownership changed before commit; refresh the proposal.');
        }
        // Revalidate the target bytes inside the commit section. The earlier
        // check is only a fast preflight; this check is the compare immediately
        // before applyEdit and therefore closes the preview-to-commit TOCTOU.
        const commitEdit = new vscode.WorkspaceEdit();
        if (pending.originalContent !== undefined) {
          const current = await vscode.workspace.openTextDocument(uri);
          if (current.getText() !== pending.originalContent) {
            throw new Error('File changed before the diff commit; refresh the proposal before applying.');
          }
          commitEdit.replace(uri, new vscode.Range(0, 0, current.lineCount, 0), pending.proposedContent);
        } else {
          try {
            await lstat(target);
            throw new Error('Diff proposed a new file but the target appeared before commit.');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          commitEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
          commitEdit.insert(uri, new vscode.Range(0, 0, 0, 0).start, pending.proposedContent);
        }
        const applied = await vscode.workspace.applyEdit(commitEdit);
        if (!applied) {
          void vscode.window.showErrorMessage(`Shizuha: Failed to apply diff to ${pending.filePath}.`);
          return undefined;
        }

        this.pendingDiffs.delete(diffId);
        void this.closePreviewTab(pending);
        const result: DiffActionResult = {
          diffId,
          filePath: pending.filePath,
          action: 'accepted',
          sessionId: pending.sessionId,
          connectionGeneration: pending.connectionGeneration,
        };
        this.onDiffResult(result);
        return result;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Shizuha: Error applying diff: ${message}`);
      return undefined;
    }
  }

  /**
   * Reject a pending diff — discards the proposed change without modifying the file.
   */
  async rejectDiff(diffId: string): Promise<DiffActionResult | undefined> {
    const pending = this.pendingDiffs.get(diffId);
    if (!pending) {
      void vscode.window.showWarningMessage(`Shizuha: No pending diff found for id "${diffId}".`);
      return undefined;
    }

    return this.withCommitLock(async () => this.rejectPending(diffId, pending));
  }

  /**
   * Reject all pending diffs (e.g., on run cancel/error).
   */
  async rejectAll(): Promise<DiffActionResult[]> {
    // Invalidate synchronously before waiting for a paused accept.
    this.invalidationEpoch += 1;
    return this.withCommitLock(async () => {
      const results: DiffActionResult[] = [];
      for (const [id, pending] of [...this.pendingDiffs]) {
        const result = await this.rejectPending(id, pending);
        if (result) results.push(result);
      }
      return results;
    });
  }

  private async rejectPending(diffId: string, pending: PendingDiff): Promise<DiffActionResult | undefined> {
    if (this.pendingDiffs.get(diffId) !== pending) return undefined;
    this.pendingDiffs.delete(diffId);
    void this.closePreviewTab(pending);
    const result: DiffActionResult = {
      diffId,
      filePath: pending.filePath,
      action: 'rejected',
      sessionId: pending.sessionId,
      connectionGeneration: pending.connectionGeneration,
    };
    this.onDiffResult(result);
    return result;
  }

  private async withCommitLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.commitTail;
    let release!: () => void;
    this.commitTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Open a VS Code diff preview showing original vs proposed content.
   * Returns the temporary document for the proposed content.
   */
  private async openDiffPreview(pending: PendingDiff): Promise<vscode.TextDocument> {
    const fileName = pending.filePath.split('/').pop() || pending.filePath;
    const language = pending.language || this.guessLanguage(fileName);
    const openPreviewDocument = async (kind: 'original' | 'proposed', content: string) => {
      if (!this.readonlyPreviewProviderAvailable) {
        return vscode.workspace.openTextDocument({ content, language });
      }
      const uri = vscode.Uri.parse(`shizuha-diff:/${encodeURIComponent(pending.id)}/${kind}/${encodeURIComponent(fileName)}`);
      this.previewContents.set(uri.toString(), content);
      pending.previewUris = [...(pending.previewUris ?? []), uri.toString()];
      const document = await vscode.workspace.openTextDocument(uri);
      if (vscode.languages?.setTextDocumentLanguage) {
        return vscode.languages.setTextDocumentLanguage(document, language);
      }
      return document;
    };

    // Use read-only virtual documents. Untitled documents are dirty by design
    // and closing a rejected preview otherwise opens a misleading Save dialog.
    const proposedDoc = await openPreviewDocument('proposed', pending.proposedContent);

    // If we have original content, show a side-by-side diff
    if (pending.originalContent !== undefined) {
      const originalDoc = await openPreviewDocument('original', pending.originalContent);

      await vscode.commands.executeCommand(
        'vscode.diff',
        originalDoc.uri,
        proposedDoc.uri,
        `${fileName}: proposed changes — ${pending.description || 'Shizuha edit'}`,
      );
    } else {
      // No original content — show the proposed content as a new file preview
      await vscode.window.showTextDocument(proposedDoc, { preview: true });
    }

    return proposedDoc;
  }

  /**
   * Close the specific preview/diff tab opened for this pending diff.
   *
   * SCLI-321 review fix: the previous implementation ran
   * `workbench.action.closeActiveEditor`, which closes whatever the user has
   * FOCUSED when Accept/Reject fires. Since the action is initiated from the
   * chat webview, that could close the chat panel or an unrelated editor while
   * leaving the actual diff preview open. Instead, match the stored preview
   * document URI against the open tabs and close only that tab.
   *
   * The VS Code tab API (`window.tabGroups`) isn't declared in the local shim;
   * access it defensively so a host without it skips the close rather than
   * falling back to mis-closing the active editor.
   */
  private async closePreviewTab(pending: PendingDiff): Promise<void> {
    const doc = pending.previewTab;
    if (!doc) return;
    const target = doc.uri.toString();
    const tabGroups = (vscode.window as unknown as {
      tabGroups?: {
        all?: Array<{ tabs?: Array<{ input?: unknown }> }>;
        close(tab: unknown): PromiseLike<unknown>;
      };
    }).tabGroups;
    if (!tabGroups || !Array.isArray(tabGroups.all)) return;
    for (const group of tabGroups.all) {
      for (const tab of group.tabs ?? []) {
        const input = (tab?.input ?? {}) as {
          uri?: { toString(): string };
          modified?: { toString(): string };
          original?: { toString(): string };
        };
        const uris = [input.uri, input.modified, input.original]
          .filter((u): u is { toString(): string } => !!u)
          .map((u) => u.toString());
        if (uris.includes(target)) {
          await tabGroups.close(tab);
          for (const uri of pending.previewUris ?? []) this.previewContents.delete(uri);
          return;
        }
      }
    }
    for (const uri of pending.previewUris ?? []) this.previewContents.delete(uri);
  }

  /** Guess a VS Code language id from the file extension. */
  private guessLanguage(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      css: 'css',
      scss: 'scss',
      html: 'html',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sql: 'sql',
      sh: 'shellscript',
      bash: 'shellscript',
      dockerfile: 'dockerfile',
      toml: 'toml',
      xml: 'xml',
      vue: 'vue',
      svelte: 'svelte',
    };
    return langMap[ext] || 'plaintext';
  }

  /** Get the line count of a document URI. */
  private async lineCount(uri: vscode.Uri): Promise<number> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.lineCount;
    } catch {
      return 1;
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `diff-${this.seq}`;
  }
}
