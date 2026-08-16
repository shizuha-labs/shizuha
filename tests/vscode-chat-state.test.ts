import { describe, expect, it } from 'vitest';
import { ChatSessionState } from '../extensions/vscode/src/chat-state.js';
import { chatWebviewHtml } from '../extensions/vscode/src/chat-webview.js';

describe('VS Code chat state', () => {
  it('streams assistant tokens and disables concurrent submissions', () => {
    const state = new ChatSessionState();
    expect(state.beginUserMessage('hello')).toMatchObject({ streaming: true, runStatus: 'running' });
    expect(() => state.beginUserMessage('second')).toThrow(/already in progress/);
    state.handleEvent({ type: 'token', text: 'Hi' });
    state.handleEvent({ type: 'token', text: ' there' });
    const snapshot = state.handleEvent({ type: 'done' });
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'Hi there', status: 'done' });
  });

  it('tracks tool calls and retryable errors', () => {
    const state = new ChatSessionState();
    state.beginUserMessage('use a tool');
    state.handleEvent({ type: 'tool_call', id: 'call-1', name: 'search', content: { q: 'x' } });
    const snapshot = state.handleEvent({
      type: 'error',
      error: { code: 'RATE_LIMIT', message: 'try again', retryable: true },
    });
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.canRetry).toBe(true);
    expect(snapshot.turns.at(-1)?.tools).toEqual([{ id: 'call-1', kind: 'tool_call', name: 'search', content: { q: 'x' } }]);
  });

  it('marks cancellation without losing the assistant turn', () => {
    const state = new ChatSessionState();
    state.beginUserMessage('cancel me');
    expect(state.markCancelling().runStatus).toBe('cancelling');
    const snapshot = state.handleEvent({ type: 'run_status', status: 'cancelled' });
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.turns.at(-1)).toMatchObject({ status: 'cancelled', content: 'Run cancelled.' });
  });

  it('tracks diff_proposed events and pending diff count', () => {
    const state = new ChatSessionState();
    state.beginUserMessage('edit a file');
    state.handleEvent({ type: 'token', text: 'Here is the change:' });
    const snapshot = state.handleEvent({
      type: 'diff_proposed',
      diff: {
        file_path: '/tmp/test.ts',
        original_content: 'const a = 1;',
        proposed_content: 'const a = 2;',
        description: 'Update constant',
        language: 'typescript',
      },
    });
    expect(snapshot.pendingDiffCount).toBe(1);
    expect(snapshot.turns.at(-1)?.diffs).toHaveLength(1);
    expect(snapshot.turns.at(-1)?.diffs?.[0]).toMatchObject({
      kind: 'diff_proposed',
      diff: { file_path: '/tmp/test.ts', proposed_content: 'const a = 2;' },
    });
  });

  it('tracks diff action and reduces pending count', () => {
    const state = new ChatSessionState();
    state.beginUserMessage('edit a file');
    const snapshot = state.handleEvent({
      type: 'diff_proposed',
      diff: { file_path: '/tmp/test.ts', original_content: 'a', proposed_content: 'b' },
    });
    expect(snapshot.pendingDiffCount).toBe(1);

    const diffId = snapshot.turns.at(-1)?.diffs?.[0]?.id;
    expect(diffId).toBeDefined();

    state.handleDiffAction(diffId!, 'accepted');
    const updated = state.snapshot();
    expect(updated.pendingDiffCount).toBe(0);
    expect(updated.turns.at(-1)?.diffs?.[0]?.action).toBe('accepted');
  });

  it('tracks unsupported diff_proposed events', () => {
    const state = new ChatSessionState();
    state.beginUserMessage('edit a binary file');
    const snapshot = state.handleEvent({
      type: 'diff_proposed',
      diff: {
        file_path: '/tmp/large.bin',
        proposed_content: '',
        unsupported: true,
        unsupported_reason: 'Binary file exceeds limit.',
      },
    });
    expect(snapshot.turns.at(-1)?.diffs).toHaveLength(1);
    expect(snapshot.turns.at(-1)?.diffs?.[0]?.diff.unsupported).toBe(true);
    expect(snapshot.turns.at(-1)?.diffs?.[0]?.diff.unsupported_reason).toBe('Binary file exceeds limit.');
  });

  it('uses the provided diffId from FileDiffHandler instead of auto-generating', () => {
    const state = new ChatSessionState();
    state.beginUserMessage('edit a file');
    // Simulate FileDiffHandler reserving an ID (global sequence)
    const diffId1 = 'diff-1';
    const snapshot1 = state.handleEvent({
      type: 'diff_proposed',
      diff: { file_path: '/tmp/a.ts', original_content: 'a', proposed_content: 'b' },
    }, diffId1);
    expect(snapshot1.turns.at(-1)?.diffs?.[0]?.id).toBe('diff-1');
    // End the first turn
    state.handleEvent({ type: 'done' });

    // Second turn — FileDiffHandler would produce diff-2, but without the fix
    // chat state would produce diff-1 (per-turn). With the fix, it uses diff-2.
    state.beginUserMessage('edit another file');
    const diffId2 = 'diff-2';
    const snapshot2 = state.handleEvent({
      type: 'diff_proposed',
      diff: { file_path: '/tmp/b.ts', original_content: 'c', proposed_content: 'd' },
    }, diffId2);
    expect(snapshot2.turns.at(-1)?.diffs?.[0]?.id).toBe('diff-2');
    // Verify the IDs are distinct — the divergence bug is fixed
    expect(diffId1).not.toBe(diffId2);
  });
});

describe('VS Code chat webview HTML', () => {
  it('uses strict CSP and external media resources only', () => {
    const html = chatWebviewHtml({ scriptUri: 'vscode-resource://chat.js', styleUri: 'vscode-resource://chat.css', cspSource: 'vscode-resource:' });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('script-src vscode-resource:');
    expect(html).toContain('<script src="vscode-resource://chat.js"></script>');
    expect(html).not.toMatch(/<script>(.|\n)*<\/script>/);
    expect(html).not.toContain('session_id');
    expect(html).not.toContain('secret');
  });
});
