import { describe, expect, it } from 'vitest';

import { getAgentActivity, logCodexRpcActivity } from '../../src/daemon/manager.js';

describe('runtime agent activity log', () => {
  it('records Codex RPC MCP tool activity', () => {
    const agentId = `activity-test-${Date.now()}`;
    const ts = '2026-06-26T00:00:00.000Z';

    logCodexRpcActivity(
      agentId,
      '[codex-rpc] item/started item.type=mcpToolCall server=shizuha-pulse tool=pulse_get_my_tasks status=inProgress',
      ts,
    );
    logCodexRpcActivity(
      agentId,
      '[codex-rpc] item/completed item.type=mcpToolCall server=shizuha-pulse tool=pulse_get_my_tasks status=completed durationMs=123',
      ts,
    );
    logCodexRpcActivity(agentId, '[codex-rpc] turn/completed params_keys=threadId,turn', ts);

    expect(getAgentActivity(agentId, 10)).toEqual([
      {
        ts,
        type: 'tool_start',
        tool: 'pulse_get_my_tasks',
        detail: 'shizuha-pulse:pulse_get_my_tasks',
      },
      {
        ts,
        type: 'tool_complete',
        tool: 'pulse_get_my_tasks',
        detail: 'completed 123ms',
      },
      {
        ts,
        type: 'turn_complete',
        detail: 'Turn completed',
      },
    ]);
  });

  it('records generic Codex item status activity', () => {
    const agentId = `activity-generic-${Date.now()}`;
    const ts = '2026-06-26T00:01:00.000Z';

    logCodexRpcActivity(
      agentId,
      '[codex-rpc] event item.type=mcpToolCall server=shizuha-pulse tool=pulse_get_task status=inProgress',
      ts,
    );
    logCodexRpcActivity(
      agentId,
      '[codex-rpc] event item.type=mcpToolCall server=shizuha-pulse tool=pulse_get_task status=completed durationMs=45',
      ts,
    );
    logCodexRpcActivity(agentId, '[codex-rpc] codex/turn-started thread_id=t1', ts);
    logCodexRpcActivity(agentId, '[codex-rpc] codex/turn-completed thread_id=t1', ts);

    expect(getAgentActivity(agentId, 10)).toEqual([
      {
        ts,
        type: 'tool_start',
        tool: 'pulse_get_task',
        detail: 'shizuha-pulse:pulse_get_task',
      },
      {
        ts,
        type: 'tool_complete',
        tool: 'pulse_get_task',
        detail: 'completed 45ms',
      },
      {
        ts,
        type: 'session_start',
        detail: 'Turn started',
      },
      {
        ts,
        type: 'turn_complete',
        detail: 'Turn completed',
      },
    ]);
  });

  it('records Codex command previews and output deltas', () => {
    const agentId = `activity-command-${Date.now()}`;
    const ts = '2026-06-26T00:02:00.000Z';

    logCodexRpcActivity(
      agentId,
      '[codex-rpc] item/started item.type=commandExecution command="kubectl get pods -A" status=inProgress',
      ts,
    );
    logCodexRpcActivity(
      agentId,
      '[codex-rpc] item/commandExecution/outputDelta item.type=commandExecution output="pod/a Running\\n" stream=stdout',
      ts,
    );
    logCodexRpcActivity(
      agentId,
      '[codex-rpc] item/completed item.type=commandExecution command="kubectl get pods -A" status=completed durationMs=42',
      ts,
    );

    expect(getAgentActivity(agentId, 10)).toEqual([
      {
        ts,
        type: 'tool_start',
        tool: 'commandExecution',
        detail: 'kubectl get pods -A',
      },
      {
        ts,
        type: 'tool_output',
        tool: 'commandExecution',
        detail: 'pod/a Running\n',
        stream: 'stdout',
      },
      {
        ts,
        type: 'tool_complete',
        tool: 'commandExecution',
        detail: 'completed 42ms kubectl get pods -A',
      },
    ]);
  });

});
