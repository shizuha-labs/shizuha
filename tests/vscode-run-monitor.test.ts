import { describe, expect, it } from 'vitest';
import { RunMonitorState, formatStructuredError } from '../extensions/vscode/src/run-monitor.js';

describe('VS Code run monitor state', () => {
  it('records lifecycle, tool logs, structured errors, and no prompt text', () => {
    const monitor = new RunMonitorState();
    monitor.beginRun('session-1');
    monitor.handleEvent({ type: 'run_status', status: 'running' });
    monitor.handleEvent({ type: 'tool_call', id: 'tool-1', name: 'search', content: { query_ref: 'attachment-1' } });
    monitor.handleEvent({ type: 'tool_result', id: 'tool-1', name: 'search', content: { count: 2 } });
    const snapshot = monitor.handleEvent({
      type: 'error',
      error: {
        code: 'CORE_TIMEOUT',
        message: 'local core timed out',
        retryable: true,
        details: { route: '/v1/query/stream' },
        request_id: 'req-123',
      },
    });

    expect(snapshot.current).toBeUndefined();
    expect(snapshot.recent[0]).toMatchObject({ status: 'error', sessionId: 'session-1' });
    expect(snapshot.recent[0]?.logs.map((entry) => entry.level)).toEqual(['status', 'status', 'tool', 'tool', 'error']);
    expect(snapshot.recent[0]?.logs.at(-1)).toMatchObject({ request_id: 'req-123' });
    expect(JSON.stringify(snapshot)).not.toContain('sk-');
    expect(JSON.stringify(snapshot)).not.toContain('prompt text');
  });

  it('tracks explicit cancel acknowledgement separately from cancel errors', () => {
    const monitor = new RunMonitorState();
    monitor.beginRun('session-2');
    expect(monitor.markCancellationRequested().current?.status).toBe('cancelling');
    const cancelled = monitor.handleCancelAck('cancel accepted', 'cancel-req', 'cancelled');
    expect(cancelled.current).toBeUndefined();
    expect(cancelled.recent[0]).toMatchObject({ status: 'cancelled', sessionId: 'session-2' });

    const failing = new RunMonitorState();
    failing.beginRun('session-3');
    failing.markCancellationRequested();
    const failed = failing.handleCancelError({ code: 'CANCEL_REJECTED', message: 'not cancellable', retryable: false, request_id: 'req-cancel' });
    expect(failed.recent[0]).toMatchObject({ status: 'error' });
    expect(failed.recent[0]?.error?.code).toBe('CANCEL_REJECTED');
  });

  it('formats structured errors with retryability and request id', () => {
    expect(formatStructuredError({ code: 'X', message: 'bad', retryable: false, request_id: 'r1' })).toBe('X — bad — not retryable — request r1');
  });
});
