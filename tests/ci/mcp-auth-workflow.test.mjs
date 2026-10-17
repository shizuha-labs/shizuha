import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(".forgejo/workflows/build-mcp-auth-proxy.yml", "utf8");

test("MCP auth build uses canonical Docker Hub image identity", () => {
  assert.match(workflow, /image: docker\.io\/library\/golang:1\.22-alpine/);
  for (const authority of [
    "mirror-dockerhub.registry.svc.cluster.local:5000",
    "other.namespace.svc.cluster.local",
    "localhost:30501",
    "127.0.0.1:5000",
    "[::1]:5000",
  ]) {
    const rendered = `image: ${authority}/library/golang:1.22-alpine`;
    assert.match(rendered, /image:\s+(?:[^/]+\.)?svc\.cluster\.local(?::\d+)?\/|image:\s+(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?\//);
  }
});

function runPostBuildGate(mode) {
  const start = workflow.indexOf("          wait_job() {");
  const endMarker = '          test "${LIVE_BROKER_IMAGE}" = "${BROKER_IMAGE}"';
  const end = workflow.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start >= 0 && end > start, "post-build gate must remain extractable");
  const body = workflow.slice(start, end).replace(/^ {10}/gm, "");

  const dir = mkdtempSync(join(tmpdir(), "mcp-auth-gate-"));
  const calls = join(dir, "calls");
  const kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, `#!/bin/sh\necho "$*" >> "$CALLS"\nif [ "$1" = wait ]; then\n  [ "$MODE" = failed ] && sleep 2\n  exit 1\nfi\nif [ "$1" = get ]; then\n  [ "$MODE" = failed ] && printf 1 || printf 0\nfi\nexit 0\n`);
  chmodSync(kubectl, 0o755);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\nSHORT=test\nREG=registry:5000\nIMAGE=mcp-auth\nTAG=test\n${body}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, MODE: mode },
  });
  return { result, calls: readFileSync(calls, "utf8") };
}

for (const mode of ["failed", "deadline"]) {
  test(`${mode} build outcome stops before manifest publication`, () => {
    const { result, calls } = runPostBuildGate(mode);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(calls, /ci-manifest-mcp-auth/);
  });
}

test("every generated MCP auth Job has a fail-closed lifetime", () => {
  const renderedJobs = workflow.match(/apiVersion: batch\/v1[\s\S]*?(?=YAML|$)/g) ?? [];
  assert.equal(renderedJobs.length, 5);
  for (const [index, job] of renderedJobs.entries()) {
    assert.match(job, /backoffLimit: 0/);
    assert.match(job, index === 4 ? /activeDeadlineSeconds: 300\b/ : /activeDeadlineSeconds: 3600\b/);
    assert.match(job, /ttlSecondsAfterFinished: 300/);
  }
});

test("Kaniko cleans up and architecture smoke waits run concurrently", () => {
  const executors = workflow.match(/image: gcr\.io\/kaniko-project\/executor:v1\.23\.2/g) ?? [];
  const cleanupFlags = workflow.match(/- --cleanup/g) ?? [];
  assert.equal(cleanupFlags.length, executors.length);
  assert.match(workflow, /ci-smoke-mcp-auth-\$\{SHORT\}-amd64" --timeout=300s &/);
  assert.match(workflow, /ci-smoke-mcp-auth-\$\{SHORT\}-arm64" --timeout=300s &/);
  assert.doesNotMatch(
    workflow,
    /^\s*kubectl wait .*ci-smoke-mcp-auth-\$\{SHORT\}-(?:amd64|arm64)" --timeout=300s$/m,
  );
});

test("verified broker publication advances the runtime controller rollout pin", () => {
  const verify = workflow.indexOf(
    'kubectl wait -n build --for=condition=complete "job/ci-verify-mcp-auth-${SHORT}"',
  );
  const deploy = workflow.indexOf(
    'kubectl -n rt-fleet set env deployment/shizuha-runtime-fleet',
  );
  assert.ok(verify >= 0, "multi-arch verification gate must exist");
  assert.ok(deploy > verify, "broker pin may advance only after verification");
  assert.match(
    workflow,
    /SHIZUHA_BROKER_IMAGE=\$\{BROKER_IMAGE\}[\s\S]*rollout status deployment\/shizuha-runtime-fleet --timeout=300s/,
  );
  assert.match(workflow, /test "\$\{LIVE_BROKER_IMAGE\}" = "\$\{BROKER_IMAGE\}"/);
});

test("native Hive publication follows qualification and persists all four source authorities", () => {
  const publication = workflow.indexOf('- name: Publish qualified broker to native Hive source authority');
  assert.ok(publication > workflow.indexOf('test "${LIVE_BROKER_IMAGE}" = "${BROKER_IMAGE}"'));
  const body = readFileSync("scripts/publish-hive-broker.sh", "utf8");
  assert.match(body, /update-hive-broker-pins\.py/);
  assert.match(body, /--image "\$BROKER_IMAGE" --source-sha "\$SOURCE_SHA"/);
  assert.match(body, /git -C "\$WORKDIR\/hive" add hive_project\/settings\.py k8s\/hive-backend-live\.yaml \\\n\s+k8s\/shizuha-hive\.yaml \.forgejo\/scripts\/ring-release-fleet\.sh/);
  assert.match(body, /http\.extraHeader="Authorization: Basic \$\{AUTH\}" push origin HEAD:main/);
  assert.doesNotMatch(body, /kubectl .* (?:apply|patch|set|replace)|push .*--force/);
  assert.doesNotMatch(workflow.slice(publication), /kubectl .*get secret/);
  assert.match(workflow.slice(publication), /secretKeyRef: \{ name: forgejo-token, key: password \}/);
  assert.match(workflow, /- scripts\/update-hive-broker-pins\.py/);
});
