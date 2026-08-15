import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { AgentInfo } from '../../src/daemon/types.js';

function agent(username = 'hana'): AgentInfo {
  return {
    id: `agent-${username}-id`,
    name: username,
    username,
    email: `${username}@shizuha.com`,
    role: 'agent',
    status: 'disabled',
    runtimeEnvironment: 'k8s',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
  };
}

function agentWithGithub(username = 'hana'): AgentInfo {
  return {
    ...agent(username),
    credentials: [{
      id: `${username}-github`,
      scope: 'github',
      service: 'github',
      label: 'GitHub API',
      credentialData: { token: 'ghp_test_token' },
      envMapping: { token: 'GITHUB_TOKEN' },
      injectAsEnv: true,
      isActive: true,
    }],
  };
}

function agentWithGithubButNoToken(username = 'hana'): AgentInfo {
  return {
    ...agent(username),
    credentials: [{
      id: `${username}-github`,
      scope: 'github',
      service: 'github',
      label: 'GitHub API',
      credentialData: { token: '' },
      envMapping: { token: 'GITHUB_TOKEN' },
      injectAsEnv: true,
      isActive: true,
    }],
  };
}

describe('k8s backend stop path', () => {
  let tmp: string;
  let oldPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kubectl-'));
    oldPath = process.env['PATH'];
    process.env['PATH'] = `${tmp}:${oldPath ?? ''}`;
    process.env['KUBECTL_BIN'] = path.join(tmp, 'kubectl');
    process.env['SHIZUHA_FLEET_NAMESPACE'] = 'test-fleet';
  });

  afterEach(() => {
    process.env['PATH'] = oldPath;
    delete process.env['KUBECTL_BIN'];
    delete process.env['SHIZUHA_FLEET_NAMESPACE'];
    delete process.env['SHIZUHA_GITHUB_AUTH_PROBE_TIMEOUT_MS'];
    delete process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'];
    delete process.env['SHIZUHA_GITHUB_AUTH_PROBE_RETRY_DELAY_MS'];
    delete process.env['SHIZUHA_FLEET_WORKSPACE_SIZE'];
    delete process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'];
    delete process.env['SHIZUHA_BROKER_IMAGE'];
    delete process.env['SHIZUHA_HIVE_RUNTIME_IMAGE_URL'];
    delete process.env['SHIZUHA_DESIRED_RUNTIME_RELEASE_PATH'];
    delete process.env['SHIZUHA_AGENT_RUNTIME_RELEASE_GENERATION'];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scales deployment/agent-<username> to zero and verifies replicas/ready/available are 0', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-hana -o json" ]]; then
  printf '{"spec":{"replicas":0},"status":{"readyReplicas":0,"availableReplicas":0}}'
  exit 0
fi
if [[ "$*" == "scale -n test-fleet deployment/agent-hana --replicas=0" ]]; then
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { stopAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    stopAgentK8s(agent('hana'), 1_000);

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toContain('scale -n test-fleet deployment/agent-hana --replicas=0');
    expect(calls.filter((c) => c === 'get -n test-fleet deployment/agent-hana -o json').length).toBeGreaterThanOrEqual(2);
  });

  it('restores an existing stopped deployment without rewriting its pod template', async () => {
    const logPath = path.join(tmp, 'kubectl-restore.log');
    const markerPath = path.join(tmp, 'restored');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-hana -o json" ]]; then
  if [[ -f ${JSON.stringify(markerPath)} ]]; then
    printf '{"spec":{"replicas":1},"status":{"readyReplicas":0,"availableReplicas":0}}'
  else
    printf '{"spec":{"replicas":0},"status":{"readyReplicas":0,"availableReplicas":0}}'
  fi
  exit 0
fi
if [[ "$*" == "scale -n test-fleet deployment/agent-hana --replicas=1" ]]; then
  touch ${JSON.stringify(markerPath)}
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { restoreAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    restoreAgentK8s(agent('hana'), 1_000);

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toContain('scale -n test-fleet deployment/agent-hana --replicas=1');
    expect(calls.some((call) => call.includes('apply'))).toBe(false);
  });

  it('stages current runtime images on a stopped Deployment without changing replicas', async () => {
    const logPath = path.join(tmp, 'kubectl-stage.log');
    const markerPath = path.join(tmp, 'staged');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-hana -o json" ]]; then
  if [[ -f ${JSON.stringify(markerPath)} ]]; then

    printf '%s' '{"metadata":{"annotations":{"shizuha.io/runtime-spec-revision":"inline-failover-v6-privileged-kubeconfig-v1"}},"spec":{"replicas":0,"template":{"spec":{"containers":[{"name":"agent","image":"registry/runtime:new"},{"name":"broker","image":"registry/broker:new"}],"initContainers":[{"name":"workspace-permissions","image":"registry/runtime:new"}]}}},"status":{}}'

  else
    printf '%s' '{"metadata":{"annotations":{"shizuha.io/runtime-spec-revision":"old"}},"spec":{"replicas":0,"template":{"spec":{"containers":[{"name":"agent","image":"registry/runtime:old"},{"name":"broker","image":"registry/broker:old"}]}}},"status":{}}'
  fi
  exit 0
fi
case "$*" in
  "patch -n test-fleet deployment/agent-hana --type=strategic -p "*)
    touch ${JSON.stringify(markerPath)}
    exit 0
    ;;
esac
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { stageStoppedAgentK8sRuntime } = await import('../../src/daemon/k8s-backend.js');
    const desiredAgent = agent('hana');
    desiredAgent.model = 'gpt-5.6-sol';
    desiredAgent.executionMethod = 'codex_app_server';
    desiredAgent.modelOverrides = {
      codex_app_server: 'gpt-5.6-sol',
      codex_app_server_reasoning_effort: 'high',
    };
    stageStoppedAgentK8sRuntime(desiredAgent, 'registry/runtime:new', 'registry/broker:new');

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const patchCall = calls.find((call) => call.startsWith(
      'patch -n test-fleet deployment/agent-hana --type=strategic -p ',
    ));
    expect(patchCall).toContain('registry/runtime:new');
    expect(patchCall).toContain('registry/broker:new');
    expect(patchCall).not.toContain('"replicas"');
    const patch = JSON.parse(patchCall!.slice(patchCall!.indexOf(' -p ') + 4)) as {
      metadata: { annotations: Record<string, string> };
      spec: { template: { spec: { containers: Array<{ name: string; command?: string[]; args?: string[]; env?: Array<{ name: string; value: string }>; resources?: { limits: { memory: string } } }> } } };
    };
    expect(patch.metadata.annotations).toMatchObject({
      'shizuha.io/model-policy': 'hive-sot-v1',
      'shizuha.io/primary-model': 'gpt-5.6-sol',
      'shizuha.io/execution-method': 'codex_app_server',
      'shizuha.io/reasoning-effort': 'high',
    });
    expect(patch.spec.template.spec.containers.find((container) => container.name === 'agent')?.env)
      .toEqual(expect.arrayContaining([
        { name: 'APT_CACHE_URL', value: 'http://apt-cache.registry.svc.cluster.local:3142' },
        { name: 'MODEL', value: 'gpt-5.6-sol' },
        { name: 'REASONING_EFFORT', value: 'high' },
        { name: 'MODEL_FALLBACKS', value: '[]' },
      ]));
    // Raised 2026-08-05: pods already had more RAM than Node would use, so the
    // limits went up together with the rendered NODE_OPTIONS heap ceiling.
    expect(patch.spec.template.spec.containers.find((container) => container.name === 'agent')?.resources)
      .toMatchObject({ limits: { memory: '12Gi' } });
    expect(patch.spec.template.spec.containers.find((container) => container.name === 'agent')?.command)
      .toEqual(['bash', '-lc']);
    expect(patch.spec.template.spec.containers.find((container) => container.name === 'agent')?.args?.[0])
      .toContain('[ "$runtime_command" = "codex-bridge" ] && { [ "$code" -eq 1 ] || [ "$code" -eq 43 ]; }');
    expect((patch.spec.template.spec as any).initContainers).toContainEqual({
      name: 'workspace-permissions',
      image: 'registry/runtime:new',
    });
    expect(calls.filter((call) => call === 'get -n test-fleet deployment/agent-hana -o json'))
      .toHaveLength(2);
  });

  it('uses Hive only for the broker target, never as runtime-image rollout intent', async () => {
    const targetPath = path.join(tmp, 'runtime-target.json');
    fs.writeFileSync(targetPath, JSON.stringify({
      image: 'registry/shizuha-agent-runtime:desired',
      broker_image: 'registry/mcp-auth-proxy:verified',
    }));
    process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'] = 'registry/shizuha-agent-runtime:bootstrap-old';
    process.env['SHIZUHA_BROKER_IMAGE'] = 'registry/mcp-auth-proxy:bootstrap-old';
    process.env['SHIZUHA_HIVE_RUNTIME_IMAGE_URL'] = `file://${targetPath}`;
    vi.resetModules();
    const {
      desiredBrokerImage,
      refreshHiveDesiredImage,
    } = await import('../../src/daemon/k8s-backend.js');

    await refreshHiveDesiredImage();

    expect(desiredBrokerImage()).toBe('registry/mcp-auth-proxy:verified');
  });

  it('rolls a running runtime template without reprovisioning unrelated credentials', async () => {
    const logPath = path.join(tmp, 'kubectl-running-roll.log');
    const markerPath = path.join(tmp, 'running-rolled');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-mio -o json" ]]; then
  image=registry/runtime:old
  revision=old

  [[ -f ${JSON.stringify(markerPath)} ]] && image=registry/runtime:new && revision=inline-failover-v6-privileged-kubeconfig-v1

    printf '{"metadata":{"annotations":{"shizuha.io/runtime-spec-revision":"%s"}},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","image":"%s"},{"name":"broker","image":"registry/broker:new"}],"initContainers":[{"name":"workspace-permissions","image":"%s"}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}' "$revision" "$image" "$image"
  exit 0
fi
case "$*" in
  "patch -n test-fleet deployment/agent-mio --type=strategic -p "*)
    touch ${JSON.stringify(markerPath)}
    exit 0
    ;;
esac
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { rollRunningAgentK8sRuntime } = await import('../../src/daemon/k8s-backend.js');
    const desiredAgent = agent('mio');
    desiredAgent.executionMethod = 'codex_app_server';
    rollRunningAgentK8sRuntime(desiredAgent, 'registry/runtime:new', 'registry/broker:new');

    const patchCall = fs.readFileSync(logPath, 'utf-8').trim().split('\n')
      .find((call) => call.startsWith('patch -n test-fleet deployment/agent-mio --type=strategic -p '));
    expect(patchCall).toContain('registry/runtime:new');
    expect(patchCall).toContain('"memory":"12Gi"');
    const patch = JSON.parse(patchCall!.slice(patchCall!.indexOf(' -p ') + 4)) as {
      spec: { template: { spec: { containers: Array<{ name: string; args?: string[]; env?: Array<{ name: string; value: string }> }> } } };
    };
    const agentContainer = patch.spec.template.spec.containers
      .find((container) => container.name === 'agent');
    const supervisor = agentContainer?.args?.[0];
    expect(supervisor).toContain('codex-bridge');
    expect(supervisor).toContain('[ "$code" -eq 1 ] || [ "$code" -eq 43 ]');
    expect(agentContainer?.env).toContainEqual({
      name: 'APT_CACHE_URL',
      value: 'http://apt-cache.registry.svc.cluster.local:3142',
    });
    expect(patchCall).not.toContain('"replicas"');
    expect(patchCall).not.toContain('fleet-ssh');
  });

  it('restarts only the selected k8s agent Deployment and waits for convergence', async () => {
    const logPath = path.join(tmp, 'kubectl-restart.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-hiro -o json" ]]; then
  printf '{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
  exit 0
fi
if [[ "$*" == "rollout restart -n test-fleet deployment/agent-hiro" ]]; then
  exit 0
fi
if [[ "$*" == "rollout status -n test-fleet deployment/agent-hiro --timeout=30s" ]]; then
  exit 0
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { restartAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    await restartAgentK8s(agent('hiro'), 30_000);

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toEqual([
      'get -n test-fleet deployment/agent-hiro -o json',
      'rollout restart -n test-fleet deployment/agent-hiro',
      'rollout status -n test-fleet deployment/agent-hiro --timeout=30s',
    ]);
    expect(calls.some((call) => call.includes('agent-hana'))).toBe(false);
  });

  it('does not report restart success when rollout status fails', async () => {
    const logPath = path.join(tmp, 'kubectl-restart-fail.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-hiro -o json" ]]; then
  printf '{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
  exit 0
fi
if [[ "$*" == "rollout restart -n test-fleet deployment/agent-hiro" ]]; then
  exit 0
fi
if [[ "$*" == "rollout status -n test-fleet deployment/agent-hiro --timeout=30s" ]]; then
  echo "error: timed out waiting for the condition" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { restartAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    await expect(restartAgentK8s(agent('hiro'), 30_000)).rejects.toThrow(/rollout status|timed out|Command failed|exit/i);
    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toContain('rollout restart -n test-fleet deployment/agent-hiro');
    expect(calls).toContain('rollout status -n test-fleet deployment/agent-hiro --timeout=30s');
  });

  it('keeps the event loop responsive while the Deployment preflight is pending', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployment/agent-hiro -o json" ]]; then
  sleep 0.35
  printf '{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
  exit 0
fi
if [[ "$*" == "rollout restart -n test-fleet deployment/agent-hiro" ||
      "$*" == "rollout status -n test-fleet deployment/agent-hiro --timeout=30s" ]]; then
  exit 0
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { restartAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    let completed = false;
    const restart = restartAgentK8s(agent('hiro'), 30_000).then(() => { completed = true; });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);
    await restart;
    expect(completed).toBe(true);
  });

  it('returns HTTP 502 without a success body or broadcast when k8s rollout fails', async () => {
    const { registerAgentRestartRoute } = await import('../../src/daemon/dashboard.js');
    const app = Fastify();
    const restartAgent = vi.fn().mockRejectedValue(new Error('rollout status timed out'));
    const broadcastAgentUpdate = vi.fn();
    registerAgentRestartRoute(app, {
      agents: [agent('hiro')],
      restartAgent,
      isAgentRunning: vi.fn(() => true),
      enableAndStartAgent: vi.fn(),
      broadcastAgentUpdate,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/agent-hiro-id/restart',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'rollout status timed out' });
    expect(response.body).not.toContain('restarted');
    expect(broadcastAgentUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('permanently deletes a k3s agent workload, workspace, and credentials', async () => {
    const logPath = path.join(tmp, 'kubectl-delete.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "delete -n test-fleet deployment/agent-hana service/agent-hana persistentvolumeclaim/hana-workspace secret/hana-agent-creds --ignore-not-found=true --wait=true" ]]; then
  exit 0
fi
if [[ "$*" == "get -n test-fleet deployment/agent-hana -o json" ]]; then
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { deleteAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    deleteAgentK8s(agent('hana'));

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toContain(
      'delete -n test-fleet deployment/agent-hana service/agent-hana persistentvolumeclaim/hana-workspace secret/hana-agent-creds --ignore-not-found=true --wait=true',
    );
  });

  it('renders an existing Deployment selector during spawn so legacy k3s objects are adoptable', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const manifestPath = path.join(tmp, 'manifest.yaml');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-haru -o json" ]]; then
  printf '{"spec":{"selector":{"matchLabels":{"shizuha.io/agent":"haru"}}}}'
  exit 0
fi
if [[ "$*" == "apply --dry-run=client -n test-fleet -f -" ]]; then
  cat > /dev/null
  exit 0
fi
if [[ "$*" == "apply -n test-fleet -f -" ]]; then
  cat > ${JSON.stringify(manifestPath)}
  exit 0
fi
if [[ "$*" == "get clusterrolebinding/agent-haru-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet serviceaccount/agent-haru-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet secret/haru-fleet-ssh --ignore-not-found=true -o json" ]]; then
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(agent('haru'), {
      command: 'codex-bridge',
      model: 'gpt-5.5',
      contextPrompt: 'ctx',
      password: 'pw',
    });

    const manifest = fs.readFileSync(manifestPath, 'utf-8');
    expect(manifest).toContain('selector: { matchLabels: { shizuha.io/agent: "haru" } }');
    expect(manifest).toContain('labels: { shizuha.io/agent: "haru", shizuha.io/runtime: "k3s-native" }');
    expect(manifest).toContain('CONTEXT_PROMPT: "ctx"');
    expect(manifest).toContain('secretName: haru-agent-creds');
    expect(manifest).toContain('defaultMode: 0400');
    expect(manifest).toContain('securityContext: { fsGroup: 1000, fsGroupChangePolicy: OnRootMismatch }');
    expect(manifest).toContain('name: agent-creds, mountPath: /run/shizuha/agent-creds, readOnly: true');
    expect(manifest).toContain('mountPath: /run/shizuha/agent-context');
    expect(manifest).toContain('--context-prompt-file /run/shizuha/agent-context/CONTEXT_PROMPT');
    expect(manifest).toContain('command: ["bash","-lc"]');
    expect(manifest).toContain('k8s-inline-failover step=');
    expect(manifest).toContain('/usr/bin/tini -s -- "/usr/local/bin/agent-runtime-entrypoint.sh"');
    expect(manifest).not.toContain('--context-prompt "$(cat /run/shizuha/agent-context/CONTEXT_PROMPT)"');
    expect(manifest).not.toContain('name: CONTEXT_PROMPT, value:');
    expect(manifest).not.toContain('nodeSelector:');
    expect(manifest).toContain('tolerations: []');
    expect(manifest).not.toContain('selector: { matchLabels: { app: "agent-haru" } }');
  });

  // ---- PLAT-5075 (PLAT-5041 Phase A) -------------------------------------
  //
  // Containment: a NEW agent Deployment must be born selecting on the canonical
  // `shizuha.io/agent=<username>`, while every EXISTING Deployment's immutable
  // selector and pod template are left exactly as they are.
  //
  // All four drive the live caller order
  //   spawnAgentK8s -> deploymentSelectorLabels -> renderAgentManifest
  // rather than calling renderAgentManifest with a hand-built selector, because
  // the behaviour under test is which selector deploymentSelectorLabels
  // CHOOSES. Supplying it directly would assert the renderer and skip the
  // decision -- the fixture would pass with the fallback unchanged.

  // `getFailure: 'transient'` makes the selector probe fail for a reason that is
  // NOT not-found (an RBAC denial). Absence is emitted as kubectl's REAL
  // NotFound stderr rather than a bare `exit 1`, because the production code
  // now discriminates on it -- a bare non-zero exit is indistinguishable from
  // an API-server blip and must NOT be read as "absent".
  function selectorProbeKubectl(
    tmpDir: string,
    username: string,
    existing: string | null,
    getFailure?: 'transient',
  ) {
    const logPath = path.join(tmpDir, 'kubectl.log');
    const manifestPath = path.join(tmpDir, 'manifest.yaml');
    const kubectl = path.join(tmpDir, 'kubectl');
    const getBranch = getFailure === 'transient'
      ? `  echo 'Error from server (Forbidden): deployments.apps "agent-${username}" is forbidden: User "system:serviceaccount:shizuha:daemon" cannot get resource "deployments" in API group "apps"' >&2\n  exit 1`
      : existing === null
        ? `  echo 'Error from server (NotFound): deployments.apps "agent-${username}" not found' >&2\n  exit 1`
        : `  printf '%s' ${JSON.stringify(existing)}\n  exit 0`;
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-${username} -o json" ]]; then
${getBranch}
fi
if [[ "$*" == "apply --dry-run=client -n test-fleet -f -" ]]; then
  cat > /dev/null
  exit 0
fi
if [[ "$*" == "apply -n test-fleet -f -" ]]; then
  cat > ${JSON.stringify(manifestPath)}
  exit 0
fi
if [[ "$*" == "get clusterrolebinding/agent-${username}-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet serviceaccount/agent-${username}-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet secret/${username}-fleet-ssh --ignore-not-found=true -o json" ]]; then
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);
    return manifestPath;
  }

  async function spawnAndRead(tmpDir: string, username: string, existing: string | null) {
    const manifestPath = selectorProbeKubectl(tmpDir, username, existing);
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(agent(username), {
      command: 'codex-bridge', model: 'gpt-5.5', contextPrompt: 'ctx', password: 'pw',
    });
    return fs.readFileSync(manifestPath, 'utf-8');
  }

  it('PLAT-5075 1/4: a NEW Deployment is born with the canonical shizuha.io/agent selector AND pod label', async () => {
    const manifest = await spawnAndRead(tmp, 'newbie', null);
    // Selector and pod template must BOTH carry it: a Deployment whose selector
    // has the label but whose pods do not never becomes Ready.
    expect(manifest).toContain('selector: { matchLabels: { shizuha.io/agent: "newbie" } }');
    expect(manifest).toContain('labels: { shizuha.io/agent: "newbie", shizuha.io/runtime: "k3s-native" }');
    // And it must not be born into the unpoliced Shape-B set PLAT-5041 tracks.
    expect(manifest).not.toContain('selector: { matchLabels: { app: "agent-newbie" } }');
  });

  it('PLAT-5075 2/4: an existing Shape A Deployment keeps its immutable selector', async () => {
    const manifest = await spawnAndRead(
      tmp, 'shapea',
      '{"spec":{"selector":{"matchLabels":{"shizuha.io/agent":"shapea"}}}}',
    );
    expect(manifest).toContain('selector: { matchLabels: { shizuha.io/agent: "shapea" } }');
  });

  it('PLAT-5075 3/4: an existing Shape B Deployment STAYS Shape B in Phase A', async () => {
    // `.spec.selector` is immutable in k8s, so rewriting it would make the
    // apply fail; and adding the policy label to an existing Shape-B pod
    // template would roll every one of those agents, which Phase A forbids.
    const manifest = await spawnAndRead(
      tmp, 'shapeb',
      '{"spec":{"selector":{"matchLabels":{"app":"agent-shapeb"}}}}',
    );
    expect(manifest).toContain('selector: { matchLabels: { app: "agent-shapeb" } }');
    expect(manifest).toContain('labels: { app: "agent-shapeb", shizuha.io/runtime: "k3s-native" }');
    expect(manifest).not.toContain('shizuha.io/agent: "shapeb"');
  });

  it('PLAT-5075 4/4 NEGATIVE CONTROL: 1/4 rejects a deliberately unlabelled new render', async () => {
    // Without this, 1/4 could pass against assertions too loose to notice the
    // label's absence. Render with the pre-PLAT-5075 Shape-B selector and
    // assert 1/4's exact expectations FAIL against it -- that is what makes
    // 1/4 load-bearing rather than merely green.
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const unlabelled = renderAgentManifest(
      agent('newbie'),
      { command: 'codex-bridge', model: 'gpt-5.5', contextPrompt: 'ctx', password: 'pw' },
      { app: 'agent-newbie' },
    );
    expect(unlabelled).not.toContain('selector: { matchLabels: { shizuha.io/agent: "newbie" } }');
    expect(unlabelled).not.toContain('labels: { shizuha.io/agent: "newbie", shizuha.io/runtime: "k3s-native" }');
    expect(unlabelled).toContain('selector: { matchLabels: { app: "agent-newbie" } }');
  });

  it('PLAT-5075 5/5: a NON-NotFound get failure against an existing Shape B aborts instead of re-selecting', async () => {
    // @reika review P2. `kubectl()` is execFileSync: it throws on ANY non-zero
    // exit. Before this change the fallback was Shape B -- the selector such a
    // Deployment ALREADY has -- so a transient read failure re-rendered what
    // was there and the apply was a harmless no-op. Making the fallback Shape A
    // changed what that catch COSTS: the same blip would now render a DIFFERENT
    // `.spec.selector` on an existing object, and that field is immutable.
    //
    // So the containment must not widen into a rewrite on the failure path.
    const manifestPath = selectorProbeKubectl(
      tmp, 'shapebrbac',
      '{"spec":{"selector":{"matchLabels":{"app":"agent-shapebrbac"}}}}',
      'transient',
    );
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    expect(() => spawnAgentK8s(agent('shapebrbac'), {
      command: 'codex-bridge', model: 'gpt-5.5', contextPrompt: 'ctx', password: 'pw',
    })).toThrow();
    // The load-bearing half: nothing was applied at all. Asserting only "it
    // threw" would still pass if it had rendered a Shape-A selector first and
    // failed later for an unrelated reason.
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('PLAT-5699 projects QA team Secrets only from a fresh trusted Hive grant', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const trusted: AgentInfo = {
      ...agent('mika'),
      effectiveCapabilities: {
        source: 'hive', capabilities: ['qa'], skills: [], eagerSkills: [], mcpServers: [],
        sourceTeams: ['qa'], credentialGrantScopes: [], credentialCustomGrantServices: [],
        sourceTeamMemberships: [{ organizationSlug: 'shizuha', teamSlug: 'qa' }],
        teamCredentialEligibleTeams: ['qa'],
        teamCredentialEligibleMemberships: [{ organizationSlug: 'shizuha', teamSlug: 'qa' }],
        credentialMaterializations: [
          { grantId: 'qa-user', scope: 'team', organizationSlug: 'shizuha', teamSlug: 'qa', provider: 'generic-env', purpose: 'QA_ISOLATION_A_USERNAME', secretRef: 'k8s-secret://test-fleet/qa-isolation-fixtures#QA_ISOLATION_A_USERNAME', isActive: true },
          { grantId: 'qa-pass', scope: 'team', organizationSlug: 'shizuha', teamSlug: 'qa', provider: 'generic-env', purpose: 'QA_ISOLATION_A_PASSWORD', secretRef: 'k8s-secret://test-fleet/qa-isolation-fixtures#QA_ISOLATION_A_PASSWORD', isActive: true },
          { grantId: 'qa-cleanup', scope: 'team', organizationSlug: 'shizuha', teamSlug: 'qa', provider: 'generic-env', purpose: 'OPEN_WEBUI_QA_CLEANUP_TOKEN', secretRef: 'k8s-secret://test-fleet/qa-isolation-fixtures#OPEN_WEBUI_QA_CLEANUP_TOKEN', isActive: true },
        ],
        runtimeFlags: {}, diagnostics: [], appliedAt: '2026-08-02T00:00:00Z',
        signatureVerified: true, trustedForSensitive: true, stale: false,
      },
    };
    const manifest = renderAgentManifest(trusted, {
      command: 'codex-bridge', model: 'gpt-5.6-sol', contextPrompt: 'ctx', password: 'pw',
    });

    expect(manifest).toContain('name: team-secret-qa-isolation-fixtures');
    expect(manifest).toContain('secretName: "qa-isolation-fixtures", optional: true, defaultMode: 0400');
    expect(manifest).toContain('mountPath: /run/shizuha/team-creds/qa-isolation-fixtures, readOnly: true');
    expect(manifest).toContain('name: QA_ISOLATION_A_PASSWORD_FILE, value: "/run/shizuha/team-creds/qa-isolation-fixtures/QA_ISOLATION_A_PASSWORD"');
    expect(manifest).toContain('name: OPEN_WEBUI_QA_CLEANUP_TOKEN_FILE, value: "/run/shizuha/team-creds/qa-isolation-fixtures/OPEN_WEBUI_QA_CLEANUP_TOKEN"');
    expect(manifest).not.toContain('name: QA_ISOLATION_A_PASSWORD, value:');

    const unsigned = renderAgentManifest({
      ...trusted,
      username: 'unsigned-qa',
      id: 'unsigned-qa-id',
      effectiveCapabilities: { ...trusted.effectiveCapabilities!, signatureVerified: false, trustedForSensitive: false },
    }, {
      command: 'codex-bridge', model: 'gpt-5.6-sol', contextPrompt: 'ctx', password: 'pw',
    });
    expect(unsigned).not.toContain('team-secret-qa-isolation-fixtures');
    expect(unsigned).not.toContain('QA_ISOLATION_A_PASSWORD_FILE');
  });

  it('PLAT-5699 validates team Secret bindings and rolls only bound agents', async () => {
    const {
      computeAgentMcpConfigHash,
      k8sTeamSecretBindingsForAgent,
      renderAgentManifest,
    } = await import('../../src/daemon/k8s-backend.js');

    const trustedQa: AgentInfo = {
      ...agent('mika'),
      effectiveCapabilities: {
        source: 'hive', capabilities: ['qa'], skills: [], eagerSkills: [], mcpServers: [],
        sourceTeams: ['qa', 'review'], credentialGrantScopes: [], credentialCustomGrantServices: [],
        sourceTeamMemberships: [
          { organizationSlug: 'shizuha', teamSlug: 'qa' },
          { organizationSlug: 'shizuha', teamSlug: 'review' },
        ],
        teamCredentialEligibleTeams: ['qa'],
        teamCredentialEligibleMemberships: [{ organizationSlug: 'shizuha', teamSlug: 'qa' }],
        credentialMaterializations: [
          {
            grantId: 'qa-pass', scope: 'team', organizationSlug: 'shizuha', teamSlug: 'qa', provider: 'generic-env',
            purpose: 'QA_ISOLATION_A_PASSWORD',
            secretRef: 'k8s-secret://test-fleet/qa-isolation-fixtures#QA_ISOLATION_A_PASSWORD',
            isActive: true,
          },
          {
            grantId: 'review-admin', scope: 'team', organizationSlug: 'shizuha', teamSlug: 'review', provider: 'generic-env',
            purpose: 'REVIEW_ADMIN_TOKEN',
            secretRef: 'k8s-secret://test-fleet/review-secrets#REVIEW_ADMIN_TOKEN',
            isActive: true,
          },
        ],
        runtimeFlags: {}, diagnostics: [], appliedAt: '2026-08-02T00:00:00Z',
        signatureVerified: true, trustedForSensitive: true,
      },
    };
    const ordinary = agent('hana');
    const ordinaryBefore = computeAgentMcpConfigHash(ordinary);
    const qaBound = computeAgentMcpConfigHash(trustedQa);
    expect(k8sTeamSecretBindingsForAgent(trustedQa)).toEqual([{
      name: 'qa-isolation-fixtures',
      secretName: 'qa-isolation-fixtures',
      keys: ['QA_ISOLATION_A_PASSWORD'],
    }]);
    const qaRevoked: AgentInfo = {
      ...trustedQa,
      effectiveCapabilities: { ...trustedQa.effectiveCapabilities!, credentialMaterializations: [] },
    };
    expect(computeAgentMcpConfigHash(qaRevoked)).not.toBe(qaBound);
    expect(computeAgentMcpConfigHash(ordinary)).toBe(ordinaryBefore);

    const ineligible: AgentInfo = {
      ...trustedQa,
      effectiveCapabilities: {
        ...trustedQa.effectiveCapabilities!,
        teamCredentialEligibleTeams: [],
        teamCredentialEligibleMemberships: [],
      },
    };
    expect(k8sTeamSecretBindingsForAgent(ineligible)).toEqual([]);
    expect(computeAgentMcpConfigHash(ineligible)).not.toBe(qaBound);
    expect(renderAgentManifest(ineligible, {
      command: 'codex-bridge', model: 'gpt-5.6-sol', contextPrompt: 'ctx', password: 'pw',
    })).not.toContain('team-secret-qa-isolation-fixtures');

    const removedFromTeam: AgentInfo = {
      ...trustedQa,
      effectiveCapabilities: {
        ...trustedQa.effectiveCapabilities!,
        sourceTeams: [],
        sourceTeamMemberships: [],
      },
    };
    expect(k8sTeamSecretBindingsForAgent(removedFromTeam)).toEqual([]);
    expect(computeAgentMcpConfigHash(removedFromTeam)).not.toBe(qaBound);

    const customerQaOnly: AgentInfo = {
      ...trustedQa,
      effectiveCapabilities: {
        ...trustedQa.effectiveCapabilities!,
        // The flattened union still says "qa". Only the organization-qualified
        // membership changed, which must independently scrub the internal mount.
        sourceTeams: ['qa', 'review'],
        sourceTeamMemberships: [{ organizationSlug: 'customer-x', teamSlug: 'qa' }],
      },
    };
    expect(k8sTeamSecretBindingsForAgent(customerQaOnly)).toEqual([]);
    expect(computeAgentMcpConfigHash(customerQaOnly)).not.toBe(qaBound);
    expect(renderAgentManifest(customerQaOnly, {
      command: 'codex-bridge', model: 'gpt-5.6-sol', contextPrompt: 'ctx', password: 'pw',
    })).not.toContain('team-secret-qa-isolation-fixtures');

    const wrongPurpose: AgentInfo = {
      ...trustedQa,
      effectiveCapabilities: {
        ...trustedQa.effectiveCapabilities!,
        credentialMaterializations: [{
          grantId: 'bad', scope: 'team', organizationSlug: 'shizuha', teamSlug: 'qa', provider: 'generic-env',
          purpose: 'DIFFERENT_KEY',
          secretRef: 'k8s-secret://test-fleet/qa-isolation-fixtures#QA_ISOLATION_A_PASSWORD',
          isActive: true,
        }],
      },
    };
    expect(() => k8sTeamSecretBindingsForAgent(wrongPurpose)).toThrow(/exact Secret key/);
  });

  it('routes k8s-native package and image downloads through shared LAN caches', async () => {
    const {
      renderAgentManifest,
      K8S_RUNTIME_SPEC_REVISION,
      K8S_RUNTIME_SPEC_REVISION_ANNOTATION,
      mergeOrderedUniqueEnv,
    } = await import('../../src/daemon/k8s-backend.js');
    expect(mergeOrderedUniqueEnv(
      { NPM_CONFIG_REGISTRY: 'default', PIP_INDEX_URL: 'default-pip' },
      { NPM_CONFIG_REGISTRY: 'platform', UV_INDEX_URL: 'platform-uv' },
      { NPM_CONFIG_REGISTRY: 'agent', PIP_INDEX_URL: 'agent-pip' },
    )).toEqual([
      ['NPM_CONFIG_REGISTRY', 'agent'],
      ['PIP_INDEX_URL', 'agent-pip'],
      ['UV_INDEX_URL', 'platform-uv'],
    ]);
    const manifest = renderAgentManifest(agent('cache-test'), {
      command: 'codex-bridge', model: 'm', contextPrompt: 'ctx', password: 'pw',
    });

    expect(manifest).toContain('name: NPM_CONFIG_REGISTRY, value: "http://npm-cache.registry.svc.cluster.local:4873/"');
    expect(manifest).toContain('name: APT_CACHE_URL, value: "http://apt-cache.registry.svc.cluster.local:3142"');
    expect(manifest).toContain('name: PIP_INDEX_URL, value: "http://pip-cache.registry.svc.cluster.local/simple/"');
    expect(manifest).toContain('name: UV_INDEX_URL, value: "http://pip-cache.registry.svc.cluster.local/simple/"');
    expect(manifest).toContain('name: UV_INSECURE_HOST, value: "pip-cache.registry.svc.cluster.local"');
    const agentContainerStart = manifest.indexOf('        - name: agent\n');
    const agentEnvStart = manifest.indexOf('          env:\n', agentContainerStart);
    const agentEnvEnd = manifest.indexOf('          volumeMounts:\n', agentEnvStart);
    const agentEnvNames = [...manifest.slice(agentEnvStart, agentEnvEnd)
      .matchAll(/^\s+- \{ name: ([A-Z][A-Z0-9_]*),/gm)]
      .map((match) => match[1]);
    expect(agentContainerStart).toBeGreaterThan(-1);
    expect(agentEnvStart).toBeGreaterThan(agentContainerStart);
    expect(agentEnvEnd).toBeGreaterThan(agentEnvStart);
    expect(new Set(agentEnvNames).size).toBe(agentEnvNames.length);
    for (const key of ['APT_CACHE_URL', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'PIP_TRUSTED_HOST', 'UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'UV_INSECURE_HOST']) {
      expect(agentEnvNames.filter((name) => name === key)).toHaveLength(1);
    }
    expect(manifest).toContain('--registry-mirror=http://mirror-dockerhub.registry.svc.cluster.local:5000');
    expect(manifest).toContain(`${K8S_RUNTIME_SPEC_REVISION_ANNOTATION}: "${K8S_RUNTIME_SPEC_REVISION}"`);
    // Docker graph data remains pod-local: the mirror saves WAN while avoiding
    // unbounded writes to the agent workspace PVC.
    expect(manifest).toContain('{ name: docker-graph, emptyDir: {} }');

    const buildWorkflow = fs.readFileSync(
      path.join(process.cwd(), '.forgejo/workflows/build-mcp-auth-proxy.yml'),
      'utf-8',
    );
    expect(buildWorkflow).not.toContain('--cache=false');
    expect(buildWorkflow).toContain('--cache-repo=${REG}/kaniko-cache/${IMAGE}-amd64');
    expect(buildWorkflow).toContain('--cache-repo=${REG}/kaniko-cache/${IMAGE}-arm64');
  });

  it('preserves a live GitHub token when a transient capability refresh omits the durable payload', async () => {
    const manifestPath = path.join(tmp, 'manifest.yaml');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet secret/haru-agent-creds -o json" ]]; then
  printf '{"data":{"GITHUB_TOKEN":"%s"}}' "$(printf 'ghp_last_known_good' | base64 -w0)"
  exit 0
fi
if [[ "$*" == "apply --dry-run=client -n test-fleet -f -" ]]; then cat >/dev/null; exit 0; fi
if [[ "$*" == "apply -n test-fleet -f -" ]]; then cat > ${JSON.stringify(manifestPath)}; exit 0; fi
if [[ "$*" == "get clusterrolebinding/agent-haru-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet serviceaccount/agent-haru-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet secret/haru-fleet-ssh --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent (see note above).
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
exit 1
`);
    fs.chmodSync(kubectl, 0o755);

    const expected = agent('haru');
    expected.effectiveCapabilities = {
      source: 'hive', capabilities: ['engineering'], skills: [], eagerSkills: [], mcpServers: [],
      sourceTeams: ['engineering'], credentialGrantScopes: ['github'], credentialCustomGrantServices: [],
      runtimeFlags: {}, diagnostics: [], appliedAt: '2026-07-10T00:00:00.000Z',
    } as any;
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(expected, {
      command: 'codex-bridge', model: 'gpt-5.5', contextPrompt: 'ctx', password: 'pw',
    });
    expect(fs.readFileSync(manifestPath, 'utf8')).toContain('GITHUB_TOKEN: "ghp_last_known_good"');
  });

  it('fails closed instead of applying an empty GitHub token for an active capability', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, '#!/usr/bin/env bash\nexit 1\n');
    fs.chmodSync(kubectl, 0o755);
    const expected = agent('haru');
    expected.effectiveCapabilities = {
      source: 'hive', capabilities: ['engineering'], skills: [], eagerSkills: [], mcpServers: [],
      sourceTeams: ['engineering'], credentialGrantScopes: ['github'], credentialCustomGrantServices: [],
      runtimeFlags: {}, diagnostics: [], appliedAt: '2026-07-10T00:00:00.000Z',
    } as any;
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    expect(() => spawnAgentK8s(expected, {
      command: 'codex-bridge', model: 'gpt-5.5', contextPrompt: 'ctx', password: 'pw',
    })).toThrow(/refusing to apply an empty GITHUB_TOKEN/);
  });

  it('wakes a hibernated team-identity agent from the shared identity Secret (PLAT-4683)', async () => {
    // haru's own creds Secret has no GITHUB_TOKEN (team-identity design); the
    // live token lives in the shared sara2574-github-token Secret. The wake
    // pre-flight must resolve it there instead of false-refusing the wake.
    const manifestPath = path.join(tmp, 'manifest.yaml');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet secret/haru-agent-creds -o json" ]]; then echo '{"data":{}}'; exit 0; fi
if [[ "$*" == "get -n test-fleet secret/sara2574-github-token -o json" ]]; then
  printf '{"data":{"GITHUB_TOKEN":"%s"}}' "$(printf 'ghp_shared_sara' | base64 -w0)"
  exit 0
fi
if [[ "$*" == "apply --dry-run=client -n test-fleet -f -" ]]; then cat >/dev/null; exit 0; fi
if [[ "$*" == "apply -n test-fleet -f -" ]]; then cat > ${JSON.stringify(manifestPath)}; exit 0; fi
if [[ "$*" == "get clusterrolebinding/agent-haru-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet serviceaccount/agent-haru-ops --ignore-not-found=true -o json" ||
      "$*" == "get -n test-fleet secret/haru-fleet-ssh --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent (see note above).
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
exit 1
`);
    fs.chmodSync(kubectl, 0o755);
    const expected = agent('haru');
    expected.env = { ...(expected.env ?? {}), GITHUB_IDENTITY: 'sara2574' };
    expected.effectiveCapabilities = {
      source: 'hive', capabilities: ['engineering'], skills: [], eagerSkills: [], mcpServers: [],
      sourceTeams: ['engineering'], credentialGrantScopes: ['github'], credentialCustomGrantServices: [],
      runtimeFlags: {}, diagnostics: [], appliedAt: '2026-07-10T00:00:00.000Z',
    } as any;
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    expect(() => spawnAgentK8s(expected, {
      command: 'codex-bridge', model: 'gpt-5.5', contextPrompt: 'ctx', password: 'pw',
    })).not.toThrow();
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('bakes a checksum-verified multi-arch kubectl into the agent runtime image', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'Dockerfile.agent-runtime'), 'utf8');
    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain('ARG KUBECTL_VERSION=v1.34.6');
    expect(dockerfile).toContain('/bin/linux/${TARGETARCH}/kubectl.sha256');
    expect(dockerfile).toContain('sha256sum --check');
    expect(dockerfile).toContain('/usr/local/bin/kubectl');
  });

  it('routes k8s-native package and image downloads through shared LAN caches', async () => {
    const {
      renderAgentManifest,
      K8S_RUNTIME_SPEC_REVISION,
      K8S_RUNTIME_SPEC_REVISION_ANNOTATION,
    } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(agent('cache-test'), {
      command: 'codex-bridge', model: 'm', contextPrompt: 'ctx', password: 'pw',
    });

    expect(manifest).toContain('name: NPM_CONFIG_REGISTRY, value: "http://npm-cache.registry.svc.cluster.local:4873/"');
    expect(manifest).toContain('name: APT_CACHE_URL, value: "http://apt-cache.registry.svc.cluster.local:3142"');
    expect(manifest).toContain('name: PIP_INDEX_URL, value: "http://pip-cache.registry.svc.cluster.local/simple/"');
    expect(manifest).toContain('name: UV_INDEX_URL, value: "http://pip-cache.registry.svc.cluster.local/simple/"');
    expect(manifest).toContain('name: UV_INSECURE_HOST, value: "pip-cache.registry.svc.cluster.local"');
    expect(manifest).toContain('--registry-mirror=http://mirror-dockerhub.registry.svc.cluster.local:5000');
    expect(manifest).toContain(`${K8S_RUNTIME_SPEC_REVISION_ANNOTATION}: "${K8S_RUNTIME_SPEC_REVISION}"`);
    // Docker graph data remains pod-local: the mirror saves WAN while avoiding
    // unbounded writes to the agent workspace PVC.
    expect(manifest).toContain('{ name: docker-graph, emptyDir: {} }');

    const buildWorkflow = fs.readFileSync(
      path.join(process.cwd(), '.forgejo/workflows/build-mcp-auth-proxy.yml'),
      'utf-8',
    );
    expect(buildWorkflow).not.toContain('--cache=false');
    expect(buildWorkflow).toContain('--cache-repo=${REG}/kaniko-cache/${IMAGE}-amd64');
    expect(buildWorkflow).toContain('--cache-repo=${REG}/kaniko-cache/${IMAGE}-arm64');
  });

  it('propagates daemon web-search backend URL into k8s-native agent pods and drift hash', async () => {
    process.env['SEARCH_BASE_URL'] = 'http://100.64.0.3:30088';
    try {
      const { renderAgentManifest, computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
      const k8sAgent = agent('scout');

      const manifest = renderAgentManifest(k8sAgent, {
        command: 'gateway',
        model: 'cortex/qwen3',
        contextPrompt: 'ctx',
        password: 'pw',
      });

      expect(manifest).toContain('name: SEARCH_BASE_URL, value: "http://100.64.0.3:30088"');
      const hashWithSearch = computeAgentMcpConfigHash(k8sAgent);
      delete process.env['SEARCH_BASE_URL'];
      expect(computeAgentMcpConfigHash(k8sAgent)).not.toBe(hashWithSearch);
    } finally {
      delete process.env['SEARCH_BASE_URL'];
    }
  });

  it('renders the full runtime chain and in-pod exit-42 failover loop for k8s-native agents', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const k8sAgent = agent('mika');
    k8sAgent.modelFallbacks = [
      { method: 'claude_code_server', model: 'claude-opus-4-8' },
      { method: 'shizuha', model: 'cortex/qwen3-coder', reasoningEffort: 'high' },
    ];

    const manifest = renderAgentManifest(k8sAgent, {
      command: 'claude-bridge',
      model: 'claude-opus-4-8',
      contextPrompt: 'ctx',
      password: 'pw',
    });

    // RETIRED 2026-08-06: one agent, one model. The chain env is no longer
    // rendered (it was rendered UNCONDITIONALLY here and re-added a fallback
    // chain to all 42 daemon-managed agents on every apply, long after Hive's
    // SoT said `[]`). The inline launcher stays and degrades to the primary.
    expect(manifest).not.toContain('name: SHIZUHA_MODEL_FALLBACKS');
    expect(manifest).not.toContain('name: MODEL_FALLBACKS');
    expect(manifest).toContain('SHIZUHA_K8S_INLINE_FAILOVER');
    expect(manifest).toContain('SHIZUHA_K8S_PRIMARY_COMMAND');
    expect(manifest).toContain('SHIZUHA_K8S_PRIMARY_MODEL');
    expect(manifest).toContain('SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER');
    expect(manifest).toContain('SHIZUHA_CLAUDE_PROVIDER_UNAVAILABLE_MARKER');
    expect(manifest).toContain('/home/agent/.shizuha/.provider-unavailable-${marker_key}');
    expect(manifest).toContain('should_failover=0');
    expect(manifest).toContain('provider-unavailable command=${runtime_command} code=${code}');
    expect(manifest).toContain('[ "$runtime_command" = "codex-bridge" ] && { [ "$code" -eq 1 ] || [ "$code" -eq 43 ]; }');
    expect(manifest).toContain('[ "$runtime_command" = "claude-bridge" ] && { [ "$code" -eq 1 ] || [ "$code" -eq 143 ]; }');
    expect(manifest).toContain('failover_index=$((failover_index + 1))');
    expect(manifest).toContain('retrying from primary after ${failover_backoff}s');
    // HIVE-553: the step-selection script is base64-shipped (a raw heredoc
    // body at column 0 broke the YAML block scalar); assert on the decoded form.
    const b64 = manifest.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d \| node/);
    expect(b64).not.toBeNull();
    expect(Buffer.from(b64![1]!, 'base64').toString('utf8')).toContain('commandByMethod');
  });

  it('renders Hive-owned model compatibility fields even when fallback lists are empty', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const k8sAgent = agent('jun');
    k8sAgent.model = 'gpt-5.6-sol';
    k8sAgent.executionMethod = 'codex_app_server';
    k8sAgent.modelFallbacks = [];
    k8sAgent.modelOverrides = {
      codex_app_server: 'gpt-5.6-sol',
      codex_app_server_reasoning_effort: 'high',
    };

    const manifest = renderAgentManifest(k8sAgent, {
      command: 'codex-bridge',
      model: 'gpt-5.6-sol',
      effort: 'high',
      contextPrompt: 'ctx',
      password: 'pw',
    });

    expect(manifest).toContain('shizuha.io/model-policy: "hive-sot-v1"');
    expect(manifest).toContain('shizuha.io/primary-model: "gpt-5.6-sol"');
    expect(manifest).toContain('shizuha.io/execution-method: "codex_app_server"');
    expect(manifest).toContain('shizuha.io/reasoning-effort: "high"');
    expect(manifest).toContain('name: MODEL, value: "gpt-5.6-sol"');
    expect(manifest).toContain('name: REASONING_EFFORT, value: "high"');
    expect(manifest).toContain('name: EXECUTION_METHOD, value: "codex_app_server"');
    // MODEL_FALLBACKS is retired — never rendered, so a stale live value is
    // deleted by the apply's 3-way merge rather than perpetually re-added.
    expect(manifest).not.toContain('name: MODEL_FALLBACKS');
    expect(manifest).toContain('name: MODEL_OVERRIDES, value:');
    expect(manifest).toContain('codex_app_server_reasoning_effort');
    expect(manifest).toContain('name: CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN, value: "1"');
  });

  it('renders an explicit broker image only when the idle-gated roller requests it', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(agent('mika'), {
      command: 'claude-bridge',
      model: 'claude-opus-4-8',
      contextPrompt: 'ctx',
      password: 'pw',
    }, undefined, {
      brokerImageOverride: 'localhost:30500/mcp-auth-proxy:lease-metadata-test',
    });

    expect(manifest).toContain('image: localhost:30500/mcp-auth-proxy:lease-metadata-test');
  });

  it('renders single-step Hive-authored model fallback chains for k8s-native agents', async () => {
    const { renderAgentManifest, computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const deepseekAgent = agent('jun');
    deepseekAgent.executionMethod = 'shizuha';
    deepseekAgent.model = 'cortex/DeepSeek-V4-Flash';
    deepseekAgent.modelFallbacks = [
      { method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash', reasoningEffort: 'high' },
    ];
    const qwenAgent = {
      ...deepseekAgent,
      model: 'cortex/Qwen3.6-27B-NVFP4',
      modelFallbacks: [
        { method: 'shizuha', model: 'cortex/Qwen3.6-27B-NVFP4', reasoningEffort: 'high' },
      ],
    };

    const manifest = renderAgentManifest(deepseekAgent, {
      command: 'gateway',
      model: 'cortex/DeepSeek-V4-Flash',
      effort: 'high',
      contextPrompt: 'ctx',
      password: 'pw',
    });

    expect(manifest).not.toContain('name: SHIZUHA_MODEL_FALLBACKS');
    expect(manifest).toContain('cortex/DeepSeek-V4-Flash');
    expect(manifest).not.toContain('cortex/Qwen3.6-27B-NVFP4');
    expect(computeAgentMcpConfigHash(deepseekAgent)).not.toBe(computeAgentMcpConfigHash(qwenAgent));
  });

  it('lists legacy agent Deployments even before they carry the k3s-native runtime label', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru","labels":{"shizuha.io/agent":"haru"}},"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}},{"metadata":{"name":"not-an-agent"},"spec":{"replicas":1},"status":{}}]}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    expect(listK8sAgentDeployments([agent('haru')])).toEqual([{
      agentId: 'agent-haru-id',
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    }]);
  });

  it('exposes a stale k3s Deployment to lifecycle reconciliation after desired placement moved to container', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-ichi"},"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    const ichi = { ...agent('ichi'), runtimeEnvironment: 'container' as const };

    expect(listK8sAgentDeployments([ichi])).toEqual([]);
    expect(listK8sAgentDeployments(
      [ichi],
      { includeNonK8sDesired: true },
    )).toEqual([expect.objectContaining({
      agentId: 'agent-ichi-id',
      username: 'ichi',
      replicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    })]);
  });

  it('does not treat a kube-auth list failure as zero Deployments', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
echo "E0814 06:41:26.254936 2132483 memcache.go:265] couldn't get current server API group list: the server has asked for the client to provide credentials" >&2
echo "error: You must be logged in to the server (the server has asked for the client to provide credentials)" >&2
exit 1
`);
    fs.chmodSync(kubectl, 0o755);

    const {
      listK8sAgentDeployments,
      classifyKubectlFailure,
      operatorFacingK8sError,
      K8sObserveError,
    } = await import('../../src/daemon/k8s-backend.js');
    const dump = 'k8s reconcile start failed: Command failed: /usr/local/bin/kubectl get -n shizuha-fleet deployment/agent-ichi -o json\nerror: You must be logged in to the server (the server has asked for the client to provide credentials)';
    expect(classifyKubectlFailure(dump)).toBe('auth');
    expect(operatorFacingK8sError(dump)).not.toMatch(/kubectl|memcache|logged in/);
    expect(() => listK8sAgentDeployments([agent('ichi')])).toThrow(K8sObserveError);
  });

  it('records the live broker image independently from the agent runtime image', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","image":"registry/runtime:new"},{"name":"broker","image":"registry/broker:old"}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    expect(listK8sAgentDeployments([agent('haru')])).toEqual([expect.objectContaining({
      currentImage: 'registry/runtime:new',
      currentBrokerImage: 'registry/broker:old',
    })]);
  });

  it('preserves runtime-release authority in the bulk deployment reader', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const digest = `sha256:${'7'.repeat(64)}`;
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '%s' ${JSON.stringify(JSON.stringify({ items: [{
    metadata: { name: 'agent-haru', annotations: {
      'shizuha.io/runtime-release-generation': '7',
      'shizuha.io/runtime-release-digest': digest,
    } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: 'agent', image: `registry/runtime@${digest}` }] } } },
    status: { readyReplicas: 1, availableReplicas: 1 },
  }] }))}
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    expect(listK8sAgentDeployments([agent('haru')])).toEqual([expect.objectContaining({
      runtimeReleaseGeneration: 7,
      runtimeReleaseDigest: digest,
    })]);
  });

  it('normalizes duplicate env names with stable ordering and later-value precedence', async () => {
    const { normalizeAgentDeploymentEnvMetadata } = await import('../../src/daemon/k8s-backend.js');
    const raw = JSON.stringify({
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'agent',
              env: [
                { name: 'A', value: 'first' },
                { name: 'B', value: 'only' },
                { name: 'A', value: 'last' },
              ],
            }],
            initContainers: [{
              name: 'init',
              env: [{ name: 'CACHE', value: 'old' }, { name: 'CACHE', value: 'new' }],
            }],
          },
        },
      },
    });

    const normalized = normalizeAgentDeploymentEnvMetadata(raw);
    expect(normalized.changed).toBe(true);
    const podSpec = (normalized.document as any).spec.template.spec;
    expect(podSpec.containers[0].env).toEqual([
      { name: 'A', value: 'last' },
      { name: 'B', value: 'only' },
    ]);
    expect(podSpec.initContainers[0].env).toEqual([{ name: 'CACHE', value: 'new' }]);
    expect(normalizeAgentDeploymentEnvMetadata(JSON.stringify(normalized.document)).changed).toBe(false);
  });

  it('repairs live and last-applied duplicate env metadata through guarded JSON Patch', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const fixture = path.join(tmp, 'deployment.json');
    const logPath = path.join(tmp, 'kubectl.log');
    const lastApplied = {
      spec: { template: { spec: { containers: [{ name: 'agent', env: [
        { name: 'CACHE', value: 'old' }, { name: 'CACHE', value: 'new' },
      ] }] } } },
    };
    fs.writeFileSync(fixture, JSON.stringify({
      metadata: {
        resourceVersion: '42',
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(lastApplied) },
      },
      spec: { replicas: 0, template: { spec: { containers: [{ name: 'agent', env: [
        { name: 'LIVE', value: 'old' }, { name: 'LIVE', value: 'new' },
      ] }] } } },
      status: {},
    }));
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-haru -o json" ]]; then
  cat ${JSON.stringify(fixture)}
  exit 0
fi
if [[ "$*" == patch*"--type=json"* ]]; then exit 0; fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const {
      getAgentK8sDeploymentState,
      repairAgentK8sDuplicateEnvMetadata,
    } = await import('../../src/daemon/k8s-backend.js');
    expect(getAgentK8sDeploymentState(agent('haru'))).toEqual(expect.objectContaining({
      duplicateEnvMetadata: true,
    }));
    expect(repairAgentK8sDuplicateEnvMetadata(agent('haru'))).toBe(true);

    const patchLine = fs.readFileSync(logPath, 'utf8').trim().split('\n').at(-1)!;
    const operations = JSON.parse(patchLine.slice(patchLine.indexOf(' -p ') + 4));
    expect(operations[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: '42' });
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'replace', path: '/spec/template/spec/containers/0/env' }),
      expect.objectContaining({
        op: 'replace',
        path: '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration',
      }),
    ]));
    expect(operations.find((op: any) => op.path.endsWith('/containers/0/env')).value)
      .toEqual([{ name: 'LIVE', value: 'new' }]);
  });


  it('marks a ready k8s Deployment as drifted when a GitHub grant is not wired into env/Secret', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    expect(listK8sAgentDeployments([agentWithGithub('haru')])).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      readyReplicas: 1,
      githubCredentialExpected: true,
      githubTokenEnvWired: false,
      githubTokenSecretPresent: false,
      githubCredentialDrift: true,
    })]);
  });

  it('still marks drift when a GitHub grant exists but token is not materialized', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t\n'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    expect(listK8sAgentDeployments([agentWithGithubButNoToken('haru')])).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      readyReplicas: 1,
      githubCredentialExpected: true,
      githubTokenEnvWired: true,
      githubTokenSecretPresent: false,
      githubCredentialDrift: true,
    })]);
  });

  it('does not mark GitHub credential drift when env and Secret data both match the daemon source', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    expect(listK8sAgentDeployments([agentWithGithub('haru')])).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      readyReplicas: 1,
      githubCredentialExpected: true,
      githubTokenEnvWired: true,
      githubTokenSecretPresent: true,
      githubCredentialDrift: false,
    })]);
  });

  // PLAT-4958: the Progressing condition is the only field that separates
  // "new pod still starting" from "pod is broken" — the replica counts are
  // identical in both cases. Parse it, or the guard has nothing to read.
  it('records the Progressing reason from the live Deployment status', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru","generation":8},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"observedGeneration":8,"updatedReplicas":1,"readyReplicas":0,"availableReplicas":0,"conditions":[{"type":"Available","status":"False","reason":"MinimumReplicasUnavailable"},{"type":"Progressing","status":"True","reason":"ReplicaSetUpdated","lastUpdateTime":"2026-07-21T12:00:00Z"}]}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments } = await import('../../src/daemon/k8s-backend.js');
    const [state] = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(state).toEqual(expect.objectContaining({
      username: 'haru',
      readyReplicas: 0,
      progressingReason: 'ReplicaSetUpdated',
    }));
    // the bound is useless if the timestamp never reaches the state
    expect(state?.progressingUpdatedAtMs).toBe(Date.parse('2026-07-21T12:00:00Z'));
  });

  it('does not mark credential drift when Secret inventory is unavailable but env wiring is correct', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  echo 'Error from server (Forbidden): secrets is forbidden' >&2
  exit 1
fi
if [[ "$1" == "exec" ]]; then
  [[ "$*" == *"deployment/agent-haru"* ]]
  [[ "$*" == *"gh api user --include --jq .login"* ]]
  [[ "$*" == *"gh api 'repos/shizuha-labs/shizuha-beta' --include --jq '.full_name'"* ]]
  printf 'sara2574'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(states).toEqual([expect.objectContaining({
      username: 'haru',
      githubTokenEnvWired: true,
      githubCredentialDrift: false,
    })]);
    expect(states[0]).not.toHaveProperty('githubTokenSecretPresent');
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: true,
      reason: 'ok',
      identity: 'sara2574',
      probeRepo: 'shizuha-labs/shizuha-beta',
    })]);
  });

  it('probes the live k8s runtime token with gh api user plus repo access', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  [[ "$*" == *"gh api user --include --jq .login"* ]]
  [[ "$*" == *"gh api 'repos/shizuha-labs/shizuha-beta' --include --jq '.full_name'"* ]]
  printf 'sara2574'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: true,
      reason: 'ok',
      identity: 'sara2574',
      probeRepo: 'shizuha-labs/shizuha-beta',
    })]);
  });

  it('probe script actually executes under the shell passed to kubectl exec', async () => {
    // Regression for revi's P1 on PR #291: the probe uses `set -o pipefail`,
    // which dash (/bin/sh on the Ubuntu agent image) rejects. The fake kubectl
    // here EXECUTES the shell invocation it is handed instead of
    // pattern-matching it, so a regression back to `sh -lc` fails the probe
    // before gh is ever consulted.
    const gh = path.join(tmp, 'gh');
    fs.writeFileSync(gh, `#!/usr/bin/env bash
if [[ "$1 $2" == "api user" ]]; then printf 'sara2574'; exit 0; fi
exit 0
`);
    fs.chmodSync(gh, 0o755);
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  # args: exec -n <ns> deployment/<name> -c agent -- <shell> <flag> <script>
  # \${8}=shell \${9}=flag(-lc) \${10}=script. Run the REAL shell the code passed
  # (so a regression to sh/dash still trips on \`set -o pipefail\`), but re-inject
  # the fake gh dir into PATH inside the -c command: bash's LOGIN shell (-l)
  # sources /etc/profile which resets PATH and would otherwise drop \${tmp}.
  export GITHUB_TOKEN=ghp_test_token
  exec "\${8}" "\${9}" "export PATH=${tmp}:/usr/local/bin:/usr/bin:/bin; \${10}"
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      username: 'haru',
      ok: true,
      reason: 'ok',
      identity: 'sara2574',
    })]);
  });

  it('fails loud when a non-empty wired Secret contains a stale or invalid GitHub token', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '3';
    const countPath = path.join(tmp, 'credential-probe-count');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  count=0
  [[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
  printf '%s' "$((count + 1))" > ${JSON.stringify(countPath)}
  echo "gh: Bad credentials (HTTP 401)" >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: false,
      reason: 'github_api_failed',
      detail: expect.stringContaining('Bad credentials'),
    })]);
    expect(fs.readFileSync(countPath, 'utf-8')).toBe('1');
  });

  it('retries a transient GitHub 503 and returns healthy when the next probe succeeds', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '2';
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_RETRY_DELAY_MS'] = '1';
    const countPath = path.join(tmp, 'upstream-recovery-count');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  count=0
  [[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(countPath)}
  if [[ "$count" -eq 1 ]]; then
    printf '%s\n' 'HTTP/2.0 503 Service Unavailable' 'Content-Type: text/html; charset=utf-8' 'X-Github-Request-Id: TEST:503' "invalid character '<' looking for beginning of value" >&2
    exit 1
  fi
  printf 'sara2574'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      username: 'haru',
      ok: true,
      reason: 'ok',
      identity: 'sara2574',
    })]);
    expect(fs.readFileSync(countPath, 'utf-8')).toBe('2');
  });

  it('classifies repeated GitHub 503 responses as upstream unavailable after bounded retries', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '2';
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_RETRY_DELAY_MS'] = '1';
    const countPath = path.join(tmp, 'upstream-exhausted-count');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  count=0
  [[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
  printf '%s' "$((count + 1))" > ${JSON.stringify(countPath)}
  printf '%s\n' 'HTTP/2.0 503 Service Unavailable' 'Content-Type: text/html; charset=utf-8' 'X-Github-Request-Id: TEST:503' "invalid character '<' looking for beginning of value" >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      username: 'haru',
      ok: false,
      reason: 'github_upstream_unavailable',
      detail: expect.stringMatching(/HTTP\/2\.0 503.*Content-Type: text\/html.*X-Github-Request-Id/s),
    })]);
    expect(fs.readFileSync(countPath, 'utf-8')).toBe('2');
  });

  it('preserves x-github-request-id in the exhausted-retry detail when it sits beyond the 500-char body cap', async () => {
    // PLAT-4778 (revi #313): a real gh --include header block is ~875B with
    // x-github-request-id near byte 819. Pad the block so the id lands well past
    // the 500-char body cap; a blind truncation would drop it, but the named-field
    // extraction must keep it in the exhausted-retry detail.
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '2';
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_RETRY_DELAY_MS'] = '1';
    const kubectl = path.join(tmp, 'kubectl');
    const pad = Array.from({ length: 12 }, (_v, i) =>
      `'X-Ratelimit-Padding-${i}: ${'p'.repeat(48)}'`).join(' ');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  printf '%s\n' 'HTTP/2.0 503 Service Unavailable' 'Content-Type: text/html; charset=utf-8' ${pad} 'X-Github-Request-Id: BEYOND-500-ABC123DEF' "invalid character '<' looking for beginning of value" >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    const [result] = probeK8sGithubCredentialHealth([agentWithGithub('haru')], states);
    expect(result.reason).toBe('github_upstream_unavailable');
    // The request id sits past the 500-char body cap in the raw block but MUST
    // survive via named-field extraction (contract: status + content-type + id).
    expect(result.detail).toContain('BEYOND-500-ABC123DEF');
    expect(result.detail).toContain('503');
    expect(result.detail).toContain('Content-Type');
  });

  it.each([
    ['DNS failure', 'Get "https://api.github.com/user": dial tcp: lookup api.github.com: no such host'],
    ['request timeout', 'Get "https://api.github.com/user": context deadline exceeded (Client.Timeout exceeded while awaiting headers)'],
  ])('classifies a GitHub %s as upstream unavailable', async (_label, failureDetail) => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '1';
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  printf '%s\n' ${JSON.stringify(failureDetail)} >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      username: 'haru',
      ok: false,
      reason: 'github_upstream_unavailable',
      detail: expect.stringContaining('api.github.com'),
    })]);
  });

  it('uses upstream UNKNOWN wording instead of a bad-token invariant after exhausted retries', async () => {
    const { k8sGithubAuthAndonContent } = await import('../../src/daemon/manager.js');
    const content = k8sGithubAuthAndonContent(agent('haru'), {
      agentId: 'agent-haru-id',
      username: 'haru',
      team: 'documentation',
      ownerGroup: 'documentation',
      expected: true,
      ok: false,
      reason: 'github_upstream_unavailable',
      checkedAt: new Date(0).toISOString(),
      detail: 'HTTP/2.0 503 Service Unavailable Content-Type: text/html',
    }, 'yuki');

    expect(content).toContain('GitHub API upstream unavailable');
    expect(content).toContain('Invariant status: UNKNOWN');
    expect(content).toContain('not proof of a bad token');
    expect(content).not.toContain('must have a live runtime token that authenticates');
  });

  // PLAT-4958: `deployment_unready` is an early return in
  // probeK8sGithubCredentialHealth() -- it fires on replica counts alone and
  // returns BEFORE the in-pod `gh api user` probe. It must therefore not assert
  // the credential invariant. Ten responders were sent to check a GitHub token
  // this page had never tested.
  it('does not assert the credential invariant when the probe never ran (deployment_unready)', async () => {
    const { k8sGithubAuthAndonContent } = await import('../../src/daemon/manager.js');
    const content = k8sGithubAuthAndonContent(agent('haru'), {
      agentId: 'agent-haru-id',
      username: 'haru',
      team: 'documentation',
      ownerGroup: 'documentation',
      expected: true,
      ok: false,
      reason: 'deployment_unready',
      checkedAt: new Date(0).toISOString(),
      detail: 'replicas=1, ready=0, available=0',
    }, 'yuki');

    expect(content).toContain('Invariant status: NOT EVALUATED');
    expect(content).toContain('credential probe did NOT run');
    expect(content).toContain('Do NOT repair, rotate or re-materialize credentials');
    expect(content).toContain('do NOT open a credential investigation');
    // NOT EVALUATED, not UNKNOWN: the probe never ran, so this is a different
    // state from the transport/upstream branches where it ran and failed.
    expect(content).not.toContain('Invariant status: UNKNOWN');
    // the exact sentence that misdirected ten responders must be absent
    expect(content).not.toContain('must have a live runtime token that authenticates');
    // and it must not claim a probe it never performed
    expect(content).not.toContain('- Probe: GITHUB_TOKEN non-empty + gh api user');
  });

  it('classifies kubectl exec client timeouts separately from GitHub API failures', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_TIMEOUT_MS'] = '50';
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '1';
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  sleep 1
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: false,
      reason: 'probe_transport_failed',
      detail: expect.stringMatching(/ETIMEDOUT|timed out|SIGTERM/i),
    })]);
  });

  it('classifies kubectl exec target/container failures separately from GitHub API failures', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  echo 'error: unable to upgrade connection: container not found ("agent")' >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: false,
      reason: 'probe_transport_failed',
      detail: expect.stringContaining('container not found'),
    })]);
  });

  it('classifies kubelet internal exec proxy errors with Go formatting artifacts as transport failures', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '1';
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  echo 'error: Internal error occurred: error sending request: Post "https://10.200.10.5:10250/exec/test-fleet/agent-haru-abc/agent?command=bash&command=-lc&command=set%!B(MISSING)-o%!B(MISSING)pipefail": proxy error' >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: false,
      reason: 'probe_transport_failed',
      detail: expect.stringContaining('Internal error occurred: error sending request'),
    })]);
  });

  it('classifies transient runc namespace races as transport failures', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '1';
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  echo 'error: Internal error occurred: failed to start exec: OCI runtime exec failed: unable to start container process: error executing setns process: nsexec-1: failed to open /proc/12345/ns/ipc: No such file or directory; nsexec-0: failed to sync with stage-1' >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: false,
      reason: 'probe_transport_failed',
      detail: expect.stringContaining('error executing setns process'),
    })]);
  });

  it('retries one transient kubectl transport failure before paging', async () => {
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] = '2';
    process.env['SHIZUHA_GITHUB_AUTH_PROBE_RETRY_DELAY_MS'] = '1';
    const countPath = path.join(tmp, 'probe-count');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployments -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"agent-haru"},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"agent","env":[{"name":"GITHUB_TOKEN","valueFrom":{"secretKeyRef":{"name":"haru-agent-creds","key":"GITHUB_TOKEN"}}}]}]}}},"status":{"readyReplicas":1,"availableReplicas":1}}]}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet secrets -o go-template="* ]]; then
  printf 'haru-agent-creds\t1\n'
  exit 0
fi
if [[ "$*" == exec\\ -n\\ test-fleet\\ deployment/agent-haru\\ -c\\ agent\\ --\\ bash\\ -lc* ]]; then
  count=0
  [[ -f ${JSON.stringify(countPath)} ]] && count=$(cat ${JSON.stringify(countPath)})
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(countPath)}
  if [[ "$count" -eq 1 ]]; then
    echo 'error: unable to upgrade connection: container not found ("agent")' >&2
    exit 1
  fi
  printf 'sara2574'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { listK8sAgentDeployments, probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const states = listK8sAgentDeployments([agentWithGithub('haru')]);
    expect(probeK8sGithubCredentialHealth([agentWithGithub('haru')], states)).toEqual([expect.objectContaining({
      agentId: 'agent-haru-id',
      username: 'haru',
      ok: true,
      reason: 'ok',
      identity: 'sara2574',
    })]);
    expect(fs.readFileSync(countPath, 'utf-8')).toBe('2');
  });

  it('surfaces failure when the Deployment does not converge to 0', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet deployment/agent-ryo -o json" ]]; then
  printf '{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
  exit 0
fi
exit 0
`);
    fs.chmodSync(kubectl, 0o755);

    const { stopAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    expect(() => stopAgentK8s(agent('ryo'), 1)).toThrow(/did not converge to replicas=0/);
  });



  it('reads pod session tail asynchronously and caches drawer polls', async () => {
    const logPath = path.join(tmp, 'kubectl-session.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "--request-timeout=2s get -n test-fleet deployment/agent-hana -o json" ]]; then
  printf '{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
  exit 0
fi
if [[ "$*" == *" exec "* ]]; then
  printf '/home/agent/.claude/projects/-workspace/session.jsonl\n'
  printf '{"type":"user","message":{"content":"hello"}}\n'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { readK8sAgentSessionTail } = await import('../../src/daemon/k8s-backend.js');
    const first = await readK8sAgentSessionTail(agent('hana'), 2000);
    const second = await readK8sAgentSessionTail(agent('hana'), 100);

    expect(first?.file).toBe('/home/agent/.claude/projects/-workspace/session.jsonl');
    expect(first?.lines[0]).toContain('hello');
    expect(second).toEqual(first);
    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('--request-timeout=2s get -n test-fleet deployment/agent-hana -o json');
    expect(calls[1]).toContain('--request-timeout=2s exec -n test-fleet deployment/agent-hana -c agent -- sh -c');
  });

  it('fails fast with an explicit degraded reason when the k8s Deployment is absent', async () => {
    const logPath = path.join(tmp, 'kubectl-missing.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "--request-timeout=2s get -n test-fleet deployment/agent-hana -o json" ]]; then
  echo 'Error from server (NotFound): deployments.apps "agent-hana" not found' >&2
  exit 1
fi
if [[ "$1" == *"exec"* ]]; then
  echo "exec should not be attempted for an absent deployment" >&2
  exit 9
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { readK8sAgentSessionTailStatus } = await import('../../src/daemon/k8s-backend.js');
    const result = await readK8sAgentSessionTailStatus(agent('hana'), 2000);

    expect(result.tail).toBeNull();
    expect(result.unavailable).toMatchObject({
      reason: 'deployment_unavailable',
      message: expect.stringContaining('served from fallback'),
    });
    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toEqual(['--request-timeout=2s get -n test-fleet deployment/agent-hana -o json']);
  });

  it('does not block the event loop while kubectl exec is pending', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--request-timeout=2s get -n test-fleet deployment/agent-hana -o json" ]]; then
  printf '{"spec":{"replicas":1},"status":{"readyReplicas":1,"availableReplicas":1}}'
  exit 0
fi
if [[ "$*" == *" exec "* ]]; then
  sleep 0.2
  printf '/home/agent/.claude/projects/-workspace/session.jsonl\n'
  printf '{"type":"user","message":{"content":"slow"}}\n'
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { readK8sAgentSessionTail } = await import('../../src/daemon/k8s-backend.js');
    let timerFired = false;
    const pending = readK8sAgentSessionTail(agent('hana'), 2000);
    setTimeout(() => { timerFired = true; }, 10);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timerFired).toBe(true);
    expect((await pending)?.lines[0]).toContain('slow');
  });


  it('uses resolved credential env for k8s AGENT_PASSWORD before raw fallbacks', async () => {
    const oldPassword = process.env['AGENT_PASSWORD'];
    process.env['AGENT_PASSWORD'] = 'global-password';
    const { resolveK8sSpawnPassword } = await import('../../src/daemon/manager.js');

    try {
      expect(resolveK8sSpawnPassword(
        { env: { AGENT_PASSWORD: 'raw-agent-env-password' } },
        { AGENT_PASSWORD: 'credential-backed-password' },
      )).toBe('credential-backed-password');
      expect(resolveK8sSpawnPassword(
        { env: { AGENT_PASSWORD: 'raw-agent-env-password' } },
        {},
      )).toBe('raw-agent-env-password');
      expect(resolveK8sSpawnPassword(
        { env: {} },
        {},
      )).toBe('global-password');
    } finally {
      if (oldPassword === undefined) {
        delete process.env['AGENT_PASSWORD'];
      } else {
        process.env['AGENT_PASSWORD'] = oldPassword;
      }
    }
  });

  it('does not render corrupt short AGENT_PASSWORD values into k8s Secrets', async () => {
    const oldPassword = process.env['AGENT_PASSWORD'];
    process.env['AGENT_PASSWORD'] = 'global-password';
    const { resolveK8sSpawnPassword } = await import('../../src/daemon/manager.js');

    try {
      expect(resolveK8sSpawnPassword(
        { env: { AGENT_PASSWORD: 'bad' } },
        { AGENT_PASSWORD: 'nope' },
      )).toBe('global-password');
      process.env['AGENT_PASSWORD'] = 'short';
      expect(resolveK8sSpawnPassword(
        { env: { AGENT_PASSWORD: 'bad' } },
        { AGENT_PASSWORD: 'nope' },
      )).toBe('');
    } finally {
      if (oldPassword === undefined) {
        delete process.env['AGENT_PASSWORD'];
      } else {
        process.env['AGENT_PASSWORD'] = oldPassword;
      }
    }
  });



  it('spawns k8s-native even for DevOps and broker-bound capability contracts (PLAT-3366 reversed: privilege gated by Hive grants, not host-Docker fallback)', async () => {
    const { explainK8sUnsupportedRuntime, shouldSpawnK8sAgent } = await import('../../src/daemon/k8s-backend.js');
    const devopsAgent = agent('san');
    devopsAgent.skills = ['devops'];
    devopsAgent.team = 'devops';
    devopsAgent.credentialGrantScopes = ['fleet-ssh', 'kubeconfig'];
    devopsAgent.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['devops', 'needs:kubeconfig', 'needs:host-exec', 'needs:credential-broker'],
      skills: ['devops'],
      eagerSkills: [],
      mcpServers: ['cron'],
      sourceTeams: ['devops'],
      credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
      credentialCustomGrantServices: [],
      runtimeFlags: {},
      diagnostics: [],
      appliedAt: '2026-07-04T00:00:00.000Z',
    } as any;

    // k8s-native pods carry the broker/DinD sidecars + effective-capability env,
    // so privileged DevOps agents are no longer forced back onto host Docker.
    expect(explainK8sUnsupportedRuntime(devopsAgent)).toBeNull();
    expect(shouldSpawnK8sAgent(devopsAgent)).toBe(true);
  });

  it('renders a capability-selected per-agent ServiceAccount, RBAC binding, and fleet-ssh mount for DevOps pods', async () => {
    const { explainK8sUnsupportedRuntime, isPrivilegedK8sAgent, renderAgentManifest, shouldSpawnK8sAgent } = await import('../../src/daemon/k8s-backend.js');
    const devopsAgent = agent('san');
    devopsAgent.skills = ['devops'];
    devopsAgent.team = 'devops';
    devopsAgent.credentialGrantScopes = ['fleet-ssh', 'kubeconfig'];
    devopsAgent.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['devops', 'needs:kubeconfig', 'needs:host-exec', 'needs:credential-broker'],
      skills: ['devops'],
      eagerSkills: [],
      mcpServers: ['cron'],
      sourceTeams: ['devops'],
      credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
      credentialCustomGrantServices: [],
      runtimeFlags: {},
      diagnostics: [],
      appliedAt: '2026-07-04T00:00:00.000Z',
    } as any;

    expect(shouldSpawnK8sAgent(devopsAgent)).toBe(true);
    expect(explainK8sUnsupportedRuntime(devopsAgent)).toBeNull();
    expect(isPrivilegedK8sAgent(devopsAgent)).toBe(true);

    const manifest = renderAgentManifest(devopsAgent, {
      command: 'codex-bridge',
      model: 'gpt-5.5',
      contextPrompt: 'ctx',
      password: 'pw',
      fleetSshFiles: {
        id_rsa: 'test-private-key',
        'id_rsa.pub': 'test-public-key',
        known_hosts: 'gx10-5 ssh-ed25519 test',
        config: 'Host gx10-5',
      },
    });

    expect(manifest).toContain('kind: ServiceAccount');
    expect(manifest).toContain('name: agent-san-ops');
    expect(manifest).toContain('kind: ClusterRoleBinding');
    expect(manifest).toContain('name: shizuha-fleet-agent-ops');
    expect(manifest).toContain('serviceAccountName: agent-san-ops');
    expect(manifest).toContain('name: san-fleet-ssh');
    expect(manifest).toContain('name: fleet-ssh-materialize');
    expect(manifest).toContain('mountPath: /home/agent/.ssh, readOnly: true');
    expect(manifest).toContain('automountServiceAccountToken: true');
    expect(manifest).toContain('name: kubeconfig-materialize');
    expect(manifest).toContain('name: KUBECONFIG, value: "/home/agent/.kube/config"');
    expect(manifest).toContain('mountPath: /home/agent/.kube, readOnly: true');
    expect(manifest).toContain('tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token');
    expect(manifest).toContain('certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    // Regression (san down, 2026-07-16): the fleet-ssh-materialize init runs as
    // root (0700 dir + chown of the SSH home) and MUST carry runAsNonRoot:false —
    // like workspace-permissions/dind — or the pod-level runAsNonRoot:true
    // hardening (BRW-12/PLAT-422) makes the kubelet reject it with
    // CreateContainerConfigError and the pod restart-loops. Assert it on THIS
    // container's securityContext specifically (not just anywhere in the manifest).
    const fleetSshBlock = manifest.slice(manifest.indexOf('name: fleet-ssh-materialize'));
    const fleetSshSecCtx = fleetSshBlock.slice(0, fleetSshBlock.indexOf('volumeMounts'));
    expect(fleetSshSecCtx).toContain('runAsNonRoot: false');
  });

  it('requires fleet SSH for capability-only host-exec agents and fails closed without staged grant files', async () => {
    const {
      isPrivilegedK8sAgent,
      missingRequiredFleetSshReason,
      requiresFleetSshForK8sAgent,
    } = await import('../../src/daemon/k8s-backend.js');
    const capabilityOnly = agent('hostcap');
    capabilityOnly.skills = ['engineering'];
    capabilityOnly.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['needs:host-exec'],
      skills: [],
      eagerSkills: [],
      mcpServers: [],
      sourceTeams: ['engineering'],
      credentialGrantScopes: [],
      credentialCustomGrantServices: [],
      runtimeFlags: {},
      diagnostics: [],
      appliedAt: '2026-07-10T00:00:00.000Z',
    } as any;

    expect(isPrivilegedK8sAgent(capabilityOnly)).toBe(true);
    expect(requiresFleetSshForK8sAgent(capabilityOnly)).toBe(true);
    expect(missingRequiredFleetSshReason(capabilityOnly, undefined)).toMatch(/requires an active fleet-ssh grant/);
    expect(missingRequiredFleetSshReason(capabilityOnly, {})).toMatch(/requires an active fleet-ssh grant/);
    expect(missingRequiredFleetSshReason(capabilityOnly, { id_ed25519: 'key', known_hosts: 'host key' })).toBeNull();
  });

  it('allows ordinary k8s-native agents without privileged capability contracts', async () => {
    const { explainK8sUnsupportedRuntime, isPrivilegedK8sAgent, renderAgentManifest, shouldSpawnK8sAgent } = await import('../../src/daemon/k8s-backend.js');
    const ordinary = agent('hana');
    ordinary.skills = ['engineering'];
    ordinary.team = 'engineering';
    ordinary.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['engineering'],
      skills: ['engineering'],
      eagerSkills: [],
      mcpServers: ['pulse', 'wiki'],
      sourceTeams: ['engineering'],
      credentialGrantScopes: [],
      credentialCustomGrantServices: [],
      runtimeFlags: {},
      diagnostics: [],
      appliedAt: '2026-07-04T00:00:00.000Z',
    } as any;

    expect(explainK8sUnsupportedRuntime(ordinary)).toBeNull();
    expect(shouldSpawnK8sAgent(ordinary)).toBe(true);
    expect(isPrivilegedK8sAgent(ordinary)).toBe(false);
    const manifest = renderAgentManifest(ordinary, {
      command: 'gateway',
      model: 'cortex/qwen3',
      contextPrompt: 'ctx',
      password: 'pw',
    });
    expect(manifest).toContain('automountServiceAccountToken: false');
    expect(manifest).toContain('serviceAccountName: default');
    expect(manifest).not.toContain('serviceAccountName: agent-hana-ops');
    expect(manifest).not.toContain('fleet-ssh-materialize');
    expect(manifest).not.toContain('kubeconfig-materialize');
    expect(manifest).not.toContain('name: KUBECONFIG');
  });

  it('treats valid Hive effective access as exclusive over stale legacy privilege fields', async () => {
    const {
      computeAgentMcpConfigHash,
      isPrivilegedK8sAgent,
      renderAgentManifest,
    } = await import('../../src/daemon/k8s-backend.js');
    const ordinary = agent('ryo');
    ordinary.skills = ['merge'];
    ordinary.credentialGrantScopes = [];
    ordinary.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['merge'],
      skills: ['merge'],
      eagerSkills: [],
      mcpServers: ['admin', 'connect', 'id', 'pulse', 'wiki'],
      sourceTeams: ['merge'],
      credentialGrantScopes: [],
      credentialCustomGrantServices: [],
      runtimeFlags: {},
      diagnostics: [],
      appliedAt: '2026-07-26T18:00:00.000Z',
    } as any;
    const staleLegacy = structuredClone(ordinary);
    staleLegacy.skills = ['merge', 'devops'];
    staleLegacy.eagerSkills = ['shipping-prs'];
    staleLegacy.credentialGrantScopes = ['fleet-ssh', 'kubeconfig'] as any;
    staleLegacy.credentialCustomGrantServices = ['legacy-host-plane'];

    expect(isPrivilegedK8sAgent(staleLegacy)).toBe(false);
    expect(computeAgentMcpConfigHash(staleLegacy)).toBe(computeAgentMcpConfigHash(ordinary));
    const manifest = renderAgentManifest(staleLegacy, {
      command: 'codex-bridge',
      model: 'gpt-5.6-sol',
      effort: 'high',
      contextPrompt: 'ctx',
      password: 'pw',
    });
    expect(manifest).toContain('serviceAccountName: default');
    expect(manifest).toContain('automountServiceAccountToken: false');
    expect(manifest).not.toContain('fleet-ssh-materialize');
    expect(manifest).not.toContain('kubeconfig-materialize');
  });

  it('PLAT-3625: drift hash is invariant to property ORDER (no Recreate-storm on semantically-equal Hive refreshes)', async () => {
    const { computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const a = agent('kai');
    a.executionMethod = 'shizuha';
    a.model = 'deepseek-v4-flash';
    a.modelOverrides = { shizuha: 'deepseek-v4-flash', codex_app_server: 'gpt-5.6-sol' } as any;
    a.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['engineering', 'it', 'platform'],
      skills: ['engineering'],
      eagerSkills: [],
      mcpServers: ['pulse', 'wiki', 'connect'],
      sourceTeams: ['engineering'],
      credentialGrantScopes: [],
      credentialCustomGrantServices: [],
      runtimeFlags: { alpha: '1', beta: '2' },
      diagnostics: [],
      appliedAt: '2026-07-12T00:00:00.000Z',
    } as any;

    // Same agent, but every set/dict re-emitted in a DIFFERENT order — exactly
    // what a Hive periodic-refresh does with unordered sets/dicts. APPLIED_AT
    // also bumps (it must stay excluded from the hash).
    const b = agent('kai');
    b.executionMethod = 'shizuha';
    b.model = 'deepseek-v4-flash';
    b.modelOverrides = { codex_app_server: 'gpt-5.6-sol', shizuha: 'deepseek-v4-flash' } as any;
    b.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['platform', 'engineering', 'it'],
      skills: ['engineering'],
      eagerSkills: [],
      mcpServers: ['connect', 'wiki', 'pulse'],
      sourceTeams: ['engineering'],
      credentialGrantScopes: [],
      credentialCustomGrantServices: [],
      runtimeFlags: { beta: '2', alpha: '1' },
      diagnostics: [],
      appliedAt: '2026-07-12T00:05:00.000Z',
    } as any;

    expect(computeAgentMcpConfigHash(a)).toBe(computeAgentMcpConfigHash(b));

    // A genuine CONTENT change must still drift the hash.
    const c = agent('kai');
    c.executionMethod = 'shizuha';
    c.model = 'deepseek-v4-flash';
    c.modelOverrides = { shizuha: 'deepseek-v4-flash', codex_app_server: 'gpt-5.6-sol' } as any;
    c.effectiveCapabilities = { ...(a.effectiveCapabilities as any), mcpServers: ['pulse', 'wiki', 'connect', 'books'] } as any;
    expect(computeAgentMcpConfigHash(c)).not.toBe(computeAgentMcpConfigHash(a));
  });

  it('reconciles privileged-to-ordinary downgrade by deleting only owned per-agent RBAC and SSH objects', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet persistentvolumeclaim downgrade-workspace -o name" ]]; then exit 1; fi
if [[ "$*" == "apply --dry-run=client -n test-fleet -f -" || "$*" == "apply -n test-fleet -f -" ]]; then cat >/dev/null; exit 0; fi
case "$*" in
  "get clusterrolebinding/agent-downgrade-ops --ignore-not-found=true -o json"|\
  "get -n test-fleet serviceaccount/agent-downgrade-ops --ignore-not-found=true -o json"|\
  "get -n test-fleet secret/downgrade-fleet-ssh --ignore-not-found=true -o json")
    printf '{"metadata":{"labels":{"app":"agent-downgrade","shizuha.io/runtime":"k3s-native"}}}'
    exit 0
    ;;
  "delete clusterrolebinding/agent-downgrade-ops --ignore-not-found=true"|\
  "delete -n test-fleet serviceaccount/agent-downgrade-ops --ignore-not-found=true"|\
  "delete -n test-fleet secret/downgrade-fleet-ssh --ignore-not-found=true") exit 0 ;;
esac
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const downgraded = agent('downgrade');
    downgraded.skills = ['engineering'];
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(downgraded, {
      command: 'gateway', model: 'cortex/qwen3', contextPrompt: 'ctx', password: 'pw',
    });

    const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(calls).toContain('delete clusterrolebinding/agent-downgrade-ops --ignore-not-found=true');
    expect(calls).toContain('delete -n test-fleet serviceaccount/agent-downgrade-ops --ignore-not-found=true');
    expect(calls).toContain('delete -n test-fleet secret/downgrade-fleet-ssh --ignore-not-found=true');
  });

  it('fails closed when a downgrade ownership lookup is forbidden', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get -n test-fleet persistentvolumeclaim downgrade-forbidden-workspace -o name" ]]; then exit 1; fi
if [[ "$*" == "apply --dry-run=client -n test-fleet -f -" || "$*" == "apply -n test-fleet -f -" ]]; then cat >/dev/null; exit 0; fi
if [[ "$*" == "get clusterrolebinding/agent-downgrade-forbidden-ops --ignore-not-found=true -o json" ]]; then
  echo 'Error from server (Forbidden): clusterrolebindings.rbac.authorization.k8s.io is forbidden' >&2
  exit 1
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const downgraded = agent('downgrade-forbidden');
    downgraded.skills = ['engineering'];
    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');

    expect(() => spawnAgentK8s(downgraded, {
      command: 'gateway', model: 'cortex/qwen3', contextPrompt: 'ctx', password: 'pw',
    })).toThrow(/Forbidden/);
  });

  it('renders new agent workspace PVCs at the 10Gi fleet baseline', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(agent('workspace-baseline'), {
      command: 'gateway', model: 'cortex/qwen3', contextPrompt: 'ctx', password: 'pw',
    });

    expect(manifest).toContain('name: workspace-baseline-workspace');
    expect(manifest).toContain('resources: { requests: { storage: 10Gi } }');
    expect(manifest).not.toContain('resources: { requests: { storage: 5Gi } }');
  });

  it('keeps privileged k8s-incompatible agents out of the runtime reconcile k8s start set', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf-8');
    expect(source).toContain('desiredAgents.filter((a) => shouldSpawnK8sAgent(a)).map((a) => a.id)');
    expect(source).toContain('falling back to daemon-owned container runtime (PLAT-3366)');
    expect(source).toContain('updateAgentConfig(agent.id, { runtimeEnvironment: \'container\' })');
    expect(source).toContain('stopAgentK8s({ ...agent, runtimeEnvironment: \'k8s\' })');
  });

  it('routes restartAgent through the k8s backend for k8s-native agents', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf-8');
    const restart = source.slice(
      source.indexOf('export async function restartAgent(agentId: string): Promise<void>'),
      source.indexOf('/**\n * Clear an agent\'s durable runtime session'),
    );
    expect(restart).toContain('if (agent && isK8sAgent(agent))');
    expect(restart).toContain('await restartAgentK8s(agent)');

    const dashboard = fs.readFileSync(path.join(process.cwd(), 'src/daemon/dashboard.ts'), 'utf-8');
    const route = dashboard.slice(
      dashboard.indexOf('export function registerAgentRestartRoute'),
      dashboard.indexOf('function primaryExecutionMethod'),
    );
    expect(route.indexOf('if (resolved && isK8sAgent(resolved))')).toBeLessThan(
      route.indexOf('if (!deps.isAgentRunning(id))'),
    );
    expect(route).toContain('await deps.restartAgent(resolved.id)');
    expect(route).toContain('reply.status(502)');
  });

  it('renders broker readyz as a Kubernetes readiness signal for alerting', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/fleet/k8s-backend.ts'), 'utf-8');
    const broker = source.indexOf('        - name: broker');
    const agentContainer = source.indexOf('        - name: agent', broker);
    const block = source.slice(broker, agentContainer);
    expect(block).toContain('readinessProbe:');
    expect(block).toContain('"/mcp-auth-proxy", "healthcheck"');
    expect(block).toContain('"--ready"');
  });
  it('renders bridge agents with the higher memory profile used by docker-era agents', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(agent('jun'), {
      command: 'claude-bridge',
      model: 'cortex/DeepSeek-V4-Flash',
      contextPrompt: 'ctx',
      password: 'pw',
    });

    const agentContainer = manifest.slice(manifest.indexOf('        - name: agent'));
    expect(agentContainer).toContain('limits: { cpu: "2", memory: 12Gi }');
  });

  it('gives gateway / cortex agents a generous memory profile (SCLI-248 OOM fix)', async () => {
    // SCLI-248 raised gateway/cortex agents off the 2Gi floor after they
    // OOMKilled under real workloads (agentContainerResources, k8s-backend.ts).
    // The 2Gi floor now applies only to genuinely tiny sidecars, which do not
    // route through renderAgentManifest.
    //
    // Raised again 2026-08-05 (6Gi -> 8Gi): the limit was never the binding
    // constraint, because Node caps its own heap near 4GB regardless. The pod
    // limit and the rendered NODE_OPTIONS ceiling now move together.
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(agent('qwen'), {
      command: 'gateway',
      model: 'cortex/Qwen3.6-27B-NVFP4',
      contextPrompt: 'ctx',
      password: 'pw',
    });

    const agentContainer = manifest.slice(manifest.indexOf('        - name: agent'));
    expect(agentContainer).toContain('limits: { cpu: "2", memory: 8Gi }');
  });

  it('forwards agent-store SCLI-195 / idle-heartbeat tuning env into k8s pods', async () => {
    // agent.env was stored by Hive/runtime PATCH but never rendered into the
    // Deployment — pods kept expensive-turn defaults and false-paused under
    // large MCP context (2026-07-09). PROMPT_TOKENS is numeric, not a secret.
    const { renderAgentManifest, agentTuningEnv, computeAgentMcpConfigHash } =
      await import('../../src/daemon/k8s-backend.js');
    const tuned = {
      ...agent('san'),
      env: {
        SHIZUHA_IDLE_HEARTBEAT_MS: '900000',
        SHIZUHA_EXPENSIVE_TURN_MIN_TURNS: '6',
        SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS: '200000',
        SHIZUHA_EXPENSIVE_TURN_WINDOW_MS: '120000',
        SHIZUHA_EXPENSIVE_TURN_BACKOFF_MS: '180000',
        SHIZUHA_EXPENSIVE_TURN_MAX_BACKOFF_MS: '600000',
        SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS: '80000',
        GITHUB_TOKEN: 'should-not-appear',
      },
    };
    const tuning = agentTuningEnv(tuned as any);
    expect(tuning.SHIZUHA_EXPENSIVE_TURN_MIN_TURNS).toBe('6');
    expect(tuning.SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS).toBe('200000');
    expect(tuning.SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS).toBe('80000');
    expect(tuning).not.toHaveProperty('GITHUB_TOKEN');

    const manifest = renderAgentManifest(tuned as any, {
      command: 'gateway',
      model: 'cortex/grok-4.5',
      contextPrompt: 'ctx',
      password: 'pw',
    });
    expect(manifest).toContain('SHIZUHA_EXPENSIVE_TURN_MIN_TURNS');
    expect(manifest).toContain('"6"');
    expect(manifest).toContain('SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS');
    expect(manifest).toContain('"200000"');
    expect(manifest).toContain('SHIZUHA_IDLE_HEARTBEAT_MS');
    expect(manifest).toContain('SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS');
    expect(manifest).toContain('"80000"');
    // Secrets must stay on secretKeyRef path, not plain agent.env dump.
    expect(manifest).not.toContain('should-not-appear');

    const bare = agent('san');
    expect(computeAgentMcpConfigHash(tuned as any)).not.toBe(computeAgentMcpConfigHash(bare as any));
  });


  it('routes dashboard pause for k8s-native agents before daemon-local running checks', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/daemon/dashboard.ts'), 'utf-8');
    const route = source.indexOf("'/v1/agents/:id/pause'");
    const k8sBranch = source.indexOf('if (isK8sAgent(agent))', route);
    const localRunningCheck = source.indexOf('if (!isAgentRunning(agent.id))', route);

    expect(route).toBeGreaterThan(-1);
    expect(k8sBranch).toBeGreaterThan(route);
    expect(k8sBranch).toBeLessThan(localRunningCheck);
    expect(source.slice(k8sBranch, localRunningCheck)).toContain('pauseK8sAgent(agent.id)');
  });

  it('surfaces k8s live-tail fallback as an explicit degraded activity marker', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/daemon/dashboard.ts'), 'utf-8');
    const route = source.indexOf("'/v1/agents/:agentId/activity'");
    const routeBlock = source.slice(route, source.indexOf("'/v1/agents/heartbeat-outcomes'", route));

    expect(route).toBeGreaterThan(-1);
    expect(routeBlock).toContain('readK8sAgentSessionTailStatus');
    expect(routeBlock).toContain('degraded: true');
    expect(routeBlock).toContain('liveTailUnavailable');
  });
});

// ── PLAT-4027: gh-auth probe target-set scoping ──

describe('PLAT-4027: gh-auth probe scopes to enabled + active agents', () => {
  it('skips eligible-but-disabled agents so they do not page deployment_unready', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const akira = { ...agentWithGithub('akira'), status: 'active' as const };
    const misaki = { ...agentWithGithub('misaki'), status: 'disabled' as const };
    const enabledIds = new Set([akira.id]);
    const results = probeK8sGithubCredentialHealth([akira, misaki], [], enabledIds);
    expect(results.map((r) => r.username)).toEqual(['akira']);
    expect(results[0]).toEqual(expect.objectContaining({
      ok: false,
      reason: 'deployment_unready',
      detail: 'Deployment not found (inventory=0/2)',
    }));
  });

  // PLAT-4958 root cause: on 2026-07-21 the daemon paged 8 agents in one burst;
  // all 8 had a ReplicaSet created in the preceding 6 seconds, and none was
  // impaired. A Deployment mid-rollout reports ready=0/available=0 with the SAME
  // replica counts as a broken one, so the counts cannot discriminate — only the
  // Progressing condition can.
  it('does not probe (or page) an agent whose Deployment is mid-rollout', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const haru = agentWithGithub('haru');
    const rolling = {
      agentId: haru.id,
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      updatedReplicas: 1,
      generation: 8,
      observedGeneration: 8,
      progressingReason: 'ReplicaSetUpdated',
      progressingUpdatedAtMs: Date.now() - 5_000, // 5s into the rollout
    };
    expect(probeK8sGithubCredentialHealth([haru], [rolling])).toEqual([]);
  });

  // PLAT-5120 production order: the daemon applies a capability/config refresh,
  // then the periodic top-level credential probe can run more than once while
  // the single Recreate replacement is still starting.  Kubernetes may already
  // call that generation settled, so only the daemon-owned apply boundary can
  // distinguish this from an unrelated outage.  Exercise two real probe calls,
  // then the expiry/reset boundary; a helper-only test would miss re-arming.
  it('suppresses repeated top-level probe cycles only inside a recent daemon-owned apply window', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse('2026-07-22T06:48:00Z');
      vi.setSystemTime(startedAt);
      const {
        K8S_ROLLOUT_SUPPRESS_WINDOW_MS,
        noteK8sDaemonApply,
        probeK8sGithubCredentialHealth,
      } = await import('../../src/daemon/k8s-backend.js');
      const haru = agentWithGithub('haru');
      const recreateStarting = {
        agentId: haru.id,
        username: 'haru',
        name: 'agent-haru',
        replicas: 1,
        readyReplicas: 0,
        availableReplicas: 0,
        updatedReplicas: 1,
        generation: 632,
        observedGeneration: 632,
        // Live PLAT-5120 counterexample: the condition can still describe the
        // previous settled rollout while the Recreate replacement boots.
        progressingReason: 'NewReplicaSetAvailable',
      };

      noteK8sDaemonApply(haru.id);
      expect(probeK8sGithubCredentialHealth([haru], [recreateStarting])).toEqual([]);
      vi.setSystemTime(startedAt + 30_000);
      expect(probeK8sGithubCredentialHealth([haru], [recreateStarting])).toEqual([]);

      vi.setSystemTime(startedAt + K8S_ROLLOUT_SUPPRESS_WINDOW_MS + 1);
      expect(probeK8sGithubCredentialHealth([haru], [recreateStarting])).toEqual([
        expect.objectContaining({
          username: 'haru',
          ok: false,
          reason: 'deployment_unready',
          detail: expect.stringContaining('generation=632, observedGeneration=632'),
        }),
      ]);

      // A later daemon apply is a new bounded operation, not stale suppression.
      noteK8sDaemonApply(haru.id);
      expect(probeK8sGithubCredentialHealth([haru], [recreateStarting])).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // PLAT-4958 review (aoi): `Progressing.reason` stays ReplicaSetUpdated for the
  // whole rollout and only flips at progressDeadlineSeconds — 600s on every agent
  // Deployment. An unbounded guard would make a genuinely broken new pod silent
  // for ten minutes. These two cases are the bound, and the second is the control:
  // without it, a guard that suppressed forever would still pass the case above.
  it('DOES page a Deployment stuck mid-rollout past the suppression window', async () => {
    const { probeK8sGithubCredentialHealth, K8S_ROLLOUT_SUPPRESS_WINDOW_MS } =
      await import('../../src/daemon/k8s-backend.js');
    const haru = agentWithGithub('haru');
    const stuckRolling = {
      agentId: haru.id,
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      updatedReplicas: 1,
      generation: 8,
      observedGeneration: 8,
      progressingReason: 'ReplicaSetUpdated',
      progressingUpdatedAtMs: Date.now() - (K8S_ROLLOUT_SUPPRESS_WINDOW_MS + 30_000),
    };
    expect(probeK8sGithubCredentialHealth([haru], [stuckRolling])).toEqual([
      expect.objectContaining({ username: 'haru', ok: false, reason: 'deployment_unready' }),
    ]);
  });

  it('fails closed and pages when the rollout timestamp is missing or unparseable', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const haru = agentWithGithub('haru');
    const noTimestamp = {
      agentId: haru.id,
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      updatedReplicas: 1,
      generation: 8,
      observedGeneration: 8,
      progressingReason: 'ReplicaSetUpdated',
      // progressingUpdatedAtMs deliberately absent
    };
    expect(probeK8sGithubCredentialHealth([haru], [noTimestamp])).toEqual([
      expect.objectContaining({ username: 'haru', ok: false, reason: 'deployment_unready' }),
    ]);
  });

  it('suppresses the probe while the controller has not yet observed a new spec', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const haru = agentWithGithub('haru');
    const unobserved = {
      agentId: haru.id,
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      generation: 9,
      observedGeneration: 8,
      progressingReason: 'NewReplicaSetAvailable',
      // no progressingUpdatedAtMs: the observedGeneration branch must not need it
    };
    expect(probeK8sGithubCredentialHealth([haru], [unobserved])).toEqual([]);
  });

  // KNOWN-GOOD CONTROL. Without this, a guard that suppressed EVERYTHING would
  // still pass the two tests above. A settled Deployment with no ready replica is
  // a real fault and must still page.
  it('still pages deployment_unready for a settled Deployment with no ready replica', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const haru = agentWithGithub('haru');
    const settledButDown = {
      agentId: haru.id,
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      updatedReplicas: 1,
      generation: 8,
      observedGeneration: 8,
      progressingReason: 'NewReplicaSetAvailable',
    };
    expect(probeK8sGithubCredentialHealth([haru], [settledButDown])).toEqual([
      expect.objectContaining({ username: 'haru', ok: false, reason: 'deployment_unready' }),
    ]);
  });

  // A rollout that has blown its progress deadline is stuck, not in flight.
  it('still pages when a rollout has exceeded its progress deadline', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const haru = agentWithGithub('haru');
    const stuck = {
      agentId: haru.id,
      username: 'haru',
      name: 'agent-haru',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
      updatedReplicas: 1,
      generation: 8,
      observedGeneration: 8,
      progressingReason: 'ProgressDeadlineExceeded',
    };
    expect(probeK8sGithubCredentialHealth([haru], [stuck])).toEqual([
      expect.objectContaining({ username: 'haru', ok: false, reason: 'deployment_unready' }),
    ]);
  });


  it('also skips enabled agents whose status is not active (e.g. paused)', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const paused = { ...agentWithGithub('akira'), status: 'paused' as const };
    const results = probeK8sGithubCredentialHealth([paused], [], new Set([paused.id]));
    expect(results).toEqual([]);
  });

  it('without enabledIds (legacy 2-arg) leaves the target set unscoped', async () => {
    const { probeK8sGithubCredentialHealth } = await import('../../src/daemon/k8s-backend.js');
    const a = { ...agentWithGithub('haru'), status: 'disabled' as const };
    const results = probeK8sGithubCredentialHealth([a], []);
    expect(results.map((r) => r.reason)).toEqual(['deployment_unready']);
  });
});

// ── PLAT-3625: MCP/capability config materialization + drift hash ──

describe('PLAT-3625 MCP config env + hash', () => {
  it('renders the effective MCP allow-list env and config-hash annotations into the manifest', async () => {
    const { renderAgentManifest, computeAgentMcpConfigHash, MCP_CONFIG_HASH_ANNOTATION } =
      await import('../../src/daemon/k8s-backend.js');
    const k8sAgent = agent('nao');
    k8sAgent.mcpServers = [{ name: 'books', slug: 'books' } as never];
    k8sAgent.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['accounting', 'product'],
      sourceTeams: ['accounting'],
      mcpServers: ['admin', 'books', 'connect', 'drive', 'id', 'pulse', 'wiki'],
      runtimeFlags: {},
      diagnostics: [],
    } as never;

    const manifest = renderAgentManifest(k8sAgent, {
      command: 'claude-bridge', model: 'm', contextPrompt: 'ctx', password: 'pw',
    });

    // The pod gets the union allow-list (explicit + hive), so the bridge's
    // .mcp.json compose includes newly granted services (BKS-48 class).
    expect(manifest).toContain('name: AGENT_EFFECTIVE_MCP_SERVICES, value: "admin,books,connect,drive,id,pulse,wiki"');
    expect(manifest).toContain('name: AGENT_EFFECTIVE_CAPABILITIES, value: "accounting,product"');
    // Hash stamped on BOTH the Deployment (cheap drift listing) and the pod
    // template (annotation-only change still rolls the pod under Recreate).
    const hash = computeAgentMcpConfigHash(k8sAgent);
    const stamped = manifest.split(`${MCP_CONFIG_HASH_ANNOTATION}: ${JSON.stringify(hash)}`).length - 1;
    expect(stamped).toBe(2);
  });

  it('omits the allow-list env for agents with no grants (role-matrix fallback preserved)', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(agent('bare'), {
      command: 'claude-bridge', model: 'm', contextPrompt: 'ctx', password: 'pw',
    });
    expect(manifest).not.toContain('AGENT_EFFECTIVE_MCP_SERVICES');
  });

  it('hash changes when a service is granted and is stable across renders', async () => {
    const { computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const before = agent('nao');
    before.mcpServers = [{ name: 'pulse', slug: 'pulse' } as never];
    const after = agent('nao');
    after.mcpServers = [{ name: 'pulse', slug: 'pulse' } as never, { name: 'books', slug: 'books' } as never];

    expect(computeAgentMcpConfigHash(before)).toBe(computeAgentMcpConfigHash(before));
    expect(computeAgentMcpConfigHash(before)).not.toBe(computeAgentMcpConfigHash(after));
  });

  it('hash ignores volatile effective-capability appliedAt telemetry', async () => {
    const { computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const before = agent('nao');
    before.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['engineering'],
      skills: [],
      eagerSkills: [],
      mcpServers: ['admin', 'pulse'],
      sourceTeams: ['engineering'],
      credentialGrantScopes: [],
      credentialCustomGrantServices: [],
      runtimeFlags: {},
      diagnostics: [],
      catalogVersion: 4,
      appliedAt: '2026-07-05T00:00:00.000Z',
    };
    const after = agent('nao');
    after.effectiveCapabilities = {
      ...before.effectiveCapabilities,
      appliedAt: '2026-07-05T00:01:00.000Z',
    };

    expect(computeAgentMcpConfigHash(after)).toBe(computeAgentMcpConfigHash(before));
  });

  it('PLAT-4546: hashes only versioned semantic inputs while diagnostics remain rendered', async () => {
    const {
      computeAgentMcpConfigHash,
      renderAgentManifest,
      MCP_CONFIG_HASH_SCHEMA_VERSION,
    } = await import('../../src/daemon/k8s-backend.js');
    const base = agent('revi');
    base.executionMethod = 'shizuha';
    base.model = 'cortex/DeepSeek-V4-Flash';
    base.modelFallbacks = [{ method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash', reasoningEffort: 'high' }];
    base.skills = ['review'];
    base.eagerSkills = ['pulse-core'];
    base.credentialGrantScopes = ['github:review'] as any;
    base.credentialCustomGrantServices = ['github'];
    base.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['review'],
      skills: ['review'],
      eagerSkills: ['pulse-core'],
      mcpServers: ['admin', 'connect', 'id', 'pulse', 'wiki'],
      sourceTeams: ['review'],
      credentialGrantScopes: ['github:review'],
      credentialCustomGrantServices: ['github'],
      runtimeFlags: { provider: 'cortex', stream: true },
      diagnostics: [{ severity: 'info', code: 'qualified_credential_scope', message: 'Normalized github:review' }],
      catalogVersion: 6,
      computedAt: '2026-07-12T21:00:00.000Z',
      appliedAt: '2026-07-12T21:00:01.000Z',
    } as any;

    const diagnosticOnly = structuredClone(base);
    diagnosticOnly.effectiveCapabilities = {
      ...diagnosticOnly.effectiveCapabilities!,
      diagnostics: [
        { severity: 'info', code: 'hive_diagnostic', message: 'daemon capability roster snapshot' },
        { severity: 'warning', code: 'new_text', message: 'explanation changed but effective access did not' },
      ],
      computedAt: '2026-07-12T21:05:00.000Z',
      appliedAt: '2026-07-12T21:05:01.000Z',
      catalogVersion: 999,
      definitionVersion: 'transport-only-v9',
      sourceAttribution: { roster: 'different-diagnostic-source' },
    } as any;

    expect(MCP_CONFIG_HASH_SCHEMA_VERSION).toBe(2);
    expect(computeAgentMcpConfigHash(diagnosticOnly)).toBe(computeAgentMcpConfigHash(base));

    const baseManifest = renderAgentManifest(base, {
      command: 'gateway', model: base.model!, contextPrompt: 'ctx', password: 'pw',
    });
    const diagnosticManifest = renderAgentManifest(diagnosticOnly, {
      command: 'gateway', model: diagnosticOnly.model!, contextPrompt: 'ctx', password: 'pw',
    });
    expect(baseManifest).toContain('AGENT_EFFECTIVE_CAPABILITY_DIAGNOSTICS');
    expect(diagnosticManifest).toContain('hive_diagnostic');
    expect(diagnosticManifest).not.toBe(baseManifest);
  });

  it('PLAT-4546: every reviewed semantic class changes the hash', async () => {
    const { computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const base = agent('revi');
    base.executionMethod = 'shizuha';
    base.model = 'cortex/DeepSeek-V4-Flash';
    base.modelFallbacks = [{ method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash' }];
    base.skills = ['review'];
    base.credentialGrantScopes = ['github:review'] as any;
    base.credentialCustomGrantServices = ['github'];
    base.env = { SHIZUHA_IDLE_HEARTBEAT_MS: '900000' };
    base.effectiveCapabilities = {
      source: 'hive',
      capabilities: ['review'],
      skills: ['review'],
      eagerSkills: [],
      mcpServers: ['pulse', 'wiki'],
      sourceTeams: ['review'],
      credentialGrantScopes: ['github:review'],
      credentialCustomGrantServices: ['github'],
      runtimeFlags: { provider: 'cortex' },
      diagnostics: [],
      appliedAt: '2026-07-12T21:00:00.000Z',
    } as any;
    const baseHash = computeAgentMcpConfigHash(base);
    const mutate = (fn: (copy: typeof base) => void) => {
      const copy = structuredClone(base);
      fn(copy);
      return computeAgentMcpConfigHash(copy);
    };

    const semanticMutations = {
      mcpGrant: mutate((copy) => { copy.mcpServers.push({ name: 'books', slug: 'books' } as any); }),
      capability: mutate((copy) => { copy.effectiveCapabilities!.capabilities.push('platform'); }),
      sourceTeam: mutate((copy) => { copy.effectiveCapabilities!.sourceTeams.push('platform'); }),
      skillGrant: mutate((copy) => { copy.effectiveCapabilities!.skills.push('devops'); }),
      eagerSkill: mutate((copy) => { copy.effectiveCapabilities!.eagerSkills = ['shipping-prs']; }),
      credentialScope: mutate((copy) => { copy.effectiveCapabilities!.credentialGrantScopes!.push('kubeconfig'); }),
      customCredentialService: mutate((copy) => { copy.effectiveCapabilities!.credentialCustomGrantServices!.push('forgejo'); }),
      payloadReadScope: mutate((copy) => { copy.credentialPayloadReadScopes = ['github:token'] as any; }),
      brokerPeerUid: mutate((copy) => { copy.credentialBrokerPeerUid = 1001; }),
      runtimeFlag: mutate((copy) => { copy.effectiveCapabilities!.runtimeFlags = { provider: 'cortex', stream: true }; }),
      modelChain: mutate((copy) => { copy.modelFallbacks!.push({ method: 'codex_app_server', model: 'gpt-5.6' }); }),
      modelOverride: mutate((copy) => { copy.modelOverrides = { shizuha: 'cortex/Qwen3.5' }; }),
      failoverChain: mutate((copy) => { copy.failoverChainId = 'review-failover'; }),
      runtimeLaneGeneration: mutate((copy) => { copy.runtimeLaneGeneration = 2; }),
      runtimeLaneDigest: mutate((copy) => { copy.runtimeLaneDigest = 'lane-digest-v2'; }),
      tuning: mutate((copy) => { copy.env!.SHIZUHA_IDLE_HEARTBEAT_MS = '600000'; }),
    };
    for (const [name, hash] of Object.entries(semanticMutations)) {
      expect(hash, name).not.toBe(baseHash);
    }

    const previousSearch = process.env['SEARCH_BASE_URL'];
    try {
      process.env['SEARCH_BASE_URL'] = 'http://search-v1';
      const platformV1 = computeAgentMcpConfigHash(base);
      process.env['SEARCH_BASE_URL'] = 'http://search-v2';
      expect(computeAgentMcpConfigHash(base)).not.toBe(platformV1);
    } finally {
      if (previousSearch === undefined) delete process.env['SEARCH_BASE_URL'];
      else process.env['SEARCH_BASE_URL'] = previousSearch;
    }
  });

  it('PLAT-4546: hashes exact resolved render authority and final merged env', async () => {
    const { computeAgentMcpConfigHash, renderAgentManifest, MCP_CONFIG_HASH_ANNOTATION } =
      await import('../../src/daemon/k8s-backend.js');
    const base = agent('revi-resolved');
    base.env = { SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '90000' };
    const resolved = {
      command: 'gateway', model: 'cortex/DeepSeek-V4-Flash', effort: 'low',
      contextPrompt: 'rendered prompt one',
    };
    const hash = computeAgentMcpConfigHash(base, resolved);
    for (const [name, changed] of Object.entries({
      command: { ...resolved, command: 'codex-bridge' },
      model: { ...resolved, model: 'gpt-5.6' },
      effort: { ...resolved, effort: 'high' },
      contextPrompt: { ...resolved, contextPrompt: 'rendered prompt two' },
    })) {
      expect(computeAgentMcpConfigHash(structuredClone(base), changed), name).not.toBe(hash);
    }

    const manifest = renderAgentManifest(base, { ...resolved, password: 'pw' });
    expect(manifest).toContain(`${MCP_CONFIG_HASH_ANNOTATION}: "${hash}"`);

    const previous = process.env['SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS'];
    try {
      process.env['SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS'] = '80000';
      const platformV1 = computeAgentMcpConfigHash(base, resolved);
      process.env['SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS'] = '70000';
      expect(computeAgentMcpConfigHash(base, resolved)).toBe(platformV1);
    } finally {
      if (previous === undefined) delete process.env['SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS'];
      else process.env['SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS'] = previous;
    }
  });

  it('PLAT-4546: normalizes every set family but preserves fallback order', async () => {
    const { computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const a = agent('revi-normalized');
    a.skills = ['review', 'devops'];
    a.eagerSkills = ['pulse-core', 'shipping-prs'];
    a.credentialGrantScopes = ['github:review', 'kubeconfig'] as any;
    a.credentialCustomGrantServices = ['github', 'forgejo'];
    a.credentialPayloadReadScopes = ['github:token', 'forgejo:token'] as any;
    a.modelFallbacks = [
      { method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash' },
      { method: 'codex_app_server', model: 'gpt-5.6' },
    ];
    a.effectiveCapabilities = {
      source: 'hive', capabilities: ['review', 'platform'], skills: [], eagerSkills: [],
      mcpServers: ['pulse', 'wiki'], sourceTeams: ['review', 'platform'],
      credentialGrantScopes: [], credentialCustomGrantServices: [],
      runtimeFlags: { nested: { b: 2, a: 1 } }, diagnostics: [],
    } as any;
    const b = structuredClone(a);
    b.skills = ['devops', 'review', 'review'];
    b.eagerSkills = ['shipping-prs', 'pulse-core', 'pulse-core'];
    b.credentialGrantScopes = ['kubeconfig', 'github:review', 'github:review'] as any;
    b.credentialCustomGrantServices = ['forgejo', 'github', 'github'];
    b.credentialPayloadReadScopes = ['forgejo:token', 'github:token', 'github:token'] as any;
    b.effectiveCapabilities!.capabilities = ['platform', 'review', 'review'];
    b.effectiveCapabilities!.sourceTeams = ['platform', 'review', 'review'];
    b.effectiveCapabilities!.runtimeFlags = { nested: { a: 1, b: 2 } };
    expect(computeAgentMcpConfigHash(b)).toBe(computeAgentMcpConfigHash(a));

    const reversed = structuredClone(a);
    reversed.modelFallbacks!.reverse();
    expect(computeAgentMcpConfigHash(reversed)).not.toBe(computeAgentMcpConfigHash(a));
  });

  it('PLAT-4546: diagnostic-only cycles stay quiet; real drift applies exactly once then converges', async () => {
    const { computeAgentMcpConfigHash } = await import('../../src/daemon/k8s-backend.js');
    const { computeRuntimeReconcilePlan } = await import('../../src/daemon/state.js');
    const desired = agent('revi');
    desired.effectiveCapabilities = {
      source: 'hive', capabilities: ['review'], skills: ['review'], eagerSkills: [],
      mcpServers: ['pulse', 'wiki'], sourceTeams: ['review'], credentialGrantScopes: [],
      credentialCustomGrantServices: [], runtimeFlags: {}, diagnostics: [],
      appliedAt: '2026-07-12T21:00:00.000Z',
    } as any;
    const renderedDiagnosticVariant = structuredClone(desired);
    renderedDiagnosticVariant.effectiveCapabilities!.diagnostics = [
      { severity: 'info', code: 'hive_diagnostic', message: 'roster snapshot' },
    ];
    renderedDiagnosticVariant.effectiveCapabilities!.appliedAt = '2026-07-12T21:01:00.000Z';

    const liveHash = computeAgentMcpConfigHash(desired);
    const plan = (wantedHash: string, observedHash: string) => computeRuntimeReconcilePlan(
      [{ agentId: desired.id, backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: observedHash }],
      new Set([desired.id]), new Map([[desired.id, 'active' as const]]), new Set([desired.id]),
      new Map([[desired.id, wantedHash]]),
    );

    const diagnosticHash = computeAgentMcpConfigHash(renderedDiagnosticVariant);
    expect(plan(diagnosticHash, liveHash).toRefreshK8s).toEqual([]);
    expect(plan(diagnosticHash, liveHash).toRefreshK8s).toEqual([]); // independent second cycle

    const realDrift = structuredClone(renderedDiagnosticVariant);
    realDrift.effectiveCapabilities!.mcpServers.push('books');
    realDrift.mcpServers.push({ name: 'books', slug: 'books' } as any);
    const driftHash = computeAgentMcpConfigHash(realDrift);
    expect(plan(driftHash, liveHash).toRefreshK8s).toEqual([desired.id]);
    expect(plan(driftHash, driftHash).toRefreshK8s).toEqual([]);
  });
});

describe('HIVE-553: manifest YAML validity — block-scalar indentation regression', () => {
  let tmp: string;
  let oldPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kubectl-'));
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

  function fallbackAgent(username = 'hiro'): AgentInfo {
    const a = agent(username);
    a.modelFallbacks = [
      { method: 'claude_code_server', model: 'claude-opus-4-8' },
      { method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash', reasoningEffort: 'high' },
    ] as never;
    return a;
  }

  it('renders NO line below the block-scalar indent inside the agent args (the exact HIVE-553 break)', async () => {
    const { renderAgentManifest } = await import('../../src/daemon/k8s-backend.js');
    const manifest = renderAgentManifest(fallbackAgent(), {
      command: 'claude-bridge', model: 'claude-opus-4-8', contextPrompt: 'ctx', password: 'pw',
    });

    const lines = manifest.split('\n');
    const start = lines.findIndex((l) => l.trimEnd().endsWith('- |'));
    expect(start).toBeGreaterThan(-1);
    const scalarIndent = 14; // args block scalar body indent in the template
    const offenders: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      if (indent < scalarIndent - 2) break; // reached the next mapping key (env:)
      if (indent < scalarIndent) offenders.push(`${i + 1}: ${line}`);
    }
    // Any offender terminates the YAML block scalar mid-script — kubectl apply
    // then fails with "could not find expected ':'" (HIVE-553).
    expect(offenders).toEqual([]);
    expect(manifest).not.toContain("<<'NODE'");
  });

  it('ships the step-selection script base64-encoded and semantically intact', async () => {
    const { renderK8sInlineFailoverEntrypoint } = await import('../../src/daemon/k8s-backend.js');
    const entry = renderK8sInlineFailoverEntrypoint('/run/shizuha/agent-context/CONTEXT_PROMPT');

    const m = entry.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| node - "\$failover_index"/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, 'base64').toString('utf8');
    expect(decoded).toContain('SHIZUHA_MODEL_FALLBACKS');
    expect(decoded).toContain('commandByMethod');
    expect(decoded).toContain('claude_code_server');
    expect(decoded).toContain("join('\t')");
    for (const line of entry.split('\n')) {
      if (line.trim() === '') continue;
      expect(line.startsWith('              ')).toBe(true);
    }
  });

  it('restores failover_index from the shared mount after an agent-container restart', async () => {
    const { renderK8sInlineFailoverEntrypoint } = await import('../../src/daemon/k8s-backend.js');
    const indexFile = path.join(tmp, 'failover-index');
    const runtime = path.join(tmp, 'runtime-entrypoint');
    const curl = path.join(tmp, 'curl');
    fs.writeFileSync(indexFile, '1');
    fs.writeFileSync(runtime, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*"\nexit 0\n');
    fs.writeFileSync(curl, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(runtime, 0o755);
    fs.chmodSync(curl, 0o755);
    const entry = renderK8sInlineFailoverEntrypoint('/context', {
      failoverIndexFile: indexFile,
      runtimeEntrypoint: runtime,
    });
    // This test exercises failover-index persistence, not tini packaging.
    // Coordinator/CI hosts are not required to install the runtime image's
    // absolute /usr/bin/tini binary, so execute the rendered child command
    // directly while preserving its argv.
    const script = entry
      .split('\n')
      .map((line) => line.slice(14))
      .join('\n')
      .replace('/usr/bin/tini -s --', 'env --');
    const run = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH ?? ''}`,
        AGENT_ID: 'hiro-id', AGENT_NAME: 'hiro', AGENT_USERNAME: 'hiro',
        SHIZUHA_K8S_PRIMARY_METHOD: 'claude_code_server',
        SHIZUHA_K8S_PRIMARY_COMMAND: 'claude-bridge',
        SHIZUHA_K8S_PRIMARY_MODEL: 'claude-opus-4-8',
        SHIZUHA_MODEL_FALLBACKS: JSON.stringify([
          { method: 'claude_code_server', model: 'claude-opus-4-8' },
          { method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash' },
        ]),
      },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`restored failover_index=1 from ${indexFile}`);
    expect(run.stdout).toContain('k8s-inline-failover step=1 command=gateway model=cortex/DeepSeek-V4-Flash');
    expect(run.stdout).toContain('--model cortex/DeepSeek-V4-Flash');
  });

  it('backs off instead of tight-looping when every configured step is invalid', async () => {
    const { renderK8sInlineFailoverEntrypoint } = await import('../../src/daemon/k8s-backend.js');
    const curl = path.join(tmp, 'curl');
    fs.writeFileSync(curl, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(curl, 0o755);
    const entry = renderK8sInlineFailoverEntrypoint('/context', {
      failoverIndexFile: path.join(tmp, 'all-invalid-index'),
      initialBackoffSeconds: 1,
    });
    const script = [
      'sleep() { printf "sleep-called:%s\\n" "$1"; exit 99; }',
      entry.split('\n').map((line) => line.slice(14)).join('\n'),
    ].join('\n');
    const run = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH ?? ''}`,
        AGENT_ID: 'bad-id', AGENT_NAME: 'bad', AGENT_USERNAME: 'bad',
        SHIZUHA_K8S_PRIMARY_COMMAND: 'gateway',
        SHIZUHA_K8S_PRIMARY_MODEL: 'claude-opus-4-8',
        SHIZUHA_MODEL_FALLBACKS: JSON.stringify([
          { method: 'shizuha', model: 'claude-opus-4-8' },
          { method: 'shizuha', model: 'gpt-5.5' },
        ]),
      },
    });

    expect(run.status).toBe(99);
    expect(run.stdout).toContain('MISCONFIG step=0');
    expect(run.stdout).toContain('MISCONFIG step=1');
    expect(run.stdout).toContain('all steps invalid; backing off 1s');
    expect(run.stdout).toContain('sleep-called:1');
  });

  it('spawnAgentK8s validates with --dry-run=client first and never live-applies an invalid manifest', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == *"--dry-run=client"* ]]; then
  # SCLI-307: this simulated dry-run rejection is EXPECTED — the test below
  # asserts the daemon refuses to live-apply an invalid manifest. The
  # [expected-test-stderr] marker stops reviewers from misreading this
  # negative-path stderr in the CI log as a real full-suite gate failure
  # (the recurring ORIG-65/PLAT-3987 mis-waive).
  echo "[expected-test-stderr] simulated invalid-manifest dry-run rejection: error converting YAML to JSON: yaml: line 80: could not find expected ':'" >&2
  exit 1
fi
exit 0
`);
    fs.chmodSync(kubectl, 0o755);

    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    expect(() =>
      spawnAgentK8s(fallbackAgent('shizuha'), {
        command: 'claude-bridge', model: 'claude-opus-4-8', contextPrompt: 'ctx', password: 'pw',
      }),
    ).toThrow(/agent-shizuha: rendered k8s manifest failed client-side validation/);

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('--dry-run=client');
    const liveApplies = log.split('\n').filter((l) => l.startsWith('apply ') && !l.includes('--dry-run'));
    expect(liveApplies).toEqual([]);
  });

  it('spawnAgentK8s live-applies after a passing dry-run', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-mio -o json" ]]; then
  printf '{"spec":{"selector":{"matchLabels":{"shizuha.io/agent":"mio"}}}}'
fi
exit 0
`);
    fs.chmodSync(kubectl, 0o755);

    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(fallbackAgent('mio'), {
      command: 'gateway', model: 'cortex/Qwen3.6-27B-NVFP4', contextPrompt: 'ctx', password: 'pw',
    });

    const applies = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.startsWith('apply '));
    expect(applies.some((l) => l.includes('--dry-run=client'))).toBe(true);
    expect(applies.some((l) => !l.includes('--dry-run'))).toBe(true);
  });

  it('expands an existing legacy workspace PVC to the fleet baseline before live apply', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-jun -o json" ]]; then
  printf '{"spec":{"selector":{"matchLabels":{"shizuha.io/agent":"jun"}}}}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet persistentvolumeclaim jun-workspace -o name" ]]; then
  printf 'persistentvolumeclaim/jun-workspace'
  exit 0
fi
if [[ "$*" == "get -n test-fleet persistentvolumeclaim jun-workspace -o jsonpath={.spec.resources.requests.storage}" ]]; then
  printf '5Gi'
  exit 0
fi
if [[ "$*" == "get clusterrolebinding/agent-jun-ops --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == "get -n test-fleet serviceaccount/agent-jun-ops --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == "get -n test-fleet secret/jun-fleet-ssh --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == patch* || "$*" == apply* ]]; then
  cat >/dev/null || true
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(fallbackAgent('jun'), {
      command: 'gateway', model: 'cortex/Qwen3.6-27B-NVFP4', contextPrompt: 'ctx', password: 'pw',
    });

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls).toContain(
      'patch -n test-fleet persistentvolumeclaim jun-workspace --type=merge -p {"spec":{"resources":{"requests":{"storage":"10Gi"}}}}',
    );
    expect(calls.findIndex((line) => line.startsWith('patch '))).toBeLessThan(
      calls.findIndex((line) => line === 'apply -n test-fleet -f -'),
    );
  });

  it('never tries to shrink a workspace PVC above the configured baseline', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-nagi -o json" ]]; then
  printf '{"spec":{"selector":{"matchLabels":{"shizuha.io/agent":"nagi"}}}}'
  exit 0
fi
if [[ "$*" == "get -n test-fleet persistentvolumeclaim nagi-workspace -o name" ]]; then exit 0; fi
if [[ "$*" == "get -n test-fleet persistentvolumeclaim nagi-workspace -o jsonpath={.spec.resources.requests.storage}" ]]; then printf '20Gi'; exit 0; fi
if [[ "$*" == "get clusterrolebinding/agent-nagi-ops --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == "get -n test-fleet serviceaccount/agent-nagi-ops --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == "get -n test-fleet secret/nagi-fleet-ssh --ignore-not-found=true -o json" ]]; then exit 0; fi
if [[ "$*" == apply* ]]; then cat >/dev/null || true; exit 0; fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { spawnAgentK8s } = await import('../../src/daemon/k8s-backend.js');
    spawnAgentK8s(fallbackAgent('nagi'), {
      command: 'gateway', model: 'cortex/Qwen3.6-27B-NVFP4', contextPrompt: 'ctx', password: 'pw',
    });

    expect(fs.readFileSync(logPath, 'utf-8')).not.toContain('patch -n test-fleet persistentvolumeclaim');
  });

  it('reads the exact RuntimeLane fence plus broker and runtime health from inside the pod', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"exec -n test-fleet deployment/agent-hana -c agent -- sh -c"* ]]; then
  printf '7\\n%s\\n1\\n%s\\n' '${'a'.repeat(64)}' '{"status":"ok","bridge":"codex-app-server","model":"gpt-5.6-sol","initialized":true,"authenticated":true,"providerHealthy":true,"quota_ok":true,"in_backoff":false}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { probeAgentK8sRuntimeLane } = await import('../../src/daemon/k8s-backend.js');
    await expect(probeAgentK8sRuntimeLane(agent('hana'))).resolves.toMatchObject({
      generation: 7,
      digest: 'a'.repeat(64),
      brokerReady: true,
      runtime: { status: 'ok', authenticated: true, quota_ok: true, in_backoff: false },
    });
  });

  it('reads the strict live bridge busy latch used by the just-in-time harness-roll gate', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--request-timeout=2s exec -n test-fleet deployment/agent-hana -c agent -- sh -c curl -fsS --max-time 3 http://127.0.0.1:8080/health"* ]]; then
  printf '%s\\n' '{"status":"ok","bridge":"codex-app-server","busy":true}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { probeAgentK8sBridgeBusy } = await import('../../src/daemon/k8s-backend.js');
    await expect(probeAgentK8sBridgeBusy(agent('hana'))).resolves.toBe(true);
  });

  it('reads only the newest bounded k8s heartbeat outcome for legacy-roll recovery', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--request-timeout=2s logs -n test-fleet deployment/agent-nagi -c agent --since=15m --tail=2048" ]]; then
  printf '%s\\n' \\
    'ordinary log line' \\
    '[heartbeat-outcome] {"agentId":"old","outcome":"queue_empty","observedAt":"2026-08-01T15:01:00Z"}' \\
    '[heartbeat-outcome] {"agentId":"nagi","outcome":"needs_help","observedAt":"2026-08-01T15:04:00Z"}'
  exit 0
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { readLatestAgentK8sHeartbeatOutcomeLogLine } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(readLatestAgentK8sHeartbeatOutcomeLogLine(agent('nagi')))
      .resolves.toContain('"outcome":"needs_help"');
  });

  it('fails closed when bounded k8s heartbeat logs are unavailable', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, '#!/usr/bin/env bash\nexit 1\n');
    fs.chmodSync(kubectl, 0o755);

    const { readLatestAgentK8sHeartbeatOutcomeLogLine } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(readLatestAgentK8sHeartbeatOutcomeLogLine(agent('nagi')))
      .resolves.toBeUndefined();
  });

  it('accepts only an exact drain-v1 ready fence for the desired runtime image', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const targetImage = 'runtime:new';
    const requestId = createHash('sha256')
      .update(`agent-hana-id\0${targetImage}`)
      .digest('hex')
      .slice(0, 32);
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n__SHIZUHA_HTTP_STATUS__:200\\n' '${JSON.stringify({
    protocol: 1,
    requestId,
    targetImage,
    state: 'ready',
    acceptingTurns: false,
    busy: false,
    pendingAcceptedTurns: 0,
    leaseUntil: 1,
  })}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .resolves.toEqual({ busy: false, protocol: 'drain-v1' });
  });

  it('accepts a drain-v2 proof only with a closed ingress fence and admission version', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const targetImage = 'runtime:new';
    const requestId = createHash('sha256')
      .update(`agent-hana-id\0${targetImage}`)
      .digest('hex')
      .slice(0, 32);
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n__SHIZUHA_HTTP_STATUS__:200\\n' '${JSON.stringify({
    protocol: 2,
    requestId,
    targetImage,
    state: 'ready',
    acceptingTurns: false,
    busy: false,
    pendingAcceptedTurns: 0,
    ingressFenced: true,
    admissionVersion: 17,
    leaseUntil: 1,
  })}'
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .resolves.toEqual({ busy: false, protocol: 'drain-v2', fenceVersion: 17 });
  });

  it('rejects drain-v2 readiness without a complete ingress fence proof', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const targetImage = 'runtime:new';
    const requestId = createHash('sha256')
      .update(`agent-hana-id\0${targetImage}`)
      .digest('hex')
      .slice(0, 32);
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n__SHIZUHA_HTTP_STATUS__:200\\n' '${JSON.stringify({
    protocol: 2,
    requestId,
    targetImage,
    state: 'ready',
    acceptingTurns: false,
    busy: false,
    pendingAcceptedTurns: 0,
    ingressFenced: false,
    admissionVersion: 17,
    leaseUntil: 1,
  })}'
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .rejects.toThrow('harness_roll_drain_invalid_response: incomplete ingress fence');
  });

  it('fails closed on retained rows without a durable processing acknowledgement', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const logPath = path.join(tmp, 'drain-backlog-kubectl.log');
    const targetImage = 'runtime:new';
    const requestId = createHash('sha256')
      .update(`agent-hana-id\0${targetImage}`)
      .digest('hex')
      .slice(0, 32);
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n__SHIZUHA_HTTP_STATUS__:200\\n' '${JSON.stringify({
    protocol: 1,
    requestId,
    targetImage,
    state: 'ready',
    acceptingTurns: false,
    busy: false,
    pendingAcceptedTurns: 7,
    leaseUntil: 1,
  })}'
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .resolves.toEqual({ busy: true, protocol: 'drain-v1', drainReserved: true });
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .resolves.toEqual({ busy: true, protocol: 'drain-v1', drainReserved: true });
    expect(
      fs.readFileSync(logPath, 'utf8').trim().split('\n')
        .filter((line) => line.includes('/v1/runtime/rollout-drain')),
    ).toHaveLength(1);
  });

  it('does not arm a drain over queued work after controller state is lost', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const logPath = path.join(tmp, 'restart-backlog-kubectl.log');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == *"curl -fsS --max-time 3 http://127.0.0.1:8080/health"* ]]; then
  printf '%s\\n' '{"status":"ok","busy":true,"queueDepth":9}'
  exit 0
fi
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  echo 'drain endpoint must not be called over queued work' >&2
  exit 99
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), 'runtime:restart-safe'))
      .resolves.toEqual({ busy: true, protocol: 'drain-v1' });
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain('/v1/runtime/rollout-drain');
  });

  it('falls back to the strict legacy health latch only when the drain endpoint is absent', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n' 'not found' '__SHIZUHA_HTTP_STATUS__:404'
  exit 0
fi
if [[ "$*" == *"curl -fsS --max-time 3 http://127.0.0.1:8080/health"* ]]; then
  printf '%s\\n' '{"status":"ok","busy":false}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), 'runtime:new'))
      .resolves.toEqual({ busy: false, protocol: 'legacy-health' });
  });

  it('distinguishes a bridge-local refusal from kubectl transport failure', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
echo 'curl: (7) Failed to connect to 127.0.0.1 port 8080 after 0 ms: Could not connect to server' >&2
echo 'command terminated with exit code 7' >&2
exit 7
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), 'runtime:new'))
      .rejects.toThrow('harness_roll_bridge_absent:');
  });

  it('keeps kubectl transport failures outside the bridge-absence repair lane', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
echo 'error: unable to upgrade connection: container not found ("agent")' >&2
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent (see note above).
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
exit 1
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), 'runtime:new'))
      .rejects.toThrow('harness_roll_bridge_unreachable:');
  });

  it('fails closed when drain-v1 claims ready without closing ingress', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const targetImage = 'runtime:new';
    const requestId = createHash('sha256')
      .update(`agent-hana-id\0${targetImage}`)
      .digest('hex')
      .slice(0, 32);
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n__SHIZUHA_HTTP_STATUS__:200\\n' '${JSON.stringify({
    protocol: 1,
    requestId,
    targetImage,
    state: 'ready',
    acceptingTurns: true,
    busy: false,
    pendingAcceptedTurns: 0,
    leaseUntil: 1,
  })}'
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .rejects.toThrow('harness_roll_drain_invalid_response: contradictory ready state');
  });

  it('fails closed when drain-v1 reports an invalid pending replay count', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    const targetImage = 'runtime:new';
    const requestId = createHash('sha256')
      .update(`agent-hana-id\0${targetImage}`)
      .digest('hex')
      .slice(0, 32);
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"http://127.0.0.1:8080/v1/runtime/rollout-drain"* ]]; then
  printf '%s\\n__SHIZUHA_HTTP_STATUS__:200\\n' '${JSON.stringify({
    protocol: 1,
    requestId,
    targetImage,
    state: 'ready',
    acceptingTurns: false,
    busy: false,
    pendingAcceptedTurns: -1,
    leaseUntil: 1,
  })}'
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { prepareAgentK8sBridgeForRuntimeRoll } =
      await import('../../src/daemon/k8s-backend.js');
    await expect(prepareAgentK8sBridgeForRuntimeRoll(agent('hana'), targetImage))
      .rejects.toThrow('harness_roll_drain_invalid_response: incomplete readiness proof');
  });

  it('rejects a health payload that does not prove bridge idleness with a boolean', async () => {
    const kubectl = path.join(tmp, 'kubectl');
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"exec -n test-fleet deployment/agent-hana -c agent -- sh -c"* ]]; then
  printf '%s\\n' '{"status":"ok","bridge":"codex-app-server"}'
  exit 0
fi
if [[ "$*" == get*deployment/agent-*-o*json ]]; then
  # Fake models no existing Deployment => absent. Real kubectl reports absence
  # as NotFound on exit 1, and the selector probe now discriminates on it, so a
  # bare "unexpected args" exit would read as "could not determine" and abort.
  echo "Error from server (NotFound): deployments.apps not found" >&2
  exit 1
fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { probeAgentK8sBridgeBusy } = await import('../../src/daemon/k8s-backend.js');
    await expect(probeAgentK8sBridgeBusy(agent('hana')))
      .rejects.toThrow('harness_roll_busy_probe_invalid_health: busy is not a boolean');
  });
  it('runtime-release mutation is an atomic resourceVersion JSON Patch and never a manifest apply', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    const d1 = `sha256:${'1'.repeat(64)}`;
    const d2 = `sha256:${'2'.repeat(64)}`;
    const live = `localhost:30500/shizuha-agent-runtime@${d1}`;
    const deployment = JSON.stringify({
      metadata: {
        resourceVersion: '42',
        annotations: {
          'shizuha.io/runtime-release-generation': '1',
          'shizuha.io/runtime-release-digest': d1,
        },
      },
      spec: {
        template: {
          metadata: { annotations: {
            'shizuha.io/runtime-release-generation': '1',
            'shizuha.io/runtime-release-digest': d1,
          } },
          spec: {
            initContainers: [{ name: 'workspace-permissions', image: live }],
            containers: [{ name: 'agent', image: live }],
          },
        },
      },
    });
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-jun -o json" ]]; then
  printf '%s' ${JSON.stringify(deployment)}
  exit 0
fi
if [[ "$*" == patch* ]]; then exit 0; fi
echo "unexpected kubectl args: $*" >&2
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { rollAgentK8sRuntimeRelease } = await import('../../src/daemon/k8s-backend.js');
    rollAgentK8sRuntimeRelease(agent('jun'), {
      agentId: 'agent-jun-id', username: 'jun', name: 'agent-jun',
      replicas: 1, readyReplicas: 1, availableReplicas: 1,
      resourceVersion: '42', currentImage: live,
      runtimeReleaseGeneration: 1, runtimeReleaseDigest: d1,
    }, {
      generation: 2,
      image_digest: d2,
      display_tag: 'localhost:30500/shizuha-agent-runtime:harness-b',
    });

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const patchCall = calls.find((line) => line.startsWith('patch '));
    expect(patchCall).toContain('--type=json');
    expect(patchCall).toContain('"op":"test","path":"/metadata/resourceVersion","value":"42"');
    expect(patchCall).toContain('"op":"replace","path":"/spec/template/spec/containers/0/image"');
    expect(patchCall).toContain('"op":"replace","path":"/spec/template/spec/initContainers/0/image"');
    expect(calls.some((line) => line.startsWith('apply '))).toBe(false);
  });

  it('adopts an unannotated Deployment by atomically stamping both scopes and both runtime images', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    const d1 = `sha256:${'1'.repeat(64)}`;
    const d2 = `sha256:${'2'.repeat(64)}`;
    const live = `localhost:30500/shizuha-agent-runtime@${d1}`;
    const deployment = JSON.stringify({
      metadata: { resourceVersion: '73', annotations: {} },
      spec: { template: { metadata: { annotations: {} }, spec: {
        initContainers: [{ name: 'workspace-permissions', image: live }],
        containers: [{ name: 'agent', image: live }],
      } } },
    });
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-nova -o json" ]]; then
  printf '%s' ${JSON.stringify(deployment)}
  exit 0
fi
if [[ "$*" == patch* ]]; then exit 0; fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { rollAgentK8sRuntimeRelease } = await import('../../src/daemon/k8s-backend.js');
    rollAgentK8sRuntimeRelease(agent('nova'), {
      agentId: 'agent-nova-id', username: 'nova', name: 'agent-nova',
      replicas: 1, readyReplicas: 1, availableReplicas: 1,
      resourceVersion: '73', currentImage: live,
    }, {
      generation: 2,
      image_digest: d2,
      display_tag: 'localhost:30500/shizuha-agent-runtime:harness-reviewed',
    });

    const patchCall = fs.readFileSync(logPath, 'utf-8').split('\n').find((line) => line.startsWith('patch '));
    expect(patchCall).toBeTruthy();
    const encodedPatch = patchCall!.match(/ -p (\[.*\])$/)?.[1];
    expect(encodedPatch).toBeTruthy();
    const operations = JSON.parse(encodedPatch!) as Array<{ op: string; path: string; value?: string }>;
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'add', path: expect.stringContaining('/metadata/annotations/shizuha.io~1runtime-release-generation'), value: '2' }),
      expect.objectContaining({ op: 'add', path: expect.stringContaining('/metadata/annotations/shizuha.io~1runtime-release-digest'), value: d2 }),
      expect.objectContaining({ op: 'add', path: expect.stringContaining('/spec/template/metadata/annotations/shizuha.io~1runtime-release-generation'), value: '2' }),
      expect.objectContaining({ op: 'add', path: expect.stringContaining('/spec/template/metadata/annotations/shizuha.io~1runtime-release-digest'), value: d2 }),
      { op: 'replace', path: '/spec/template/spec/containers/0/image', value: `localhost:30500/shizuha-agent-runtime@${d2}` },
      { op: 'replace', path: '/spec/template/spec/initContainers/0/image', value: `localhost:30500/shizuha-agent-runtime@${d2}` },
    ]));
  });

  it('executes reviewed rollback legacy adoption in production read-authority-CAS order', async () => {
    const logPath = path.join(tmp, 'rollback-adoption-order.log');
    const kubectl = path.join(tmp, 'kubectl');
    const target = `sha256:${'1'.repeat(64)}`;
    const gen4 = `sha256:${'2'.repeat(64)}`;
    const legacy = `sha256:${'3'.repeat(64)}`;
    const legacyImage = 'localhost:30500/shizuha-agent-runtime:harness-legacy';
    const deployment = JSON.stringify({
      metadata: { resourceVersion: '105', annotations: {} },
      spec: { replicas: 0, template: { metadata: { annotations: {} }, spec: {
        containers: [{ name: 'agent', image: legacyImage }],
      } } },
      status: { readyReplicas: 0, availableReplicas: 0 },
    });
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl:%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-sora -o json" ]]; then
  printf '%s' ${JSON.stringify(deployment)}
  exit 0
fi
if [[ "$*" == patch* ]]; then exit 0; fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const {
      getAgentK8sDeploymentStateAsync,
      rollAgentK8sRuntimeRelease,
    } = await import('../../src/daemon/k8s-backend.js');
    const {
      desiredRuntimeRelease,
      executeRuntimeReleaseMutationBoundary,
      parseDesiredRuntimeReleaseDocument,
      runtimeReleaseDocumentFingerprint,
    } = await import('../../src/daemon/runtime-release.js');
    const document = parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 5,
      releases: [
        {
          generation: 3,
          image_digest: target,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen3',
          source_commit: 'a'.repeat(40),
          intent: 'promote',
          rollback_of_generation: null,
          approved_at: '2026-08-11T23:40:00Z',
        },
        {
          generation: 4,
          image_digest: gen4,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen4',
          source_commit: 'b'.repeat(40),
          intent: 'promote',
          rollback_of_generation: null,
          approved_at: '2026-08-12T11:18:48Z',
        },
        {
          generation: 5,
          image_digest: target,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen3-rollback',
          source_commit: 'c'.repeat(40),
          intent: 'rollback',
          rollback_of_generation: 3,
          approved_at: '2026-08-12T12:00:00Z',
          adopt_from_digests: [legacy],
        },
      ],
    });
    const release = desiredRuntimeRelease(document);
    const fingerprint = runtimeReleaseDocumentFingerprint(document);
    const targetAgent = agent('sora');
    const marker = (value: string) => fs.appendFileSync(logPath, `hook:${value}\n`);
    const boundary = await executeRuntimeReleaseMutationBoundary(release, fingerprint, {
      readApplied: () => getAgentK8sDeploymentStateAsync(targetAgent).then((fresh) => fresh ? {
        ...fresh,
        generation: fresh.runtimeReleaseGeneration,
        imageDigest: fresh.runtimeReleaseDigest,
      } : null),
      resolveUnannotatedDigest: async () => {
        marker('digest-resolve');
        return legacy;
      },
      readAuthority: async () => {
        marker('authority-reread');
        return { release, documentFingerprint: fingerprint };
      },
      mutate: (fresh, approved) => {
        marker('mutation');
        rollAgentK8sRuntimeRelease(targetAgent, fresh, approved);
      },
    });
    expect(boundary).toMatchObject({ action: 'mutated', plan: { reason: 'legacy-adopt' } });

    const calls = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(calls[0]).toBe('kubectl:get -n test-fleet deployment/agent-sora -o json');
    expect(calls[1]).toBe('hook:digest-resolve');
    expect(calls[2]).toBe('hook:authority-reread');
    expect(calls[3]).toBe('hook:mutation');
    expect(calls[4]).toBe('kubectl:get -n test-fleet deployment/agent-sora -o json');
    expect(calls[5]).toMatch(/^kubectl:patch -n test-fleet deployment\/agent-sora --type=json -p /);
    const operations = JSON.parse(calls[5]!.match(/ -p (\[.*\])$/)![1]!) as Array<{
      op: string; path: string; value?: string;
    }>;
    expect(operations).toEqual(expect.arrayContaining([
      { op: 'test', path: '/metadata/resourceVersion', value: '105' },
      { op: 'test', path: '/spec/template/spec/containers/0/image', value: legacyImage },
      expect.objectContaining({ path: expect.stringContaining('runtime-release-generation'), value: '5' }),
      expect.objectContaining({ path: expect.stringContaining('runtime-release-digest'), value: target }),
      { op: 'replace', path: '/spec/template/spec/containers/0/image', value: `localhost:30500/shizuha-agent-runtime@${target}` },
    ]));
  });

  it('adopts a no-init legacy Deployment before a later spec pass adds the canonical init', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const phasePath = path.join(tmp, 'runtime-roll-phase');
    const kubectl = path.join(tmp, 'kubectl');
    const d1 = `sha256:${'1'.repeat(64)}`;
    const d2 = `sha256:${'2'.repeat(64)}`;
    const live = `localhost:30500/shizuha-agent-runtime@${d1}`;
    const desired = `localhost:30500/shizuha-agent-runtime@${d2}`;
    const legacyDeployment = JSON.stringify({
      metadata: { resourceVersion: '91', annotations: {} },
      spec: { replicas: 0, template: { metadata: { annotations: {} }, spec: {
        containers: [{ name: 'agent', image: live }],
      } } },
    });
    const adoptedDeployment = JSON.stringify({
      metadata: { resourceVersion: '92', annotations: {
        'shizuha.io/runtime-release-generation': '4',
        'shizuha.io/runtime-release-digest': d2,
      } },
      spec: { replicas: 0, template: { metadata: { annotations: {
        'shizuha.io/runtime-release-generation': '4',
        'shizuha.io/runtime-release-digest': d2,
      } }, spec: {
        containers: [{ name: 'agent', image: desired }],
      } } },
    });
    const convergedDeployment = JSON.stringify({
      metadata: { resourceVersion: '93', annotations: {
        'shizuha.io/runtime-release-generation': '4',
        'shizuha.io/runtime-release-digest': d2,
        'shizuha.io/runtime-spec-revision': 'inline-failover-v6-privileged-kubeconfig-v1',
      } },
      spec: { replicas: 0, template: { metadata: { annotations: {
        'shizuha.io/runtime-release-generation': '4',
        'shizuha.io/runtime-release-digest': d2,
        'shizuha.io/runtime-spec-revision': 'inline-failover-v6-privileged-kubeconfig-v1',
      } }, spec: {
        initContainers: [{ name: 'workspace-permissions', image: desired }],
        containers: [{ name: 'agent', image: desired }],
      } } },
    });
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-rui -o json" ]]; then
  phase=legacy
  [[ -f ${JSON.stringify(phasePath)} ]] && phase=$(<${JSON.stringify(phasePath)})
  case "$phase" in
    legacy) printf '%s' ${JSON.stringify(legacyDeployment)} ;;
    adopted) printf '%s' ${JSON.stringify(adoptedDeployment)} ;;
    converged) printf '%s' ${JSON.stringify(convergedDeployment)} ;;
    *) exit 3 ;;
  esac
  exit 0
fi
if [[ "$*" == "patch -n test-fleet deployment/agent-rui --type=json -p "* ]]; then
  printf adopted > ${JSON.stringify(phasePath)}
  exit 0
fi
if [[ "$*" == "patch -n test-fleet deployment/agent-rui --type=strategic -p "* ]]; then
  printf converged > ${JSON.stringify(phasePath)}
  exit 0
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const {
      getAgentK8sDeploymentState,
      rollAgentK8sRuntimeRelease,
      stageStoppedAgentK8sRuntime,
      K8S_RUNTIME_SPEC_REVISION,
    } = await import('../../src/daemon/k8s-backend.js');
    const { selectRuntimeRollDrift } = await import('../../src/daemon/manager.js');
    const { executeRuntimeReleaseMutationBoundary, planRuntimeRelease } = await import('../../src/daemon/runtime-release.js');
    const expected = {
      agentId: 'agent-rui-id', username: 'rui', name: 'agent-rui',
      replicas: 0, readyReplicas: 0, availableReplicas: 0,
      resourceVersion: '91', currentImage: live,
    };
    const release = {
      generation: 4,
      image_digest: d2,
      display_tag: 'localhost:30500/shizuha-agent-runtime:harness-reviewed',
      source_commit: 'c'.repeat(40),
      intent: 'promote' as const,
      rollback_of_generation: null,
      approved_at: '2026-08-12T00:00:00Z',
      adopt_from_digests: [d1],
    };

    // Production pass 1: reviewed legacy adoption crosses the immutable
    // release mutation boundary. The CAS updates release authority + agent
    // image atomically, but deliberately does not invent an absent init
    // container inside that narrowly reviewed write.
    const boundary = await executeRuntimeReleaseMutationBoundary(release, 'reviewed-fingerprint', {
      readApplied: () => expected,
      resolveUnannotatedDigest: () => d1,
      readAuthority: () => ({ release, documentFingerprint: 'reviewed-fingerprint' }),
      mutate: (fresh, approved) => rollAgentK8sRuntimeRelease(agent('rui'), fresh, approved),
    });
    expect(boundary.action).toBe('mutated');

    const patchCall = fs.readFileSync(logPath, 'utf-8').split('\n').find((line) => line.startsWith('patch '));
    expect(patchCall).toBeTruthy();
    const encodedPatch = patchCall!.match(/ -p (\[.*\])$/)?.[1];
    expect(encodedPatch).toBeTruthy();
    const operations = JSON.parse(encodedPatch!) as Array<{ op: string; path: string; value?: string }>;
    expect(operations).toEqual(expect.arrayContaining([
      { op: 'test', path: '/metadata/resourceVersion', value: '91' },
      { op: 'test', path: '/spec/template/spec/containers/0/image', value: live },
      { op: 'replace', path: '/spec/template/spec/containers/0/image', value: desired },
      expect.objectContaining({ op: 'add', path: expect.stringContaining('/metadata/annotations/shizuha.io~1runtime-release-generation'), value: '4' }),
      expect.objectContaining({ op: 'add', path: expect.stringContaining('/spec/template/metadata/annotations/shizuha.io~1runtime-release-generation'), value: '4' }),
    ]));
    expect(operations.some((operation) => operation.path.includes('/initContainers/'))).toBe(false);

    // Production pass 2: release authority is now converged, but the normal
    // drift selector sees the missing pod-contract revision and admits a
    // secondary spec-only pass using the already-reviewed immutable image.
    const adopted = getAgentK8sDeploymentState(agent('rui'))!;
    expect(planRuntimeRelease(release, {
      generation: adopted.runtimeReleaseGeneration,
      imageDigest: adopted.runtimeReleaseDigest,
      currentImage: adopted.currentImage,
    })).toEqual({ action: 'converged' });
    expect(adopted.currentWorkspaceInitImage).toBeUndefined();
    expect(selectRuntimeRollDrift([adopted], desired, '')).toEqual([adopted]);

    stageStoppedAgentK8sRuntime(agent('rui'), adopted.currentImage!);

    // Production pass 3: the strategic spec convergence has added the
    // canonical workspace init and stamped the revision; no drift remains.
    const converged = getAgentK8sDeploymentState(agent('rui'))!;
    expect(converged.currentWorkspaceInitImage).toBe(desired);
    expect(converged.runtimeSpecRevision).toBe(K8S_RUNTIME_SPEC_REVISION);
    expect(selectRuntimeRollDrift([converged], desired, '')).toEqual([]);
  });

  it('runtime-release CAS fails without mutation when a writer wins after the boundary GET', async () => {
    const logPath = path.join(tmp, 'kubectl.log');
    const kubectl = path.join(tmp, 'kubectl');
    const d1 = `sha256:${'1'.repeat(64)}`;
    const d2 = `sha256:${'2'.repeat(64)}`;
    const live = `localhost:30500/shizuha-agent-runtime@${d1}`;
    const deployment = JSON.stringify({
      metadata: { resourceVersion: '42', annotations: {
        'shizuha.io/runtime-release-generation': '1',
        'shizuha.io/runtime-release-digest': d1,
      } },
      spec: { template: { metadata: { annotations: {} }, spec: {
        initContainers: [{ name: 'workspace-permissions', image: live }],
        containers: [{ name: 'agent', image: live }],
      } } },
    });
    fs.writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "get -n test-fleet deployment/agent-zen -o json" ]]; then
  printf '%s' ${JSON.stringify(deployment)}
  exit 0
fi
if [[ "$*" == patch* ]]; then
  echo 'Error from server (Conflict): jsonpatch test operation failed after injected concurrent write' >&2
  exit 1
fi
exit 2
`);
    fs.chmodSync(kubectl, 0o755);

    const { rollAgentK8sRuntimeRelease } = await import('../../src/daemon/k8s-backend.js');
    expect(() => rollAgentK8sRuntimeRelease(agent('zen'), {
      agentId: 'agent-zen-id', username: 'zen', name: 'agent-zen',
      replicas: 1, readyReplicas: 1, availableReplicas: 1,
      resourceVersion: '42', currentImage: live,
      runtimeReleaseGeneration: 1, runtimeReleaseDigest: d1,
    }, {
      generation: 2, image_digest: d2,
      display_tag: 'localhost:30500/shizuha-agent-runtime:harness-b',
    })).toThrow();
    const calls = fs.readFileSync(logPath, 'utf-8');
    expect(calls).toContain('"op":"test","path":"/metadata/resourceVersion","value":"42"');
    expect(calls).not.toContain('apply ');
  });
  it('invalidates the mutation boundary when desired history changes during a suspended projection read', async () => {
    const curl = path.join(tmp, 'curl');
    const desiredPath = path.join(tmp, 'desired.json');
    const projectionStarted = path.join(tmp, 'projection-started');
    const projectionContinue = path.join(tmp, 'projection-continue');
    const d1 = `sha256:${'1'.repeat(64)}`;
    const d2 = `sha256:${'2'.repeat(64)}`;
    const displayTag = 'localhost:30500/shizuha-agent-runtime:harness-b';
    const document = {
      schema_version: 1,
      desired_generation: 2,
      releases: [
        {
          generation: 1,
          image_digest: d1,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a',
          source_commit: 'a'.repeat(40),
          intent: 'promote' as const,
          rollback_of_generation: null,
          approved_at: '2026-07-12T20:00:00Z',
        },
        {
          generation: 2,
          image_digest: d2,
          display_tag: displayTag,
          source_commit: 'b'.repeat(40),
          intent: 'promote' as const,
          rollback_of_generation: null,
          approved_at: '2026-07-12T21:00:00Z',
        },
      ],
    };
    fs.writeFileSync(desiredPath, JSON.stringify(document));
    fs.writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"-fsSI"* ]]; then
  touch ${JSON.stringify(projectionStarted)}
  while [[ ! -e ${JSON.stringify(projectionContinue)} ]]; do sleep 0.01; done
  printf 'HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${d2}\r\n\r\n'
  exit 0
fi
if [[ "$*" == *"http://hive.test/runtime-image"* ]]; then
  printf '%s' ${JSON.stringify(JSON.stringify({ image: displayTag, generation: 2, image_digest: d2 }))}
  exit 0
fi
echo "unexpected curl args: $*" >&2
exit 2
`);
    fs.chmodSync(curl, 0o755);
    process.env['SHIZUHA_DESIRED_RUNTIME_RELEASE_PATH'] = desiredPath;
    process.env['SHIZUHA_HIVE_RUNTIME_IMAGE_URL'] = 'http://hive.test/runtime-image';
    process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'] = displayTag;
    process.env['SHIZUHA_AGENT_RUNTIME_RELEASE_GENERATION'] = '2';

    const { readValidatedRuntimeRelease } = await import('../../src/daemon/k8s-backend.js');
    const {
      desiredRuntimeRelease,
      executeRuntimeReleaseMutationBoundary,
      runtimeReleaseDocumentFingerprint,
    } = await import('../../src/daemon/runtime-release.js');
    const candidate = desiredRuntimeRelease(document);
    let mutations = 0;
    const boundaryPromise = executeRuntimeReleaseMutationBoundary(
      candidate,
      runtimeReleaseDocumentFingerprint(document),
      {
        readApplied: () => ({ generation: 1, imageDigest: d1, currentImage: `repo@${d1}` }),
        resolveUnannotatedDigest: async () => undefined,
        readAuthority: readValidatedRuntimeRelease,
        mutate: () => { mutations += 1; },
      },
    );

    for (let attempt = 0; attempt < 200 && !fs.existsSync(projectionStarted); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(projectionStarted)).toBe(true);
    fs.writeFileSync(desiredPath, JSON.stringify({
      ...document,
      releases: [
        { ...document.releases[0]!, approved_at: '2026-07-12T20:00:01Z' },
        document.releases[1]!,
      ],
    }));
    fs.writeFileSync(projectionContinue, 'continue');

    await expect(boundaryPromise).resolves.toMatchObject({
      action: 'invalidated',
      reason: expect.stringContaining('authority changed during projection validation'),
    });
    expect(mutations).toBe(0);
  });
});

describe('githubIdentityFor (PLAT-4238 team-based github identity)', () => {
  it('returns a validated slug from agent env and rejects unsafe values', async () => {
    const { githubIdentityFor } = await import('../../src/daemon/k8s-backend.js');
    const base = { id: 'a1', name: 'A', username: 'a1', email: 'a1@shizuha.com' } as any;
    expect(githubIdentityFor({ ...base, env: { GITHUB_IDENTITY: 'sara2574' } })).toBe('sara2574');
    expect(githubIdentityFor({ ...base, env: { GITHUB_IDENTITY: ' KAI2574 ' } })).toBe('kai2574');
    // No identity / empty → legacy path
    expect(githubIdentityFor(base)).toBeUndefined();
    expect(githubIdentityFor({ ...base, env: { GITHUB_IDENTITY: '' } })).toBeUndefined();
    // Anything not slug-shaped must be REJECTED (it becomes a k8s Secret name)
    expect(githubIdentityFor({ ...base, env: { GITHUB_IDENTITY: 'x/../etc' } })).toBeUndefined();
    expect(githubIdentityFor({ ...base, env: { GITHUB_IDENTITY: 'a b' } })).toBeUndefined();
    expect(githubIdentityFor({ ...base, env: { GITHUB_IDENTITY: '-bad' } })).toBeUndefined();
  });
});
