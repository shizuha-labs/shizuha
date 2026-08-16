import { describe, it, expect } from 'vitest';
import type {
  ScreenMode,
  TranscriptEntry,
  ToolCallEntry,
  ApprovalRequest,
  SessionSummary,
  TUIState,
} from '../../src/tui/state/types.js';
import type { ReasoningEvent } from '../../src/events/types.js';

describe('TUI state types', () => {
  it('ScreenMode accepts valid values including pager', () => {
    const modes: ScreenMode[] = ['prompt', 'approval', 'sessions', 'help', 'pager'];
    expect(modes).toHaveLength(5);
  });

  it('TranscriptEntry user message shape', () => {
    const entry: TranscriptEntry = {
      id: 'user-123',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    };
    expect(entry.role).toBe('user');
    expect(entry.toolCalls).toBeUndefined();
    expect(entry.isStreaming).toBeUndefined();
    expect(entry.reasoningSummaries).toBeUndefined();
  });

  it('TranscriptEntry assistant message with tools', () => {
    const tool: ToolCallEntry = {
      id: 'tc-1',
      name: 'bash',
      input: { command: 'ls' },
      result: 'file1.txt\nfile2.txt',
      isError: false,
      durationMs: 150,
      status: 'complete',
    };

    const entry: TranscriptEntry = {
      id: 'assistant-456',
      role: 'assistant',
      content: 'Let me check the files.',
      timestamp: Date.now(),
      toolCalls: [tool],
      isStreaming: false,
    };
    expect(entry.toolCalls).toHaveLength(1);
    expect(entry.toolCalls![0]!.name).toBe('bash');
  });

  it('TranscriptEntry with reasoning summaries', () => {
    const entry: TranscriptEntry = {
      id: 'assistant-789',
      role: 'assistant',
      content: 'Here is my analysis.',
      timestamp: Date.now(),
      isStreaming: false,
      reasoningSummaries: ['Analyzing the code structure', 'Found potential issue in auth module'],
    };
    expect(entry.reasoningSummaries).toHaveLength(2);
    expect(entry.reasoningSummaries![0]).toContain('Analyzing');
  });

  it('ToolCallEntry running state', () => {
    const entry: ToolCallEntry = {
      id: 'tc-2',
      name: 'read',
      input: { file_path: '/tmp/test.ts' },
      status: 'running',
    };
    expect(entry.status).toBe('running');
    expect(entry.result).toBeUndefined();
  });

  it('ApprovalRequest shape', () => {
    const resolver = (_: 'allow' | 'deny' | 'allow_always') => {};
    const request: ApprovalRequest = {
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      riskLevel: 'high',
      resolve: resolver,
    };
    expect(request.riskLevel).toBe('high');
    expect(typeof request.resolve).toBe('function');
  });

  it('SessionSummary shape', () => {
    const summary: SessionSummary = {
      id: 'uuid-here',
      model: 'codex-mini-latest',
      cwd: '/home/test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
    };
    expect(summary.turnCount).toBe(5);
  });

  it('SessionSummary with name and firstMessage', () => {
    const summary: SessionSummary = {
      id: 'uuid-here',
      model: 'codex-mini-latest',
      cwd: '/home/test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      name: 'My Feature Session',
      firstMessage: 'Help me implement dark mode',
    };
    expect(summary.name).toBe('My Feature Session');
    expect(summary.firstMessage).toBe('Help me implement dark mode');
  });

  it('SessionSummary without optional fields', () => {
    const summary: SessionSummary = {
      id: 'uuid-here',
      model: 'codex-mini-latest',
      cwd: '/home/test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    expect(summary.name).toBeUndefined();
    expect(summary.firstMessage).toBeUndefined();
  });

  it('TUIState shape', () => {
    const state: TUIState = {
      screen: 'prompt',
      model: 'test-model',
      mode: 'supervised',
      sessionId: null,
      transcript: [],
      isProcessing: false,
      pendingApproval: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      startTime: Date.now(),
      error: null,
    };
    expect(state.screen).toBe('prompt');
    expect(state.isProcessing).toBe(false);
  });

  it('ReasoningEvent shape', () => {
    const event: ReasoningEvent = {
      type: 'reasoning',
      summaries: ['thinking about the problem', 'identified root cause'],
      timestamp: Date.now(),
    };
    expect(event.type).toBe('reasoning');
    expect(event.summaries).toHaveLength(2);
  });
});

describe('Approval queue behavior', () => {
  it('multiple requests can be queued', () => {
    const queue: ApprovalRequest[] = [];
    const resolvers: Array<(d: 'allow' | 'deny' | 'allow_always') => void> = [];

    // Simulate 3 permission requests
    for (let i = 0; i < 3; i++) {
      queue.push({
        toolName: `tool-${i}`,
        input: { idx: i },
        riskLevel: 'medium',
        resolve: (d) => resolvers.push(() => d),
      });
    }

    expect(queue).toHaveLength(3);
    expect(queue[0]!.toolName).toBe('tool-0');

    // Resolve first — shifts queue
    queue[0]!.resolve('allow');
    queue.shift();
    expect(queue).toHaveLength(2);
    expect(queue[0]!.toolName).toBe('tool-1');
  });
});
