"""Immutable runtime qualification caller and failure-boundary regressions."""

import argparse
import base64
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import qualify_agent_runtime as qualification

SOURCE = "a" * 40
WORKFLOW = "b" * 40
SKILLS = "c" * 40
INDEX = "sha256:" + "1" * 64
CHILDREN = {"amd64": "sha256:" + "2" * 64, "arm64": "sha256:" + "3" * 64}
VERSIONS = {"claude_code": "2.1.281", "codex": "0.156.1", "antigravity": "1.2.10",
            "openclaw": "2026.9.6", "scli": "0.1.0.202609240842"}
TAG = "harness-202609240842-aaaaaaa"
LOG = (f"2026-09-24T08:42:00Z Building shizuha-agent-runtime:{TAG} claude-code=2.1.281 codex=0.156.1 antigravity=1.2.10 openclaw=2026.9.6 scli=0.1.0.202609240842\n"
       "2026-09-24T08:54:00Z ::error::runtime image fleet pre-pull failed on gx10-8\n")


def node(name, *, ready=True, labels=None, unschedulable=False):
    return {"metadata": {"name": name, "labels": labels or {}},
            "spec": {"unschedulable": unschedulable},
            "status": {"conditions": [{"type": "Ready", "status": "True" if ready else "False"}]}}


def original_run():
    return {"id": 80, "commit_sha": SOURCE, "workflow_id": "build-agent-runtime.yml",
            "repository": {"full_name": qualification.REPOSITORY, "fork": False}, "status": "failure",
            "is_fork_pull_request": False, "prettyref": "master", "trigger_event": "workflow_dispatch",
            "event_payload": json.dumps({"ref": "refs/heads/master", "inputs": {"codex_version": "0.156.1"}}),
            "html_url": "https://origin.shizuha.com/shizuha-labs/shizuha/actions/runs/10",
            "started": "2026-09-24T08:42:00Z", "stopped": "2026-09-24T08:54:30Z"}


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.index = {"manifests": [{"digest": digest, "platform": {"architecture": arch, "os": "linux"}}
                                   for arch, digest in CHILDREN.items()]}
        self.configs = {}
        self.manifests = {}
        for arch, digest in CHILDREN.items():
            config_digest = "sha256:" + ("4" if arch == "amd64" else "5") * 64
            self.manifests[digest] = {"config": {"digest": config_digest}}
            self.configs[config_digest] = {"os": "linux", "architecture": arch, "config": {"Labels": {
                "org.opencontainers.image.revision": SOURCE, "org.shizuha.skills.revision": SKILLS,
                **{f"org.shizuha.harness.{name}": value for name, value in VERSIONS.items()},
            }}}
        self.candidates = {f"candidate-80-aaaaaaa-{arch}": digest for arch, digest in CHILDREN.items()}
        patch = mock.patch.object(qualification, "_fetch_manifest", side_effect=self.fetch)
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(qualification, "_fetch_blob", side_effect=lambda registry, repo, digest: self.configs[digest])
        patch.start()
        self.addCleanup(patch.stop)

    def fetch(self, registry, repo, reference, accept):
        self.assertEqual(repo, qualification.IMAGE_REPO)
        if reference in (INDEX, TAG):
            return self.index, INDEX
        digest = self.candidates.get(reference, reference)
        return self.manifests[digest], digest

    def verify(self):
        return qualification.verify_registry(INDEX, SOURCE, 80, SKILLS, VERSIONS)

    def test_both_run_scoped_tags_bind_to_exact_native_index_children(self):
        self.assertEqual(self.verify(), (CHILDREN, VERSIONS))
        references = [call.args[2] for call in qualification._fetch_manifest.call_args_list]
        self.assertIn(INDEX, references)
        for arch, digest in CHILDREN.items():
            self.assertIn(digest, references)
            self.assertIn(f"candidate-80-aaaaaaa-{arch}", references)

    def test_mutable_tag_not_accepted_as_index(self):
        with self.assertRaises(Exception):
            qualification.verify_registry(TAG, SOURCE, 80, SKILLS, VERSIONS)

    def test_index_response_digest_substitution_fails(self):
        with mock.patch.object(qualification, "_fetch_manifest", return_value=(self.index, CHILDREN["amd64"])):
            with self.assertRaisesRegex(ValueError, "index digest substitution"):
                self.verify()

    def test_retargeted_candidate_tag_fails(self):
        self.candidates["candidate-80-aaaaaaa-arm64"] = CHILDREN["amd64"]
        with self.assertRaisesRegex(ValueError, "original run candidate"):
                self.verify()

    def test_same_cross_arch_version_substitution_cannot_self_certify(self):
        for config in self.configs.values():
            config["config"]["Labels"]["org.shizuha.harness.codex"] = "0.1"
        with self.assertRaisesRegex(ValueError, "authenticated original build"):
            self.verify()

    def test_missing_duplicate_and_non_native_architectures_fail(self):
        original = copy.deepcopy(self.index)
        for manifests in ([original["manifests"][0]], [original["manifests"][0]] * 2,
                          [{"digest": CHILDREN["amd64"], "platform": {"os": "windows", "architecture": "amd64"}},
                           original["manifests"][1]]):
            with self.subTest(manifests=manifests):
                self.index = {"manifests": manifests}
                with self.assertRaises(Exception):
                    self.verify()

    def test_source_skills_platform_and_cross_arch_version_substitutions_fail(self):
        original = copy.deepcopy(self.configs["sha256:" + "5" * 64])
        mutations = [lambda value: value.update(architecture="amd64"),
                     lambda value: value["config"]["Labels"].update({"org.opencontainers.image.revision": WORKFLOW}),
                     lambda value: value["config"]["Labels"].update({"org.shizuha.skills.revision": WORKFLOW}),
                     lambda value: value["config"]["Labels"].update({"org.shizuha.harness.codex": "0.1"})]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.configs["sha256:" + "5" * 64] = copy.deepcopy(original)
                mutation(self.configs["sha256:" + "5" * 64])
                with self.assertRaises(ValueError):
                    self.verify()

    def test_authenticated_run_rejects_other_repo_source_workflow_and_nonterminal(self):
        for key, value in (("id", 81), ("commit_sha", WORKFLOW), ("workflow_id", "other.yml"),
                           ("status", "running"), ("repository", {"full_name": "someone/shizuha"}),
                           ("html_url", "https://evil.invalid/10")):
            with self.subTest(key=key):
                run = original_run()
                run[key] = value
                with self.assertRaises(ValueError):
                    qualification.validate_run(run, 80, SOURCE)
        self.assertEqual(qualification.validate_run(original_run(), 80, SOURCE), "10")

    def test_structured_publications_reject_conflicting_digest_and_children(self):
        record = {"digest": INDEX, "children": CHILDREN, "tag": TAG}
        self.assertEqual(qualification.structured_records("2026-09-24T08:53:00Z " + json.dumps(record)), [record])
        qualification.validate_records([record], INDEX, CHILDREN)
        for change in ({"digest": CHILDREN["amd64"]}, {"children": {"amd64": INDEX}}):
            with self.assertRaises(ValueError):
                qualification.validate_records([{**record, **change}], INDEX, CHILDREN)

    def test_publication_tag_must_come_from_actual_original_build_output(self):
        self.assertEqual(qualification.publication_details(LOG, original_run()), (TAG, VERSIONS))
        for invalid in ("echo Building shizuha-agent-runtime:example ", LOG + LOG.replace(TAG, "other")):
            with self.assertRaises(ValueError):
                qualification.publication_details(invalid, original_run())
        with self.assertRaisesRegex(ValueError, "explicit build input"):
            qualification.publication_details(LOG.replace("codex=0.156.1", "codex=0.1"), original_run())

    def test_fork_and_non_primary_original_runs_fail(self):
        for update in ({"is_fork_pull_request": True}, {"prettyref": "feature"},
                       {"event_payload": json.dumps({"ref": "refs/heads/feature"})},
                       {"repository": {"full_name": qualification.REPOSITORY, "fork": True}}):
            with self.assertRaisesRegex(ValueError, "primary-branch"):
                qualification.validate_run({**original_run(), **update}, 80, SOURCE)

    def test_retained_manifest_job_binding_and_conflicts(self):
        job = {"metadata": {"name": "ci-manifest-agentrt-candidate-80-aaaaaaa", "namespace": "build",
                             "uid": "job-uid", "creationTimestamp": "2026-09-24T08:53:00Z"},
               "status": {"succeeded": 1, "completionTime": "2026-09-24T08:53:03Z",
                          "conditions": [{"type": "Complete", "status": "True"}]},
               "spec": {"template": {"spec": {"containers": [{"name": "combine-and-verify", "env": [
                   {"name": "IMAGE_REPO", "value": qualification.IMAGE_REPO},
                   {"name": "AMD64_DIGEST", "value": CHILDREN["amd64"]},
                   {"name": "ARM64_DIGEST", "value": CHILDREN["arm64"]},
               ]}]}}}}
        log = json.dumps({"digest": INDEX, "children": CHILDREN, "tag": TAG})
        self.assertEqual(qualification.validate_live_manifest(job, log, original_run(), 80, SOURCE, INDEX, CHILDREN)["uid"], "job-uid")
        for mutate in (lambda value: value["metadata"].update(name="other"),
                       lambda value: value["status"].update(succeeded=0),
                       lambda value: value["metadata"].update(creationTimestamp="2026-09-23T08:00:00Z"),
                       lambda value: value["spec"]["template"]["spec"]["containers"][0]["env"][1].update(value=INDEX)):
            changed = copy.deepcopy(job)
            mutate(changed)
            with self.assertRaises(ValueError):
                qualification.validate_live_manifest(changed, log, original_run(), 80, SOURCE, INDEX, CHILDREN)

    def test_existing_node_selection_and_immutable_prepull_resources(self):
        nodes = [node("worker"), node("pressure"), node("cordoned", unschedulable=True), node("offline", ready=False),
                 node("small", labels={"shizuha.io/disk-class": "small"}),
                 node("control", labels={"node-role.kubernetes.io/control-plane": "true"}),
                 node("platform", labels={"node-role.kubernetes.io/control-plane": "true", "shizuha.io/platform": "true"})]
        self.assertEqual(qualification.eligible_nodes(nodes), ["platform", "pressure", "worker"])
        job = qualification.render_prepull("pressure", "qualify-90-aaaaaaa", INDEX)
        spec = job["spec"]["template"]["spec"]
        self.assertEqual(spec["nodeName"], "pressure")
        self.assertEqual(spec["containers"][0]["image"], f"localhost:30500/shizuha-agent-runtime@{INDEX}")
        self.assertEqual(spec["containers"][0]["resources"]["requests"], {"cpu": "10m", "memory": "16Mi"})
        self.assertEqual(job["spec"]["activeDeadlineSeconds"], 900)

    def test_disk_pressure_fails_but_existing_memory_and_unavailable_exceptions_are_explicit(self):
        failed = {"status": {"conditions": [{"type": "Failed", "status": "True"}]}}
        pods = [{"status": {"phase": "Failed", "reason": "Evicted", "message": "Pod was rejected: The node had condition: [DiskPressure]."}}]
        with self.assertRaisesRegex(ValueError, "DiskPressure"):
            qualification.terminal_result(failed, pods, node("pressure"))
        pods[0]["status"]["message"] = "Node didn't have enough resource: memory"
        self.assertEqual(qualification.terminal_result(failed, pods, node("memory"))["status"], "skipped")
        self.assertEqual(qualification.terminal_result({}, [], node("offline", ready=False))["status"], "skipped")
        self.assertIsNone(qualification.terminal_result({}, [], node("ready")))
        for phase in ("Pending", "Unknown", "Running", None):
            self.assertIsNone(qualification.terminal_result({}, [{"status": {"phase": phase}}]))

    def test_actual_caller_requalifies_same_artifact_after_failure_without_building(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            created = {}
            events = []
            pressure = [True]
            args = argparse.Namespace(source_sha=SOURCE, workflow_sha=WORKFLOW, index_digest=INDEX,
                                      build_run_id=80, qualification_run_id=90,
                                      source_directory=str(root / "source1"), receipt=str(root / "receipt1.json"))
            current = {**original_run(), "id": 90, "commit_sha": WORKFLOW,
                       "workflow_id": "qualify-agent-runtime.yml", "status": "running"}

            def authority(url, token, scheme="token"):
                if "/logs?" in url:
                    return LOG
                return json.dumps(original_run() if url.endswith("/80") else current)

            def run_command(arguments, source=None):
                if arguments[:2] == ["git", "rev-parse"]:
                    return WORKFLOW
                if arguments[:2] == ["git", "merge-base"]:
                    return ""
                if arguments[:2] == ["git", "show"]:
                    filename = arguments[2].split(":", 1)[1]
                    return SKILLS if filename == "runtime-skills.lock" else (ROOT / filename).read_text()
                return subprocess.check_output(arguments, text=True)

            def cluster(arguments, source=None):
                if arguments[0] == "create":
                    job = json.loads(source)
                    created[job["metadata"]["name"]] = job
                    events.append(job["metadata"]["name"])
                    return "created"
                if "secret" in arguments:
                    return json.dumps({"data": {"FORGEJO_TOKEN": base64.b64encode(b"fixture").decode()}})
                if "--ignore-not-found" in arguments:
                    return ""
                if arguments[:2] == ["get", "nodes"]:
                    return json.dumps({"items": [node("worker")]})
                if arguments[:2] == ["get", "node"]:
                    return json.dumps(node("worker"))
                if "logs" in arguments:
                    return '{"startup_smoke_passed":true}'
                name = arguments[4] if "job" in arguments else arguments[5].removeprefix("job-name=")
                failing = pressure[0] and name.startswith("ci-prepull")
                if "job" in arguments:
                    return json.dumps({"status": {"conditions": [{"type": "Failed" if failing else "Complete", "status": "True"}]}})
                return json.dumps({"items": [{"status": {"phase": "Failed" if failing else "Succeeded",
                                    "reason": "Evicted" if failing else "Completed", "message": "DiskPressure" if failing else ""}}]})

            with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                    mock.patch.object(qualification, "authenticated", side_effect=authority), \
                    mock.patch.object(qualification, "command", side_effect=run_command), \
                    mock.patch.object(qualification, "kubectl", side_effect=cluster):
                with self.assertRaisesRegex(ValueError, "DiskPressure"):
                    qualification.qualify(args)
                self.assertFalse(Path(args.receipt).exists())
                self.assertEqual(len(created), 3)
                pressure[0] = False
                args.qualification_run_id = 91
                current["id"] = 91
                args.source_directory = str(root / "source2")
                args.receipt = str(root / "receipt2.json")
                qualification.qualify(args)
                receipt = json.loads(Path(args.receipt).read_text())
                self.assertTrue(receipt["passed"])
                self.assertEqual(receipt["build_run_id"], 80)
                self.assertEqual(receipt["run_id"], 91)
                self.assertEqual(receipt["image_digest"], INDEX)
                self.assertEqual(receipt["children"], CHILDREN)
                self.assertEqual(receipt["provenance"]["structured_publications"], [])
                self.assertIsNone(receipt["provenance"]["retained_manifest_job"])
                self.assertEqual(len(created), 6)
                self.assertTrue(all("smoke" in value for value in events[:2]))
                self.assertIn("prepull", events[2])
                self.assertTrue(all("smoke" in value for value in events[3:5]))

    def test_source_ancestry_failure_precedes_all_cluster_access(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(source_sha=SOURCE, workflow_sha=WORKFLOW, index_digest=INDEX,
                                      build_run_id=80, qualification_run_id=90,
                                      source_directory=str(Path(directory) / "source"),
                                      receipt=str(Path(directory) / "receipt.json"))
            def run_command(arguments, source=None):
                if arguments[:2] == ["git", "rev-parse"]:
                    return WORKFLOW
                raise subprocess.CalledProcessError(1, arguments)
            with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                    mock.patch.object(qualification, "command", side_effect=run_command), \
                    mock.patch.object(qualification, "kubectl") as cluster:
                with self.assertRaises(subprocess.CalledProcessError):
                    qualification.qualify(args)
                cluster.assert_not_called()
                self.assertFalse(Path(args.receipt).exists())

    def test_workflow_cannot_build_tag_or_promote_and_parity_runs_this_suite(self):
        workflow = (ROOT / ".forgejo/workflows/qualify-agent-runtime.yml").read_text()
        self.assertIn("group: build-agent-runtime\n  cancel-in-progress: false", workflow)
        self.assertIn("python3 scripts/qualify_agent_runtime.py", workflow)
        self.assertIn("fetch-depth: 0", workflow)
        for forbidden in ("kaniko", "docker build", "crane", "set image", "helm upgrade"):
            self.assertNotIn(forbidden, workflow)
        self.assertIn("tests.ci.test_agent_runtime_qualification", (ROOT / ".forgejo/workflows/premerge-parity.yml").read_text())


if __name__ == "__main__":
    unittest.main()
