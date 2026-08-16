"""PLAT-4720 — the full-suite gate must be fail-closed, and must run PR code without credentials.

This is the committed negative control. A negative control run once by hand proves the
gate worked that day; what holds over time is a check that FAILS when the gate is
weakened. Every assertion here is written so that removing the corresponding guard from
the workflow turns this test red.

The class of defect being guarded is "a green that verified nothing" — a Job that
dispatches, exits 0, and compiled or tested nothing. Instances hit in one day across
three substrates: a Go toolchain gate that passed having compiled nothing (PLAT-4718), a
deny-only authz probe that passed against a surface serving nothing (PLAT-5685), and a
bind-mount that silently mounted nothing so the suite never ran (@sara, exit=126).
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / ".forgejo" / "workflows" / "premerge-full-suite.yml"


class FullSuiteGateFailClosedTests(unittest.TestCase):
    def setUp(self):
        self.text = GATE.read_text()

    # ---- axis 1: the Job must not be able to retry its way to green ----------

    def test_job_does_not_retry_failures_into_success(self):
        # backoffLimit > 0 would let a flaky/failing pod be retried until it passed,
        # converting a real failure into a green gate.
        self.assertIn("backoffLimit: 0", self.text)

    def test_failed_pod_count_is_checked_not_just_wait_condition(self):
        # `kubectl wait --for=condition=complete` alone is not sufficient evidence.
        self.assertIn(".status.failed", self.text)
        self.assertIn('if [ -n "${FAILED}" ] && [ "${FAILED}" != "0" ]', self.text)

    # ---- axis 2: the suite must PROVE it executed ---------------------------

    def test_gate_requires_a_test_summary_in_the_job_log(self):
        # Completion is not proof of execution. The gate must read the suite's own
        # summary back out of the Job log.
        self.assertIn("tests: [0-9]+ passed", self.text)
        self.assertIn(
            "no full-suite summary in Job log", self.text,
            msg="gate must fail explicitly when the suite produced no summary",
        )

    def test_gate_rejects_a_zero_collected_run(self):
        # THE load-bearing assertion. "summary line present" passes against a suite
        # that collected 0 tests; only a count comparison catches it.
        self.assertIn('[ "${PASSED}" -le 0 ]', self.text)
        self.assertIn("verified nothing", self.text)

    def test_no_soft_failure_operators_on_the_pass_path(self):
        # `|| true` on a verification step is how a gate silently goes inert.
        # Cleanup and log-tailing may swallow errors; assertions may not.
        for line in self.text.splitlines():
            stripped = line.strip()
            if "|| true" not in stripped:
                continue
            self.assertTrue(
                stripped.startswith("#")
                or "logs" in stripped
                or "--ignore-not-found" in stripped
                or "delete job" in stripped
                or "echo 0" in stripped,
                msg=f"`|| true` on a non-cleanup line can make the gate inert: {stripped}",
            )

    # ---- the suite must not run as root -------------------------------------

    def test_suite_does_not_run_as_root(self):
        """Root bypasses file permission bits, so tests that assert a read-only
        file CANNOT be written pass as any normal uid and fail as root.

        This repo has three such tests (tests/daemon/workspace-writable-repair,
        tests/daemon/sqlite-writable-repair). Measured both ways on the same
        checkout: 3 failed / 3040 passed as root; the same six tests 6/6 green as
        uid 1000. Without an explicit non-root uid the gate red-lights every PR on
        an environment mismatch — and presents it as the suite finding real bugs,
        which is the most expensive kind of wrong.
        """
        self.assertIn("runAsNonRoot: true", self.text)
        self.assertRegex(
            self.text, r"runAsUser: [1-9]\d{2,}",
            msg="the Job must pin a non-root uid, not inherit the image default (root)",
        )
        self.assertRegex(
            self.text, r"fsGroup: [1-9]\d{2,}",
            msg="the shared emptyDir needs a matching fsGroup or the non-root suite "
                "cannot write node_modules",
        )

    # ---- the security property: PR code runs with no credentials ------------

    def test_pr_code_executes_without_kubeconfig_or_secrets(self):
        """The runner dispatches; the Job executes. PR-authored code must not run
        beside a cluster credential — the PLAT-4718 defect, where moving a gate onto
        the secret-bearing lane made it green and exposed KUBE_CONFIG_B64 to PR code."""
        block = re.search(
            r"- name: fullsuite\n(.*?)(?=\n\s*volumes:)", self.text, re.S
        )
        self.assertIsNotNone(block, "fullsuite test container not found in the gate")
        body = block.group(1)
        for forbidden in ("secretKeyRef", "KUBE_CONFIG", "GIT_PASSWORD", "secrets."):
            self.assertNotIn(
                forbidden, body,
                msg=f"test container must carry no credential, found {forbidden!r}",
            )

    def test_only_the_clone_step_holds_a_credential(self):
        # The repo-read token is required to fetch the PR source; it belongs to the
        # initContainer, which does nothing but clone.
        clone = re.search(r"- name: git-clone\n(.*?)(?=\n\s*containers:)", self.text, re.S)
        self.assertIsNotNone(clone)
        self.assertIn("secretKeyRef", clone.group(1))
        self.assertIn("forgejo-token", clone.group(1))

    # ---- the credential must not reach the SHARED VOLUME either ------------
    #
    # test_pr_code_executes_without_kubeconfig_or_secrets asserts the test
    # container's manifest env. That assertion was true while the credential was
    # readable anyway, because `git clone http://user:token@host/...` persists the
    # token into .git/config and /workspace is an emptyDir both containers mount
    # (@sara, PLAT-4720 review). Right instrument, wrong subject.
    #
    # So these assert the transport property, not the env proxy.

    def test_clone_does_not_embed_the_credential_in_the_url(self):
        clone = re.search(r"- name: git-clone\n(.*?)(?=\n\s*containers:)", self.text, re.S)
        self.assertIsNotNone(clone)
        body = clone.group(1)
        self.assertNotRegex(
            body, r"://[^\s\"']*\$\{?GIT_PASSWORD\}?@",
            msg="credential in the clone URL persists to .git/config, which the PR-code "
                "container can read off the shared emptyDir; use `git -c http.extraheader`",
        )

    def test_clone_uses_invocation_scoped_config_not_persisted_config(self):
        """`git -c <k>=<v> clone` is invocation-scoped. `git clone -c <k>=<v>` writes
        the value into the NEW repo's config — same defect by a different route.
        Both forms were verified empirically before relying on the distinction."""
        clone = re.search(r"- name: git-clone\n(.*?)(?=\n\s*containers:)", self.text, re.S)
        body = clone.group(1)
        self.assertIn("http.extraheader", body)
        self.assertRegex(body, r"git -c http\.extraheader",
                         msg="`-c` must precede the subcommand to stay invocation-scoped")
        self.assertNotRegex(
            body, r"git\s+(clone|fetch)\s+(-c|--config)\s",
            msg="`git clone -c` persists the header into .git/config — use `git -c ... clone`",
        )

    def test_workspace_is_scrubbed_and_the_property_is_checked_at_runtime(self):
        """Static assertions cannot see what lands on a shared volume at runtime, so
        the Job must check itself and fail closed before handing off."""
        clone = re.search(r"- name: git-clone\n(.*?)(?=\n\s*containers:)", self.text, re.S)
        body = clone.group(1)
        self.assertIn("rm -rf /workspace/src/.git", body,
                      msg="git metadata must not reach the PR-code container")
        self.assertRegex(
            body, r"grep -rqIF .*GIT_PASSWORD.* /workspace",
            msg="the Job must verify no credential material survives in the shared volume",
        )
        self.assertIn("refusing handoff", body,
                      msg="the residue check must fail closed with a stated reason")

    # ---- injection class (PLAT-4734 / PLAT-4740) ---------------------------

    def test_github_context_is_bound_through_env_not_interpolated_into_shell(self):
        """semgrep run-shell-injection / CWE-78: `${{ github.* }}` inside a `run:`
        body lets branch-controlled text reach the shell."""
        in_run = False
        indent = 0
        offenders = []
        for lineno, line in enumerate(self.text.splitlines(), 1):
            if re.search(r"(^|\s)run:\s*\|?\s*$", line):
                in_run = True
                indent = len(line) - len(line.lstrip())
                continue
            if not in_run:
                continue
            body_indent = len(line) - len(line.lstrip())
            if line.strip() and body_indent <= indent and not line.strip().startswith("#"):
                in_run = False
            elif "${{" in line and "github." in line:
                offenders.append((lineno, line.strip()))
        self.assertEqual(offenders, [], msg=f"github context interpolated into shell: {offenders}")


if __name__ == "__main__":
    unittest.main()


class BrokerTokenAmbientSocketIsolationTests(unittest.TestCase):
    """PLAT-4720 acceptance: broker-token null-path tests must not depend on
    ambient DEFAULT_BROKER_SOCKET absence.

    Fleet pods have /run/shizuha/mcp-auth-proxy/proxy.sock; a test that only
    `delete process.env.MCP_AUTH_PROXY_SOCKET` then expects null will fail there
    while passing on clean GitHub/Job runners.
    """

    def setUp(self):
        self.text = (ROOT / "tests" / "auth" / "broker-token.test.ts").read_text()

    def test_null_broker_cases_use_explicit_absent_socket_path(self):
        self.assertIn("absent-broker-", self.text)
        self.assertIn("absent-model-broker-", self.text)
        self.assertIn("PLAT-4720", self.text)

    def test_null_cases_do_not_rely_on_bare_env_delete_alone(self):
        # The historical defect: delete process.env[ENV] then expect null.
        # Allow delete in afterEach cleanup, but the two null-path bodies must
        # set an explicit absent path.
        import re
        # Extract the two it() blocks that assert null when no broker
        for needle in (
            "returns null from fetchBrokerToken when no broker is present",
            "returns null when no broker is present",
        ):
            idx = self.text.find(needle)
            self.assertGreater(idx, 0, msg=f"missing test: {needle}")
            chunk = self.text[idx:idx + 1200]
            self.assertIn("process.env[ENV] =", chunk, msg=f"{needle} must set ENV")
            self.assertIn(".sock", chunk, msg=f"{needle} must point at a socket path")
