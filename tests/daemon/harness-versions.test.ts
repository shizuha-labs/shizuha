import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  __resetConvergenceStateForTest,
  __versionFromCliForTest,
  fleetConvergedToImage,
  harnessReport,
  noteConvergedAgentRuntimeImage,
  noteDominantAgentRuntimeImage,
} from '../../src/daemon/harness-versions.js';

describe('daemon harness convergence reporting', () => {
  it('isolates third-party version probes from the daemon HOME and provider secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-probe-test-'));
    const fakeCli = path.join(dir, 'fake-gemini');
    fs.writeFileSync(fakeCli, `#!/bin/sh
set -eu
[ -z "\${OPENAI_API_KEY:-}" ]
mkdir -p "$HOME/.gemini"
printf 'probe diagnostic that must remain captured\n' >&2
printf 'gemini 0.50.0\n'
`);
    fs.chmodSync(fakeCli, 0o755);
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'must-not-reach-version-probe';
    try {
      expect(__versionFromCliForTest(fakeCli)).toBe('0.50.0');
      expect(fs.existsSync(path.join(dir, '.gemini'))).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives OCI harness labels from the same build args as installed binaries', () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile.agent-runtime'), 'utf8');
    expect(dockerfile).toContain('org.shizuha.harness.codex="${CODEX_VERSION}"');
    expect(dockerfile).toContain('org.shizuha.harness.claude_code="${CLAUDE_CODE_VERSION}"');
    expect(dockerfile).toContain('org.shizuha.harness.openclaw="${OPENCLAW_VERSION}"');
    expect(dockerfile).toContain('org.opencontainers.image.revision="${SCLI_SOURCE_SHA}"');
    expect(dockerfile).toContain('org.shizuha.skills.revision="${SKILLS_SOURCE_SHA}"');
  });

  it('rebuilds the fleet image when runtime source lands and records its revision', () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = fs.readFileSync(
      path.join(projectRoot, '.forgejo/workflows/build-agent-runtime.yml'),
      'utf8',
    );
    const smokeRenderer = fs.readFileSync(
      path.join(projectRoot, 'scripts/render-agent-runtime-smoke-job.py'),
      'utf8',
    );
    const manifestRenderer = fs.readFileSync(
      path.join(projectRoot, 'scripts/render-agent-runtime-manifest-job.py'),
      'utf8',
    );
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main, master]');
    expect(workflow).toContain("- 'src/**'");
    expect(workflow).toContain("- 'runtime-skills.lock'");
    expect(workflow).toContain('group: build-agent-runtime');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('TAG="harness-${STAMP}-${SHORT_SHA}"');
    expect(workflow).toContain('SOURCE_SHA: ${{ github.sha }}');
    expect(workflow).toContain('--build-arg=SCLI_SOURCE_SHA=$SOURCE_SHA');
    expect(workflow).toContain('--build-arg=SKILLS_SOURCE_SHA=${SKILLS_SHA}');
    expect(workflow).toContain("fetch --depth=1 origin '${SKILLS_SHA}'");
    expect(workflow).toContain("test \"\\$(git -C /workspace/src/.runtime-skills rev-parse HEAD)\" = '${SKILLS_SHA}'");
    expect(workflow).toContain('fetch --depth=1 origin "$SOURCE_SHA"');
    expect(workflow).toContain('test "\\$(git -C /workspace/src rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(workflow).toContain('npm ci --ignore-scripts --registry=http://npm-cache.registry.svc.cluster.local:4873');
    expect(workflow).toContain('--snapshot-mode=redo');
    expect(workflow).toContain('--use-new-run');
    expect(workflow).toContain('--cleanup');
    expect(workflow).toContain('> /workspace/src/.harness-build-versions.lock');
    expect(workflow).not.toContain('http://x-token-auth:');
    expect(workflow).toContain('podFailurePolicy:');
    expect(workflow).toContain('action: Ignore');
    expect(workflow).toContain('type: DisruptionTarget');
    expect(workflow).toContain('-l app=ci-build,service=agent-runtime');
    expect(workflow).toContain('wait_for_prior_runtime_release_jobs');
    expect(workflow).toContain('terminal-owner legacy runtime builder');
    expect(workflow).toContain('ci-smoke-agentrt-${CANDIDATE_TAG}-${ARCH}');
    expect(workflow).toContain('scripts/render-agent-runtime-smoke-job.py');
    expect(smokeRenderer).toContain('assert_version claude "$CC_VER"');
    expect(smokeRenderer).toContain('{"name": "CC_VER", "value": cc}');
    expect(smokeRenderer).toContain('assert_version codex "$CODEX_VER"');
    expect(smokeRenderer).toContain('assert_version agy "$ANTIGRAVITY_VER"');
    expect(smokeRenderer).toContain('assert_version antigravity "$ANTIGRAVITY_VER"');
    expect(smokeRenderer).toContain('gemini CLI is present');
    expect(smokeRenderer).toContain('assert_version openclaw "$OPENCLAW_VER"');
    expect(smokeRenderer).toContain('/opt/shizuha/harness-versions.json');
    expect(workflow).not.toContain('/app/manage.py promote_runtime_image');
    expect(workflow.indexOf('runtime image smoke failed')).toBeLessThan(
      workflow.indexOf('Promotion requires a reviewed deploy PR'),
    );
    expect(workflow).toContain('PREPULL_NODES="$(');
    expect(workflow).toContain('or .metadata.labels["shizuha.io/platform"] == "true"');
    expect(workflow).not.toContain('kubectl get pods -n shizuha-fleet');
    expect(workflow).not.toContain('ACTIVE_AGENT_NODES');
    expect(workflow).not.toContain("-l '!node-role.kubernetes.io/control-plane'");
    expect(workflow).toContain("kubectl get nodes -o json");
    expect(workflow).toContain('.spec.unschedulable != true');
    expect(workflow).toContain('.type == "Ready" and .status == "True"');
    expect(workflow).toContain('no Ready agent-eligible pre-pull nodes found');
    expect(workflow).toContain('PREPULL_JOB="ci-prepull-agentrt-${CANDIDATE_TAG}-${NODE}"');
    expect(workflow).toContain('nodeName: ${NODE}');
    expect(workflow).toContain('ttlSecondsAfterFinished: 3600');
    expect(workflow).toMatch(
      /name: ci-build-agentrt-\$\{CANDIDATE_TAG\}-\$\{ARCH\}[\s\S]*?ttlSecondsAfterFinished: 300/,
    );
    expect(workflow).toContain('scripts/render-agent-runtime-manifest-job.py');
    expect(manifestRenderer).toMatch(
      /"name": f"ci-manifest-agentrt-\{args\.candidate_tag\}"[\s\S]*?"ttlSecondsAfterFinished": 300/,
    );
    expect(smokeRenderer).toMatch(
      /"name": f"ci-smoke-agentrt-\{tag\}-\{arch\}"[\s\S]*?"ttlSecondsAfterFinished": 300/,
    );
    expect(workflow).not.toContain('kind: DaemonSet');
    expect(workflow).toContain('runtime image fleet pre-pull failed');
    expect(workflow).not.toContain('deleting superseded active runtime pre-pull');
    expect(workflow).toContain('activeDeadlineSeconds: 900');
    expect(workflow).toContain('wait_prepull_job "$NODE" &');
    expect(workflow).toContain('PREPULL_WAIT_PIDS="$PREPULL_WAIT_PIDS $!"');
    expect(workflow).toContain('node became ${NODE_READY:-unavailable}');
    expect(workflow).toContain('kubectl delete job -n build "$PREPULL_JOB" --wait=false');
    expect(workflow.indexOf('runtime image fleet pre-pull failed')).toBeLessThan(
      workflow.indexOf('Promotion requires a reviewed deploy PR'),
    );
    expect(workflow).not.toContain('/app/manage.py promote_runtime_image');
    expect(workflow).not.toContain('FLEET_IMAGE="localhost:30500/${IMG}:${TAG}"');
  });

  it('keys the Kaniko global-harness layer by the resolved version set', () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile.agent-runtime'), 'utf8');
    expect(dockerfile).toContain(
      'COPY .harness-build-versions.lock /opt/shizuha/.harness-build-versions.lock',
    );
    for (const [name, buildArg] of [
      ['claude_code', 'CLAUDE_CODE_VERSION'],
      ['codex', 'CODEX_VERSION'],
      ['antigravity', 'ANTIGRAVITY_VERSION'],
      ['openclaw', 'OPENCLAW_VERSION'],
    ]) {
      expect(dockerfile).toContain(
        `grep -qx "${name}=\${${buildArg}}" /opt/shizuha/.harness-build-versions.lock`,
      );
    }
    expect(dockerfile).toContain('/usr/local/bin/agy');
    expect(dockerfile).toContain('ln -sfn /usr/local/bin/agy /usr/local/bin/antigravity');
    expect(dockerfile).not.toMatch(/npm install[^\n]*gemini/i);
    expect(dockerfile).not.toContain('gemini-cli@');
    const lock = fs.readFileSync(
      path.join(projectRoot, '.harness-build-versions.lock'),
      'utf8',
    );
    expect(lock).toContain('claude_code=2.1.211');
    expect(lock).toContain('codex=0.144.5');
    expect(lock).toContain('antigravity=');
    expect(lock).not.toContain('gemini=');
    const harnessInstall = dockerfile.indexOf('&& npm install -g');
    expect(harnessInstall).toBeGreaterThan(-1);
    expect(harnessInstall).toBeLessThan(dockerfile.indexOf('COPY dist ./dist'));
    expect(harnessInstall).toBeLessThan(dockerfile.indexOf('COPY .runtime-skills /opt/skills'));
    expect(dockerfile.indexOf('ARG SCLI_VERSION=unknown')).toBeGreaterThan(harnessInstall);
  });

  it('keeps the cluster-facing SCLI publisher off the shared test runner', () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const workflow = fs.readFileSync(
      path.join(projectRoot, '.forgejo/workflows/build-publish-scli.yml'),
      'utf8',
    );
    expect(workflow).toMatch(/build-publish-linux:\n(?:.|\n)*?runs-on: deploy-lane/);
    expect(workflow).toMatch(
      /group: build-publish-scli-\$\{\{ github\.ref \}\}\s+[\s\S]*?cancel-in-progress: false/,
    );
    expect(workflow).toContain('npm ci --ignore-scripts --omit=dev --no-audit --no-fund');
    expect(workflow).toContain("BUILD_ABI=\"\\$(node -p 'process.versions.modules')\"");
    expect(workflow).toContain('cp node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    expect(workflow).toContain('lib/node_modules/pino/package.json');
    expect(workflow).toContain('lib/node_modules/better-sqlite3/package.json');
    expect(workflow).toContain('cp -r dist/templates');
    expect(workflow).not.toContain('npm prune --omit=dev');
    expect(workflow).toContain('FATAL: packaged shizuha --version failed');
    expect(workflow).toContain('Deleting superseded active SCLI publisher: $stale_job');
    expect(workflow).toContain('[ "$complete" -eq 2 ] && break');
    expect(workflow).not.toContain('wait_job linux-x64');
    expect(workflow).toMatch(/deploy-runtime-fleet:\n(?:.|\n)*?needs: \[build-publish-linux\]/);
    expect(workflow).toContain(
      'api/packages/actions/generic/kubectl/v1.34.1/kubectl-${KUBECTL_ARCH}',
    );
    expect(workflow).not.toMatch(/\n  schedule:/);
    expect(workflow).toContain('RELEASE_ID="${SHORT}-${RUN_NUMBER}-a${RUN_ATTEMPT}"');
    expect(workflow).toContain('generic/scli-builds/${RELEASE_ID}');
    expect(workflow).toContain('consumers use release.json as the atomic commit marker');
    expect(workflow).toContain('if [ "\\${TARGET}" = "linux-x64" ]; then');
    expect(workflow).not.toContain('for f in "\\${NAME}.tar.gz" "\\${TARGET}.json" "install.sh"');
    expect(workflow).toContain('releaseId: \\$releaseId');
    expect(workflow).toContain('"linux-arm64": \\$arm64[0]');
    expect(workflow).not.toMatch(/(?<!\\)\\$releaseId/);
    expect(workflow).toContain('for file in install.sh release.json');
    expect(workflow).toContain('PROMOTED releaseId=\\${RELEASE_ID} sourceSha=\\${CI_SOURCE_SHA}');
    expect(workflow).toContain(
      'test "\\$(jq -r .sourceSha "\\${tmp}/\\${platform}.json")" = "\\${CI_SOURCE_SHA}"',
    );
    expect(workflow).toMatch(
      /name: ci-scli-\$\{SHORT\}-\$\{TARGET\}[\s\S]*?ttlSecondsAfterFinished: 300/,
    );
    // hostPath dist stage + s1 pin RETIRED — agents ship via multi-arch images.
    expect(workflow).toContain('hostPath dist stage + s1 pin RETIRED');
    expect(workflow).toContain('Do not re-add s1 hostPath staging');
    expect(workflow).toContain('fleet-daemon-k8s + agent-runtime image');
    expect(workflow).not.toContain('path: /home/phoenix/work/shizuha-stack/cli');
    expect(workflow).not.toContain('dist.previous-\\${DEPLOY_ID}');
    expect(workflow).not.toContain('wait_runtime_fleet_rollout()');
    expect(workflow).not.toContain('ci-rollback-runtime-fleet-${SHORT}');
    expect(workflow).not.toContain('ci-verify-runtime-fleet-${SHORT}');
    expect(workflow).not.toMatch(/(?:^|\n)\s*shizuha up\b/);

    const retiredTimer = fs.readFileSync(
      path.join(projectRoot, 'rt-build/systemd/shizuha-rt-build.timer'),
      'utf8',
    );
    const retiredService = fs.readFileSync(
      path.join(projectRoot, 'rt-build/systemd/shizuha-rt-build.service'),
      'utf8',
    );
    const retiredEntrypoint = fs.readFileSync(
      path.join(projectRoot, 'rt-build/build-all-platforms.sh'),
      'utf8',
    );
    for (const unit of [retiredTimer, retiredService]) {
      expect(unit).toContain('ConditionPathExists=!/');
      expect(unit).toContain('RefuseManualStart=yes');
    }
    expect(retiredEntrypoint).toContain('RETIRED');
    expect(retiredEntrypoint).not.toContain('latest.json');
    expect(retiredEntrypoint).not.toContain('docker');
  });

  it('bakes a pinned and validated canonical skill catalog into every runtime image', () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile.agent-runtime'), 'utf8');
    const lock = fs.readFileSync(path.join(projectRoot, 'runtime-skills.lock'), 'utf8').trim();
    expect(lock).toMatch(/^[0-9a-f]{40}$/);
    expect(dockerfile).toContain('COPY .runtime-skills /opt/skills');
    expect(dockerfile).toContain('[ "$skill_count" -ge 50 ]');
    expect(dockerfile).toContain('test ! -e /opt/skills/.git');
    expect(dockerfile).toContain('/opt/skills/${skill}/SKILL.md');
  });

  it('requires every observable deployment that reports an image to match desired', () => {
    const desired = 'registry/shizuha-agent-runtime:harness-new';
    expect(fleetConvergedToImage([], desired)).toBe(false);
    // Incomplete reads (no currentImage) are ignored, not treated as drift —
    // orphan/non-k8s leftovers must not block autonomous convergence.
    expect(fleetConvergedToImage([{ currentImage: desired }, {}], desired)).toBe(true);
    expect(fleetConvergedToImage([
      { currentImage: desired },
      { currentImage: 'registry/shizuha-agent-runtime:harness-old' },
    ], desired)).toBe(false);
    expect(fleetConvergedToImage([
      { currentImage: desired },
      { currentImage: desired },
    ], desired)).toBe(true);
    expect(fleetConvergedToImage([
      { currentImage: desired, currentWorkspaceInitImage: 'registry/shizuha-agent-runtime:harness-old' },
    ], desired)).toBe(false);
    expect(fleetConvergedToImage([
      { currentImage: desired, currentWorkspaceInitImage: desired },
    ], desired)).toBe(true);
  });

  it('moves the report from startup state to the proven converged image', () => {
    noteConvergedAgentRuntimeImage('shizuha-agent-runtime:harness-converged');
    expect(harnessReport().agent_runtime_image).toBe('shizuha-agent-runtime:harness-converged');
  });

  it('reports the dominant running image during a partial roll (no more forever-rolling)', () => {
    // operator 2026-08-06: at 3/4 on the new image, the baseline must track
    // what most agents actually run rather than freezing until 100%.
    __resetConvergenceStateForTest();
    noteDominantAgentRuntimeImage([
      { currentImage: 'registry/shizuha-agent-runtime:new', replicas: 1, readyReplicas: 1 },
      { currentImage: 'registry/shizuha-agent-runtime:new', replicas: 1, readyReplicas: 1 },
      { currentImage: 'registry/shizuha-agent-runtime:new', replicas: 0, readyReplicas: 0 },
      { currentImage: 'registry/shizuha-agent-runtime:old', replicas: 1, readyReplicas: 1 },
    ]);
    expect(harnessReport().agent_runtime_image).toBe('registry/shizuha-agent-runtime:new');
  });

  it('does not count an unready pod on the new image as running', () => {
    __resetConvergenceStateForTest();
    noteConvergedAgentRuntimeImage('registry/shizuha-agent-runtime:old');
    noteDominantAgentRuntimeImage([
      { currentImage: 'registry/shizuha-agent-runtime:old', replicas: 1, readyReplicas: 1 },
      { currentImage: 'registry/shizuha-agent-runtime:new', replicas: 1, readyReplicas: 0 },
    ]);
    // Only the ready 'old' pod counts, so the baseline stays 'old'.
    expect(harnessReport().agent_runtime_image).toBe('registry/shizuha-agent-runtime:old');
  });

  it('ignores non-agent-runtime images', () => {
    __resetConvergenceStateForTest();
    noteConvergedAgentRuntimeImage('registry/shizuha-agent-runtime:seed');
    noteDominantAgentRuntimeImage([
      { currentImage: 'registry/some-other-image:latest', replicas: 1, readyReplicas: 1 },
    ]);
    expect(harnessReport().agent_runtime_image).toBe('registry/shizuha-agent-runtime:seed');
  });

  it('restores the last proven image after a daemon process restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-convergence-test-'));
    const stateFile = path.join(dir, 'convergence.json');
    const previous = process.env['SHIZUHA_HARNESS_CONVERGENCE_STATE_FILE'];
    const previousBootstrap = process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'];
    process.env['SHIZUHA_HARNESS_CONVERGENCE_STATE_FILE'] = stateFile;
    try {
      __resetConvergenceStateForTest();
      noteConvergedAgentRuntimeImage('registry/shizuha-agent-runtime:harness-durable');
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).agent_runtime_image)
        .toBe('registry/shizuha-agent-runtime:harness-durable');

      // Reset module memory to model a new daemon process. The persisted
      // completion proof must win over the obsolete bootstrap image pin.
      process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'] = 'registry/shizuha-agent-runtime:harness-bootstrap';
      __resetConvergenceStateForTest();
      expect(harnessReport().agent_runtime_image)
        .toBe('registry/shizuha-agent-runtime:harness-durable');
    } finally {
      if (previous === undefined) delete process.env['SHIZUHA_HARNESS_CONVERGENCE_STATE_FILE'];
      else process.env['SHIZUHA_HARNESS_CONVERGENCE_STATE_FILE'] = previous;
      if (previousBootstrap === undefined) delete process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'];
      else process.env['SHIZUHA_AGENT_RUNTIME_IMAGE'] = previousBootstrap;
      __resetConvergenceStateForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
