"""Canonical agent-runtime workflow safety and release-authority parity."""
from pathlib import Path
import json
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".forgejo" / "workflows" / "build-agent-runtime.yml"
LOCK = ROOT / "runtime-skills.lock"
DOCKERFILE = ROOT / "Dockerfile.agent-runtime"


class AgentRuntimeWorkflowParityTests(unittest.TestCase):
    def test_harness_release_metadata_authority_and_install_cache(self):
        text = WORKFLOW.read_text()
        self.assertIn('NPM_META_REG="https://registry.npmjs.org"', text)
        self.assertIn(
            '"${NPM_META_REG}/${encoded_pkg}/latest" -o "$response"', text
        )
        for option in (
            "--connect-timeout 15",
            "--max-time 120",
            "--retry 12",
            "--retry-all-errors",
            "--retry-delay 5",
        ):
            self.assertIn(option, text)

        for assignment in (
            '[ -n "$CC_VER" ] || CC_VER="$(npm_latest \'%40anthropic-ai%2Fclaude-code\')"',
            '[ -n "$CODEX_VER" ] || CODEX_VER="$(npm_latest \'%40openai%2Fcodex\')"',
            '[ -n "$OPENCLAW_VER" ] || OPENCLAW_VER="$(npm_latest \'openclaw\')"',
        ):
            self.assertIn(assignment, text)
        # Antigravity CLI is a native binary — never installed from npm gemini-cli.
        self.assertIn('ANTIGRAVITY_VER', text)
        self.assertIn('antigravity-cli-auto-updater', text)
        self.assertIn('antigravity_version', text)
        self.assertNotIn('GEMINI_VER', text)
        self.assertNotIn('gemini_version', text)
        self.assertNotIn("npm_latest '%40google%2Fgemini-cli'", text)
        self.assertNotIn("npm_exact_available_in_cache '%40google%2Fgemini-cli'", text)

        verdaccio = "http://npm-cache.registry.svc.cluster.local:4873"
        self.assertNotIn('"${NPM_REG}/${encoded_pkg}/latest"', text)
        self.assertIn(f"npm ci --ignore-scripts --registry={verdaccio}", text)
        self.assertIn(f'NPM_CONFIG_REGISTRY, value: "{verdaccio}/"', text)
        self.assertIn(f"--build-arg=NPM_CONFIG_REGISTRY={verdaccio}/", text)

    def test_skills_lock_and_materialization(self):
        text = WORKFLOW.read_text()
        self.assertTrue(LOCK.exists(), "runtime-skills.lock must exist")
        sha = LOCK.read_text().strip()
        self.assertRegex(sha, r"^[0-9a-f]{40}$")
        self.assertIn("runtime-skills.lock", text)
        self.assertIn("SKILLS_SHA", text)
        self.assertIn(".runtime-skills", text)
        self.assertIn("SKILL.md", text)
        self.assertTrue("wc -l" in text or "skill_count" in text)
        self.assertIn("fetch --depth=1 origin", text)
        self.assertIn("rev-parse HEAD", text)

    def test_shared_guard_is_the_only_dual_arch_terminal_observer(self):
        text = WORKFLOW.read_text()
        self.assertIn("render_build_job amd64", text)
        self.assertIn("render_build_job arm64", text)
        guard = text.index('python3 "$BUILD_GUARD" wait-pair')
        smoke_gate = text.index("render_smoke_job()", guard)
        after_guard = text[guard:smoke_gate]

        self.assertIn('--job "amd64=${AMD64_JOB}"', after_guard)
        self.assertIn('--job "arm64=${ARM64_JOB}"', after_guard)
        self.assertIn("--timeout-seconds 1800", after_guard)
        self.assertIn("trap - EXIT INT TERM", after_guard)
        self.assertNotIn("wait_job()", after_guard)
        self.assertNotIn("--for=condition=complete", after_guard)
        self.assertIn("activeDeadlineSeconds: 4200", text)

    def test_superseded_runner_preserves_external_builder_progress(self):
        text = WORKFLOW.read_text()
        wait = text.index("wait_for_prior_runtime_release_jobs()")
        own_cleanup = text.index(
            'kubectl delete job -n build "ci-build-agentrt-${CANDIDATE_TAG}-amd64"'
        )
        render = text.index("render_build_job amd64 | kubectl apply -f -")

        self.assertLess(wait, own_cleanup)
        self.assertLess(own_cleanup, render)
        self.assertIn("SECONDS + 4500", text[wait:own_cleanup])
        self.assertIn("service=agent-runtime", text[wait:own_cleanup])
        self.assertIn('.status.conditions[]?', text[wait:own_cleanup])
        self.assertIn('.type == "Complete"', text[wait:own_cleanup])
        self.assertIn('.type == "Failed"', text[wait:own_cleanup])
        self.assertNotIn(".status.active", text[wait:own_cleanup])
        self.assertNotIn("Deleting superseded active runtime builder", text)
        self.assertNotIn(
            'kubectl delete job -n build "$stale_job"', text
        )
        self.assertNotIn("deleting superseded active runtime pre-pull", text)

    def test_release_candidates_and_evidence_jobs_are_run_scoped(self):
        text = WORKFLOW.read_text()

        self.assertIn("ORIGIN_RUN_ID: ${{ github.run_id }}", text)
        self.assertIn('CANDIDATE_TAG="candidate-${RUN_ID}-${SHORT_SHA}"', text)
        self.assertIn(
            "--destination=${REG}/${IMG}:${CANDIDATE_TAG}-${ARCH}", text
        )
        self.assertIn(
            '"$ARCH" "$CANDIDATE_TAG" "$IMG"', text
        )
        self.assertIn("ci-manifest-agentrt-${CANDIDATE_TAG}", text)
        self.assertIn("ci-prepull-agentrt-${CANDIDATE_TAG}-${NODE}", text)
        self.assertIn('select(.metadata.labels["shizuha.io/disk-class"] != "small")', text)
        self.assertIn("activeDeadlineSeconds: 900", text)

    def test_legacy_orphan_cleanup_is_exact_and_live_coalescer_gated(self):
        text = WORKFLOW.read_text()
        cleanup = text.index('live_coalescer="$(kubectl exec')
        fence = text.index("wait_for_prior_runtime_release_jobs()")
        section = text[cleanup:fence]

        self.assertIn('"build-agent-runtime.yml"', section)
        self.assertIn(
            "^ci-build-agentrt-harness-[0-9]{12}-[0-9a-f]{7}-(amd64|arm64)$",
            section,
        )
        self.assertIn(".status.conditions[]?", section)
        self.assertIn("kubectl logs", section)
        self.assertIn('kubectl delete job -n build "$legacy_job" --wait=true', section)
        self.assertNotIn("candidate-", section)
        self.assertIn('-l app=run-coalescer -o json', text)
        self.assertIn('select(.status.phase == "Running")', text)
        self.assertIn('sort_by(.metadata.name)', text)
        self.assertIn(
            'kubectl exec -n origin "$live_coalescer_pod"', text
        )
        self.assertNotIn(
            'kubectl exec -n origin deployment/run-coalescer', text
        )
        self.assertNotIn("cat /app/server.py' 2>/dev/null || true", text)

    def test_browser_payload_uses_qualified_internal_donor(self):
        text = DOCKERFILE.read_text()
        package_lock = json.loads((ROOT / "package-lock.json").read_text())

        self.assertIn(
            "registry.registry.svc.cluster.local:5000/shizuha-agent-runtime@"
            "sha256:a1c8a4935fd098217f52926505b08e050ffdd230e6a32f01222fe5774a76d4f5 "
            "AS playwright-donor",
            text,
        )
        self.assertIn(
            "COPY --from=playwright-donor /opt/playwright-browsers "
            "/opt/playwright-browsers",
            text,
        )
        self.assertIn("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci", text)
        self.assertIn("install-deps chromium", text)
        self.assertIn("qualified browser donor mismatch", text)
        self.assertNotIn("install chromium --with-deps", text)
        self.assertEqual(
            package_lock["packages"]["node_modules/playwright"]["version"],
            "1.58.2",
        )
        for directory in (
            "chromium-1208",
            "chromium_headless_shell-1208",
            "ffmpeg-1011",
        ):
            self.assertIn(f"/opt/playwright-browsers/{directory}", text)


if __name__ == "__main__":
    unittest.main()
