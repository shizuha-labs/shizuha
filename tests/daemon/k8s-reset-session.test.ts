import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentInfo } from '../../src/daemon/types.js';

function agent(username = 'saki'): AgentInfo {
  return {
    id: '4b7af2d5-0af5-5a58-b074-c3fca115b6db',
    name: username,
    username,
    email: `${username}@shizuha.com`,
    role: 'agent',
    status: 'running',
    runtimeEnvironment: 'k8s',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
  };
}

describe('k8s PVC session reset', () => {
  let tmp: string;
  let oldPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kubectl-reset-'));
    oldPath = process.env['PATH'];
    process.env['PATH'] = `${tmp}:${oldPath ?? ''}`;
    process.env['KUBECTL_BIN'] = path.join(tmp, 'kubectl');
    process.env['SHIZUHA_FLEET_NAMESPACE'] = 'test-fleet';
  });

  afterEach(() => {
    process.env['PATH'] = oldPath;
    delete process.env['KUBECTL_BIN'];
    delete process.env['SHIZUHA_FLEET_NAMESPACE'];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('execs a PVC wipe then force-deletes the pod (no host workspace)', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == *exec*deployment/agent-saki* ]]; then
  echo '{"session_id":"agent-session-4b7af2d5-0af5-5a58-b074-c3fca115b6db","archived":["/home/agent/.shizuha/archived-sessions/x.db"],"deleted":{"messages":1115,"session_wire_prefix":1}}'
  exit 0
fi
if [[ "$*" == *delete*pod*agent-saki* ]]; then
  exit 0
fi
if [[ "$*" == *rollout*status*deployment/agent-saki* ]]; then
  exit 0
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { resetK8sAgentRuntimeSession } = await import('../../src/daemon/k8s-backend.js');
    const result = await resetK8sAgentRuntimeSession(agent('saki'), 5_000);
    expect(result.ok).toBe(true);
    expect(result.archived).toEqual(['/home/agent/.shizuha/archived-sessions/x.db']);
    expect(result.deleted?.['session_wire_prefix']).toBe(1);

    const calls = fs.readFileSync(logPath, 'utf-8');
    expect(calls).toContain('exec -n test-fleet deployment/agent-saki -c agent -- sh -c');
    expect(calls).toContain('session_wire_prefix');
    expect(calls).toContain('4b7af2d5-0af5-5a58-b074-c3fca115b6db');
    expect(calls).toMatch(/delete pod -n test-fleet -l app=agent-saki --force --grace-period=0/);
    expect(calls).toContain('rollout status -n test-fleet deployment/agent-saki');
  });
});
