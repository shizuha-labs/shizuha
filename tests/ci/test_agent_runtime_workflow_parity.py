"""Canonical agent-runtime workflow safety and release-authority parity."""
from pathlib import Path
import json
import os
import subprocess
import textwrap
import unittest

from tests.ci.test_runtime_release_concurrency import RuntimeReleaseConcurrencyTests

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".forgejo" / "workflows" / "build-agent-runtime.yml"
LOCK = ROOT / "runtime-skills.lock"
DOCKERFILE = ROOT / "Dockerfile.agent-runtime"


class AgentRuntimeWorkflowParityTests(unittest.TestCase):
    def _actual_overlay_selection(self, registry_status, explicit=False):
        text = WORKFLOW.read_text()
        start = text.index('          OVERLAY_ELIGIBLE=false')
        end = text.index('\n          render_overlay_job() {', start)
        selection = textwrap.dedent(text[start:end])
        env = os.environ | {
            'CC_VER': '2.1.302', 'CODEX_VER': '0.163.0',
            'ANTIGRAVITY_VER': '1.4.0', 'OPENCLAW_VER': '2026.10.4',
            'OVERLAY_BASE_CC_VER': '2.1.296', 'OVERLAY_BASE_CODEX_VER': '0.162.1',
            'OVERLAY_BASE_ANTIGRAVITY_VER': '1.3.3',
            'OVERLAY_BASE_OPENCLAW_VER': '2026.10.1',
            'OVERLAY_BASE_SOURCE_SHA': 'a' * 40, 'SOURCE_SHA': 'b' * 40,
            'OVERLAY_BASE_INDEX_DIGEST': 'sha256:' + 'c' * 64,
            'SOURCE_BRANCH': 'master', 'REG': 'registry.invalid', 'IMG': 'runtime',
            'REGISTRY_STATUS': registry_status,
            'INPUT_CLAUDE_CODE_VERSION': '', 'INPUT_CODEX_VERSION': '',
            'INPUT_ANTIGRAVITY_VERSION': '1.4.0' if explicit else '',
            'INPUT_OPENCLAW_VERSION': '',
        }
        # Execute the actual source decision, isolating only its network and
        # source-eligibility instruments. No build, fetch or registry write.
        instruments = '''set -euo pipefail
git() { return 0; }
curl() { printf '%s' "$REGISTRY_STATUS"; }
python3() {
  case " $* " in
    *" --claude-code 2.1.296 "*) return 0 ;;
    *) return 1 ;;
  esac
}
'''
        result = subprocess.check_output(['bash', '-c', instruments + selection +
            '\nprintf "SELECTION=%s|%s|%s|%s|%s\\n" "$OVERLAY_ELIGIBLE" '
            '"$CC_VER" "$CODEX_VER" "$ANTIGRAVITY_VER" "$OPENCLAW_VER"'],
            text=True, env=env)
        return next(line.removeprefix('SELECTION=') for line in result.splitlines()
                    if line.startswith('SELECTION='))

    def test_missing_overlay_base_restores_resolved_full_build_versions(self):
        self.assertEqual(self._actual_overlay_selection('404'),
                         'false|2.1.302|0.163.0|1.4.0|2026.10.4')

    def test_available_overlay_base_keeps_its_smoked_harness_versions(self):
        self.assertEqual(self._actual_overlay_selection('200'),
                         'true|2.1.296|0.162.1|1.3.3|2026.10.1')

    def test_explicit_harness_intent_is_preserved_when_overlay_is_ineligible(self):
        self.assertEqual(self._actual_overlay_selection('404', explicit=True),
                         'false|2.1.302|0.163.0|1.4.0|2026.10.4')

    def test_actual_native_builder_render_allows_repaired_i9_path(self):
        from tests.ci._mini_yaml import loads
        text = WORKFLOW.read_text()
        start = text.index("          render_build_job() {")
        end = text.index("\n          }", start) + len("\n          }")
        renderer = textwrap.dedent(text[start:end])
        env = os.environ | {"CANDIDATE_TAG": "candidate-123", "SOURCE_SHA": "a" * 40,
                            "SKILLS_SHA": "b" * 40, "REG": "registry.example.org", "IMG": "runtime"}
        output = subprocess.check_output(["bash", "-c", renderer + "\nrender_build_job amd64"],
                                         text=True, env=env)
        lines = output.splitlines()
        first = next(i for i, line in enumerate(lines) if line.strip().startswith("nodeSelector:"))
        last = next(i for i, line in enumerate(lines[first:], first) if line.strip() == "initContainers:")
        scheduling = textwrap.dedent("\n".join(lines[first:last]))
        selector_line = next(line for line in scheduling.splitlines() if line.startswith("nodeSelector:"))
        selector = loads(selector_line)["nodeSelector"]
        required = scheduling.split("requiredDuringSchedulingIgnoredDuringExecution:", 1)[1]
        rules = [loads("rule: " + line.strip()[2:])["rule"]
                 for line in required.splitlines() if line.strip().startswith("- {")]
        tolerations = [loads("rule: " + line.strip()[2:])["rule"]
                       for line in scheduling.split("affinity:", 1)[0].splitlines()
                       if line.strip().startswith("- {")]
        def eligible(labels):
            if any(labels.get(key) != value for key, value in selector.items()):
                return False
            def matches(rule):
                if rule["operator"] == "DoesNotExist":
                    return rule["key"] not in labels
                if rule["operator"] == "NotIn":
                    return labels.get(rule["key"]) not in rule["values"]
                raise AssertionError("Unreviewed scheduling operator")
            return all(matches(rule) for rule in rules)
        i9 = {"kubernetes.io/arch": "amd64", "kubernetes.io/hostname": "i9-ws"}
        self.assertTrue(eligible(i9), "repaired native builder must no longer be excluded")
        s1 = i9 | {"kubernetes.io/hostname": "s1"}
        self.assertTrue(eligible(s1), "busy host remains fallback capacity")
        preferred = scheduling.split("preferredDuringSchedulingIgnoredDuringExecution:", 1)[1].split("requiredDuringSchedulingIgnoredDuringExecution:", 1)[0]
        preferences = [loads("rule: " + line.strip()[2:])["rule"]
                       for line in preferred.splitlines() if line.strip().startswith("- {")]
        self.assertEqual(len(preferences), 1)
        preference = preferences[0]
        self.assertEqual(preference["operator"], "NotIn")
        self.assertNotIn(i9[preference["key"]], preference["values"])
        self.assertIn(s1[preference["key"]], preference["values"])
        self.assertFalse(eligible(i9 | {"kubernetes.io/arch": "arm64"}))
        self.assertFalse(eligible(i9 | {"node-role.kubernetes.io/control-plane": "true"}))
        self.assertIn({"key": "node.shizuha/workstation", "operator": "Exists", "effect": "NoSchedule"}, tolerations)

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
        # Last smoked multi-arch is the overlay rootfs. Source-only SCLI must
        # not fall through to full Kaniko just because npm latest drifted.
        self.assertIn('Last smoked multi-arch: harness-202610110610-20efecd', text)
        self.assertIn(
            'OVERLAY_BASE_INDEX_DIGEST="sha256:f409d3aeec3b46715cea1a4ae4373d6cc6738817a9a7234825e00dc72f0f13ea"',
            text,
        )
        self.assertIn(
            'OVERLAY_BASE_SOURCE_SHA="20efecdfef05505d8b446aa0b7d13c11dca304fa"',
            text,
        )
        for key, version in (('CC', '2.1.296'), ('CODEX', '0.162.1'),
                             ('ANTIGRAVITY', '1.3.3'), ('OPENCLAW', '2026.10.1')):
            self.assertIn(f'OVERLAY_BASE_{key}_VER="{version}"', text)
        self.assertIn(
            'pinning harness to last smoked overlay base (npm latest drifted)',
            text,
        )
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

    def test_legacy_orphan_cleanup_is_exact_and_native_authority_gated(self):
        text = WORKFLOW.read_text()
        cleanup = text.index('python3 scripts/verify-runtime-release-concurrency.py')
        fence = text.index("wait_for_prior_runtime_release_jobs()")
        section = text[cleanup:fence]

        self.assertIn('--run-id "$ORIGIN_RUN_ID" --source-sha "$SOURCE_SHA"', section)
        self.assertIn('--source-ref "refs/heads/${SOURCE_BRANCH}"', section)
        self.assertIn('--repository shizuha-labs/shizuha', section)
        self.assertIn(
            "^ci-build-agentrt-harness-[0-9]{12}-[0-9a-f]{7}-(amd64|arm64)$",
            section,
        )
        self.assertIn(".status.conditions[]?", section)
        self.assertIn("kubectl logs", section)
        self.assertIn('kubectl delete job -n build "$legacy_job" --wait=true', section)
        self.assertNotIn("candidate-", section)
        self.assertIn("      - 'scripts/verify-runtime-release-concurrency.py'", text)
        self.assertNotIn("live_coalescer", text)

    def test_browser_payload_uses_qualified_internal_donor(self):
        text = DOCKERFILE.read_text()
        workflow = (
            ROOT / ".forgejo" / "workflows" / "build-agent-runtime.yml"
        ).read_text()
        package_lock = json.loads((ROOT / "package-lock.json").read_text())

        # Public-first Dockerfile (2026-09-22): the donor is an ARG. The public
        # default is the official Microsoft Playwright image; the INTERNAL
        # donor digest moved from the Dockerfile into the CI build-args below —
        # qualified donor advanced 2026-09-19 (PLAT-9231): the prior donor
        # index digest 02137f09… was garbage-collected from the registry
        # (PLAT-9225 loss class; build run 6752 on 35316466
        # MANIFEST_UNKNOWN, both attempts), so the donor moved to
        # the live harness-202609170222-58dba8c index digest. The
        # in-Dockerfile post-COPY assertions (chromium-1208 /
        # chromium_headless_shell-1208 / ffmpeg-1011) remain the payload
        # qualification for either donor; the internal donor was built from
        # beta master 58dba8c with the same playwright 1.58.2 lockfile.
        self.assertIn(
            "ARG PLAYWRIGHT_DONOR_IMAGE=mcr.microsoft.com/playwright:v1.58.2-noble",
            text,
        )
        self.assertIn(
            "FROM ${PLAYWRIGHT_DONOR_IMAGE} AS playwright-donor",
            text,
        )
        self.assertIn(
            "--build-arg=PLAYWRIGHT_DONOR_IMAGE=registry.registry.svc.cluster.local:"
            "5000/shizuha-agent-runtime@"
            "sha256:f11a905ba5998ea7072b787bf961abf88ec7b8e801a64e595529d308e8df761e",
            workflow,
        )
        self.assertIn(
            "--build-arg=PLAYWRIGHT_BROWSERS_SRC=/opt/playwright-browsers",
            workflow,
        )
        self.assertIn(
            "COPY --from=playwright-donor ${PLAYWRIGHT_BROWSERS_SRC} "
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
