import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  ".forgejo/workflows/build-agent-runtime.yml",
  "utf8",
);

describe("agent runtime multi-architecture gates", () => {
  it("serializes release runs without canceling valid in-progress builds", () => {
    expect(workflow).toContain(`concurrency:
  group: build-agent-runtime
  cancel-in-progress: false`);
    expect(workflow).not.toContain(`group: build-agent-runtime
  cancel-in-progress: true`);
  });

  it("reads live coalescer policy through a deterministic Ready Pod", () => {
    expect(workflow).toContain(`-l app=run-coalescer -o json`);
    expect(workflow).toContain(`select(.status.phase == "Running")`);
    expect(workflow).toContain(
      `select(any(.status.containerStatuses[]?; .ready == true))`,
    );
    expect(workflow).toContain(`sort_by(.metadata.name)`);
    expect(workflow).toContain(
      `kubectl exec -n origin "$live_coalescer_pod"`,
    );
    expect(workflow).not.toContain(
      `kubectl exec -n origin deployment/run-coalescer`,
    );
    expect(workflow).not.toContain(`cat /app/server.py' 2>/dev/null || true`);
  });

  it("uses the shared guard as the sole terminal build observer", () => {
    const guard = workflow.indexOf('python3 "$BUILD_GUARD" wait-pair');
    const smokeGate = workflow.indexOf("render_smoke_job()", guard);
    const afterGuard = workflow.slice(guard, smokeGate);

    expect(guard).toBeGreaterThan(-1);
    expect(smokeGate).toBeGreaterThan(guard);
    expect(afterGuard).toContain('--job "amd64=${AMD64_JOB}"');
    expect(afterGuard).toContain('--job "arm64=${ARM64_JOB}"');
    expect(afterGuard).toContain("--timeout-seconds 1800");
    expect(afterGuard).toContain("trap - EXIT INT TERM");
    expect(afterGuard).not.toContain("wait_job()");
    expect(afterGuard).not.toContain("--for=condition=complete");
  });

  it("observes both architecture smoke jobs concurrently and aggregates failures", () => {
    expect(workflow).toContain(`wait_smoke_job amd64 &
          AMD64_SMOKE_WAIT_PID=$!
          wait_smoke_job arm64 &
          ARM64_SMOKE_WAIT_PID=$!
          SMOKE_WAIT_STATUS=0
          wait "$AMD64_SMOKE_WAIT_PID" || SMOKE_WAIT_STATUS=$?
          wait "$ARM64_SMOKE_WAIT_PID" || SMOKE_WAIT_STATUS=$?
          [ "$SMOKE_WAIT_STATUS" -eq 0 ] || exit "$SMOKE_WAIT_STATUS"`);
    expect(workflow).not.toMatch(
      /for ARCH in amd64 arm64; do\s+SMOKE_JOB="ci-smoke-agentrt-/,
    );
  });

  it("tolerates cold image pulls and a lagging Job Complete condition", () => {
    expect(workflow).toContain(
      `--for=condition=complete "job/\${SMOKE_JOB}" --timeout=1800s &`,
    );
    expect(workflow).toContain(
      `-o jsonpath='{.items[0].status.phase}' 2>/dev/null || true`,
    );
    expect(workflow).toContain(`Succeeded)
                  kill "$WAIT_PID"`);
    expect(workflow).toContain(`Failed)
                  kill "$WAIT_PID"`);
    expect(workflow).not.toContain(
      `--for=condition=complete "job/\${SMOKE_JOB}" --timeout=600s`,
    );
  });

  it("rechecks node readiness and observes every finite pre-pull concurrently", () => {
    expect(workflow).toContain(`activeDeadlineSeconds: 900`);
    expect(workflow).not.toContain(`deleting superseded active runtime pre-pull`);
    expect(workflow).toContain(`NODE_READY="$(kubectl get node "$NODE"`);
    expect(workflow).toContain(`if [ "$NODE_READY" != True ]; then`);
    expect(workflow).toContain(`kubectl delete job -n build "$PREPULL_JOB" --wait=false`);
    expect(workflow).toContain(`wait_prepull_job "$NODE" &`);
    expect(workflow).toContain(`wait "$WAIT_PID" || PREPULL_WAIT_STATUS=$?`);
  });

  it("does not auto-promote a writer-less tree onto the rt-fleet controller", () => {
    expect(workflow).toContain("skipping DesiredRuntimeRelease promote: k8s actuator is not in this tree");
    expect(workflow).toContain("if [ ! -f src/plugins/fleet/k8s-backend.ts ]; then");
    const promote = workflow.indexOf("name: Auto-promote DesiredRuntimeRelease");
    const skip = workflow.indexOf("skipping DesiredRuntimeRelease promote");
    const append = workflow.indexOf("append-desired-runtime-release.py");
    expect(promote).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(promote);
    expect(append).toBeGreaterThan(skip);
  });

  it("pre-pulls on labeled platform nodes without fleet Pod-read RBAC", () => {
    expect(workflow).toContain(
      `.metadata.labels["node-role.kubernetes.io/control-plane"] == null`,
    );
    expect(workflow).toContain(
      `or .metadata.labels["shizuha.io/platform"] == "true"`,
    );
    expect(workflow).not.toContain(`kubectl get pods -n shizuha-fleet`);
    expect(workflow).not.toContain(`ACTIVE_AGENT_NODES`);
    expect(workflow).not.toContain(
      `-l '!node-role.kubernetes.io/control-plane'`,
    );
  });
});
