"""The release caller must prove native authority before any legacy cleanup."""

import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify-runtime-release-concurrency.py"
SPEC = importlib.util.spec_from_file_location("runtime_concurrency", SCRIPT)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
SOURCE = "a" * 40
REF = "refs/heads/master"
REPOSITORY = "shizuha-labs/shizuha"
PROJECTED = b"exact qualified observer source\n"
PROJECTED_SHA = hashlib.sha256(PROJECTED).hexdigest()


def pod():
    return {
        "metadata": {"name": "run-coalescer-current", "uid": "pod-uid"},
        "status": {
            "phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
            "containerStatuses": [{"name": "coalescer", "ready": True, "containerID": "containerd://current"}],
        },
    }


class Cursor:
    def __init__(self, fixture):
        self.fixture = fixture
        self.index = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, parameters):
        if not query.startswith("SELECT "):
            raise AssertionError("non-read-only query")
        self.fixture.queries.append((query, parameters))

    def fetchone(self):
        self.index += 1
        return self.fixture.row if self.index == 1 else self.fixture.older


class Connection:
    def __init__(self, fixture):
        self.fixture = fixture

    def set_session(self, **kwargs):
        self.fixture.session = kwargs

    def cursor(self):
        return Cursor(self.fixture)

    def close(self):
        self.fixture.closed += 1


class RuntimeReleaseConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.row = (40, guard.WORKFLOW, REF, SOURCE, None, ".forgejo/workflows", 1, guard.GROUP, 6, "push")
        self.older = None
        self.version = {"authority": guard.AUTHORITY, "source_sha256": PROJECTED_SHA}
        self.projected = PROJECTED
        self.queries = []
        self.connections = []
        self.closed = 0
        self.session = None
        self.calls = []
        self.inventory = {"items": [pod()]}
        self.current = pod()
        self.corrupt_receipt = False
        self.fail_exec = False
        self.addCleanup(patch.stopall)
        patch.object(guard, "OBSERVER_SHA256", PROJECTED_SHA).start()
        patch.object(guard.urllib.request, "urlopen", side_effect=self.urlopen).start()
        self.read_bytes = Path.read_bytes
        patch.object(Path, "read_bytes", side_effect=self.read_projected, autospec=True).start()
        patch.dict(sys.modules, {"psycopg2": types.SimpleNamespace(connect=self.connect)}).start()

    def read_projected(self, path):
        if str(path) == "/app/server.py":
            return self.projected
        return self.read_bytes(path)

    def urlopen(self, url, timeout):
        self.assertEqual(url, "http://127.0.0.1:8080/version")
        self.assertEqual(timeout, 10)
        return io.BytesIO(json.dumps(self.version).encode())

    def connect(self, **kwargs):
        self.connections.append(kwargs)
        return Connection(self)

    def transport(self, arguments, **kwargs):
        self.calls.append(arguments)
        self.assertEqual(arguments[0], "kubectl")
        self.assertEqual(kwargs["timeout"], 45)
        self.assertTrue(kwargs["check"])
        if arguments[1:3] == ["get", "pods"]:
            result = self.inventory
        elif arguments[1] == "exec":
            if self.fail_exec:
                raise subprocess.CalledProcessError(1, arguments)
            self.assertEqual(kwargs["input"], SCRIPT.read_text())
            self.assertIn("coalescer", arguments)
            result = guard.remote_receipt(
                int(arguments[arguments.index("--run-id") + 1]),
                arguments[arguments.index("--source-sha") + 1],
                arguments[arguments.index("--source-ref") + 1],
                arguments[arguments.index("--repository") + 1],
            )
            if self.corrupt_receipt:
                result["source_commit"] = "b" * 40
        elif arguments[1:3] == ["get", "pod"]:
            result = self.current
        else:
            raise AssertionError(f"unexpected operation: {arguments}")
        return subprocess.CompletedProcess(arguments, 0, json.dumps(result), "")

    def invoke(self, run_id=42, source=SOURCE):
        argv = [str(SCRIPT), "--run-id", str(run_id), "--source-sha", source,
                "--source-ref", REF, "--repository", REPOSITORY]
        with patch.object(sys, "argv", argv), patch.object(guard.subprocess, "run", side_effect=self.transport):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                guard.main()
            return json.loads(output.getvalue())

    def test_actual_main_checks_runtime_compiled_policy_and_incarnation_twice(self):
        first = self.invoke()
        self.assertEqual(first["run_id"], 42)
        self.assertEqual(first["observer_pod_uid"], "pod-uid")
        self.assertEqual(first["observer_container_id"], "containerd://current")
        self.assertEqual(self.session, {"readonly": True, "isolation_level": "REPEATABLE READ"})
        self.assertIn("default_transaction_read_only=on", self.connections[0]["options"])
        self.assertIn("statement_timeout=10000", self.connections[0]["options"])
        self.assertEqual(self.closed, 1)
        self.assertEqual(self.queries[0][1], (42, "shizuha", "shizuha-labs"))
        self.assertEqual(self.queries[1][1], (40, guard.GROUP, 42))
        self.row = (*self.row[:3], "b" * 40, *self.row[4:])
        second = self.invoke(43, "b" * 40)
        self.assertEqual(second["run_id"], 43)
        self.assertEqual(self.closed, 2)

    def test_retired_text_contract_rejects_valid_native_observer(self):
        self.assertNotIn(b'"build-agent-runtime.yml"', PROJECTED)
        self.assertEqual(self.invoke()["compiled_policy"], "queue-behind")

    def test_legacy_or_unknown_runtime_version_rejected_before_database(self):
        for version in ({}, {"protected_workflows": [guard.WORKFLOW]},
                        {"authority": "legacy-sql-cancellation", "source_sha256": PROJECTED_SHA},
                        {"authority": guard.AUTHORITY, "source_sha256": "b" * 64}):
            with self.subTest(version=version):
                self.version = version
                with self.assertRaisesRegex(RuntimeError, "authority/source"):
                    self.invoke()
                self.assertFalse(self.connections)

    def test_projection_changed_while_old_process_running_rejected(self):
        self.projected = b"different projected source"
        with self.assertRaisesRegex(RuntimeError, "projected observer"):
            self.invoke()
        self.assertFalse(self.connections)

    def test_native_policy_identity_and_cancelled_owner_fail_closed(self):
        original = self.row
        for position, value in (
            (1, "different.yml"), (2, "refs/heads/other"), (3, "b" * 40),
            (4, "b" * 40), (5, ".github/workflows"), (6, 0), (6, 2),
            (6, None), (7, "other"), (8, 3), (8, 5), (8, 7), (9, "pull_request"),
        ):
            with self.subTest(position=position, value=value):
                self.row = tuple(value if index == position else field for index, field in enumerate(original))
                with self.assertRaisesRegex(RuntimeError, "identity/native"):
                    self.invoke()
        self.row = None
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            self.invoke()

    def test_workflow_dispatch_and_explicit_source_commit_are_supported(self):
        self.row = (*self.row[:4], SOURCE, *self.row[5:9], "workflow_dispatch")
        self.assertEqual(self.invoke()["compiled_policy"], "queue-behind")

    def test_older_nonterminal_owner_blocks_then_rearms_after_terminal(self):
        self.older = (41,)
        with self.assertRaisesRegex(RuntimeError, "older native release owner"):
            self.invoke()
        self.older = None
        self.assertEqual(self.invoke()["older_nonterminal_runs"], 0)
        self.older = (40,)
        with self.assertRaisesRegex(RuntimeError, "older native release owner"):
            self.invoke()

    def test_missing_ambiguous_deleting_and_unready_observers_fail_closed(self):
        for inventory in ([], [pod(), pod()]):
            self.inventory["items"] = inventory
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                self.invoke()
        invalid = pod()
        invalid["metadata"]["deletionTimestamp"] = "2026-09-14T00:00:00Z"
        self.inventory["items"] = [invalid]
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.invoke()
        invalid = pod()
        invalid["status"]["conditions"] = []
        self.inventory["items"] = [invalid]
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.invoke()

    def test_real_old_error_pod_does_not_shadow_current_ready_instance(self):
        failed = pod()
        failed["metadata"]["name"] = "run-coalescer-old-error"
        failed["status"]["phase"] = "Failed"
        self.inventory["items"] = [failed, pod()]
        self.assertEqual(self.invoke()["observer_pod_uid"], "pod-uid")

    def test_post_observation_pod_uid_container_or_readiness_change_rejected(self):
        for variant in ("uid", "container", "ready"):
            with self.subTest(variant=variant):
                self.current = pod()
                if variant == "uid":
                    self.current["metadata"]["uid"] = "replacement"
                elif variant == "container":
                    self.current["status"]["containerStatuses"][0]["containerID"] = "containerd://replacement"
                else:
                    self.current["status"]["containerStatuses"][0]["ready"] = False
                with self.assertRaisesRegex(RuntimeError, "incarnation changed"):
                    self.invoke()

    def test_unreadable_remote_and_tampered_receipt_are_not_forgiven(self):
        self.fail_exec = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke()
        self.fail_exec = False
        self.corrupt_receipt = True
        with self.assertRaisesRegex(RuntimeError, "receipt mismatch"):
            self.invoke()

    def test_cli_preflight_rejects_invalid_source_before_cluster_read(self):
        with self.assertRaisesRegex(ValueError, "invalid release"):
            self.invoke(source="not-a-sha")
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
