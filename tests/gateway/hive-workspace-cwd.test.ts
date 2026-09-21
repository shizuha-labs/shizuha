import { describe, expect, it } from 'vitest';
import { resolveAgentWorkspaceCwd, HIVE_AGENT_WORKSPACE_CWD } from '../../src/gateway/agent-process.js';

describe('resolveAgentWorkspaceCwd', () => {
  it('keeps an explicit --cwd', () => {
    expect(resolveAgentWorkspaceCwd('/tmp/work', { AGENT_ID: 'x' }, () => true)).toBe('/tmp/work');
  });

  it('uses the Hive PVC when the agent id is set and the mount exists', () => {
    expect(resolveAgentWorkspaceCwd(undefined, { AGENT_ID: 'scout' }, (p) => p === HIVE_AGENT_WORKSPACE_CWD))
      .toBe(HIVE_AGENT_WORKSPACE_CWD);
  });

  it('does not hijack a non-Hive process even if the PVC path exists', () => {
    const cwd = resolveAgentWorkspaceCwd(undefined, {}, () => true);
    expect(cwd).toBe(process.cwd());
  });
});
