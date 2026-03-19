import { describe, expect, it } from 'vitest';
import { ClaudeBridge } from '../../src/claude-bridge/index.js';

describe('ClaudeBridge', () => {
  it('does not emit a duplicate message_ack when Claude sends its system init line', () => {
    const bridge = new ClaudeBridge({
      port: 0,
      host: '127.0.0.1',
      model: 'claude-sonnet-4-6',
      agentId: 'agent-test',
      cwd: '/tmp',
    }) as any;

    const sent: Array<Record<string, unknown>> = [];
    const fakeWs = {
      readyState: 1,
      send(payload: string) {
        sent.push(JSON.parse(payload));
      },
    };

    bridge.clients.set('client-1', {
      ws: fakeWs,
      userId: 'user-1',
      activeThreadId: null,
    });
    bridge.claudeProcess = {
      stdin: {
        writable: true,
        write() {},
      },
    };

    bridge.startClaudeExecution('client-1', 'hello');
    expect(sent.filter((msg) => msg.type === 'message_ack')).toHaveLength(1);
    expect(sent.filter((msg) => msg.type === 'session_start')).toHaveLength(1);

    bridge.handleStdoutChunk(Buffer.from('{"type":"system","session_id":"claude-real-session"}\n'));

    expect(sent.filter((msg) => msg.type === 'message_ack')).toHaveLength(1);
    expect(bridge.claudeSessionId).toBe('claude-real-session');
  });
});
