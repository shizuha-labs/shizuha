import { describe, expect, it } from 'vitest';
import { resolveAgentGatewayScope } from '../../src/daemon/dashboard.js';

// PLAT-317: restart / restart-if-running / reset-session / toggle were missing
// from the agent-gateway scope map, so they fell through to `null` -> 403, which
// broke the DevOps self-serve seat-recovery ladder (reset_agent_session /
// restart_agent / toggle_agent) after the PLAT-181 roll. They are the same
// control class as pause/resume/kill-task and must resolve to `agents:control`.
describe('resolveAgentGatewayScope', () => {
  it('grants agents:control to the restored agent-management ops (PLAT-317)', () => {
    expect(resolveAgentGatewayScope('POST', '/v1/agents/ryo/restart')).toBe('agents:control');
    expect(resolveAgentGatewayScope('POST', '/v1/agents/ryo/restart-if-running')).toBe('agents:control');
    expect(resolveAgentGatewayScope('POST', '/v1/agents/sora/reset-session')).toBe('agents:control');
    expect(resolveAgentGatewayScope('POST', '/v1/agents/toggle')).toBe('agents:control');
  });

  it('still grants agents:control to the pre-existing control ops (no regression)', () => {
    expect(resolveAgentGatewayScope('POST', '/v1/agents/kai/pause')).toBe('agents:control');
    expect(resolveAgentGatewayScope('POST', '/v1/agents/kai/resume')).toBe('agents:control');
    expect(resolveAgentGatewayScope('POST', '/v1/agents/kai/kill-task')).toBe('agents:control');
  });

  it('keeps list / message scopes', () => {
    expect(resolveAgentGatewayScope('GET', '/v1/agents')).toBe('agents:list');
    expect(resolveAgentGatewayScope('POST', '/v1/agents/ryo/message')).toBe('agents:message');
  });

  it('returns null (-> 403) for anything not explicitly mapped (default-deny)', () => {
    expect(resolveAgentGatewayScope('GET', '/v1/agents/ryo/restart')).toBeNull(); // wrong method
    expect(resolveAgentGatewayScope('POST', '/v1/agents/ryo/delete')).toBeNull();
    expect(resolveAgentGatewayScope('POST', '/v1/secrets')).toBeNull();
    expect(resolveAgentGatewayScope('DELETE', '/v1/agents/ryo/restart')).toBeNull();
  });
});
