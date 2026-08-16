"""OCI source-overlay release contract regressions."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "agent_runtime_overlay.py"
spec = importlib.util.spec_from_file_location("agent_runtime_overlay", MODULE_PATH)
assert spec and spec.loader
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


def _write_minimum_source(root: Path) -> None:
    (root / "dist").mkdir(parents=True)
    (root / "dist" / "shizuha.js").write_text("new bundle\n")
    (root / "dist" / "new.js").write_text("new file\n")
    skills = root / ".runtime-skills"
    for index in range(50):
        skill = skills / f"skill-{index:02d}"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(f"# skill {index}\n")
    (root / "agent-runtime-entrypoint.sh").write_text("#!/bin/sh\nexec true\n")
    os.chmod(root / "agent-runtime-entrypoint.sh", 0o755)


def _apply_oci_layer(root: Path, layer: Path) -> None:
    """Small test-only OCI whiteout applier for the fixture below."""
    with tarfile.open(layer) as archive:
        members = archive.getmembers()
        for member in members:
            path = Path(member.name)
            if path.name.startswith(".wh."):
                target = root / path.parent / path.name.removeprefix(".wh.")
                if target.is_dir() and not target.is_symlink():
                    shutil.rmtree(target)
                elif target.exists() or target.is_symlink():
                    target.unlink()
        for member in members:
            if member.name.split("/")[-1].startswith(".wh."):
                continue
            destination = root / member.name
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.symlink_to(member.linkname)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                assert source
                destination.write_bytes(source.read())
                os.chmod(destination, member.mode)


class OverlayLayerTests(unittest.TestCase):
    def versions(self) -> dict[str, str]:
        return {
            "codex": "0.147.0",
            "claude_code": "2.1.228",
            "antigravity": "1.1.12",
            "openclaw": "2026.7.1-2",
            "scli": "0.1.0.202608120900",
        }

    def test_two_layer_whiteout_then_recreate_removes_stale_source_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            source = temp / "source"
            source.mkdir()
            _write_minimum_source(source)
            delete, content = overlay.build_layers(
                source,
                temp / "layers",
                versions=self.versions(),
                skills_sha="f69a6a090fcc48aa90f85937bcc0f15cc08efecf",
            )
            with tarfile.open(delete) as archive:
                self.assertEqual([member.name for member in archive.getmembers()], list(overlay.WHITEOUT_PATHS))
                self.assertTrue(all(member.isfile() and member.size == 0 for member in archive.getmembers()))

            rootfs = temp / "rootfs"
            (rootfs / "opt/shizuha/dist").mkdir(parents=True)
            (rootfs / "opt/shizuha/dist/stale.js").write_text("must disappear")
            (rootfs / "opt/skills/retired").mkdir(parents=True)
            (rootfs / "opt/skills/retired/SKILL.md").write_text("must disappear")
            (rootfs / "usr/local/bin").mkdir(parents=True)
            (rootfs / "usr/local/bin/agent-runtime-entrypoint.sh").write_text("old")
            (rootfs / "opt/shizuha/harness-versions.json").write_text("old")
            _apply_oci_layer(rootfs, delete)
            _apply_oci_layer(rootfs, content)

            self.assertFalse((rootfs / "opt/shizuha/dist/stale.js").exists())
            self.assertFalse((rootfs / "opt/skills/retired").exists())
            self.assertEqual((rootfs / "opt/shizuha/dist/shizuha.js").read_text(), "new bundle\n")
            self.assertEqual(
                (rootfs / "opt/skills/.source-revision").read_text(),
                "f69a6a090fcc48aa90f85937bcc0f15cc08efecf\n",
            )
            self.assertEqual(
                json.loads((rootfs / "opt/shizuha/harness-versions.json").read_text()),
                self.versions(),
            )
            self.assertTrue((rootfs / "usr/local/bin/agent-runtime-entrypoint.sh").stat().st_mode & 0o111)

    def test_layers_are_byte_reproducible(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            source = temp / "source"
            source.mkdir()
            _write_minimum_source(source)
            first = overlay.build_layers(
                source,
                temp / "first",
                versions=self.versions(),
                skills_sha="f69a6a090fcc48aa90f85937bcc0f15cc08efecf",
            )
            os.utime(source / "dist/shizuha.js", (1_800_000_000, 1_800_000_000))
            second = overlay.build_layers(
                source,
                temp / "second",
                versions=self.versions(),
                skills_sha="f69a6a090fcc48aa90f85937bcc0f15cc08efecf",
            )
            self.assertEqual(
                [hashlib.sha256(path.read_bytes()).hexdigest() for path in first],
                [hashlib.sha256(path.read_bytes()).hexdigest() for path in second],
            )

    def test_rejects_escaping_symlink_and_special_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            source = temp / "source"
            source.mkdir()
            _write_minimum_source(source)
            outside = temp / "outside"
            outside.write_text("secret")
            (source / "dist/escape").symlink_to("../../outside")
            with self.assertRaisesRegex(overlay.OverlayError, "escaping symlink"):
                overlay.build_layers(
                    source,
                    temp / "bad-link",
                    versions=self.versions(),
                    skills_sha="f69a6a090fcc48aa90f85937bcc0f15cc08efecf",
                )
            (source / "dist/escape").unlink()
            os.mkfifo(source / "dist/fifo")
            with self.assertRaisesRegex(overlay.OverlayError, "special filesystem entry"):
                overlay.build_layers(
                    source,
                    temp / "bad-fifo",
                    versions=self.versions(),
                    skills_sha="f69a6a090fcc48aa90f85937bcc0f15cc08efecf",
                )


class OverlayEligibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "ci@example.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "CI"], cwd=self.repo, check=True)
        for path in overlay.PROTECTED_FULL_BUILD_INPUTS:
            (self.repo / path).write_text(f"base {path}\n")
        (self.repo / "src").mkdir()
        (self.repo / "src/index.ts").write_text("base\n")
        subprocess.run(["git", "add", *overlay.PROTECTED_FULL_BUILD_INPUTS, "src/index.ts"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-qm", "base"], cwd=self.repo, check=True)
        self.base = self._head()

    def tearDown(self):
        self.temp.cleanup()

    def _head(self) -> str:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()

    def _commit(self, path: str, content: str) -> str:
        (self.repo / path).write_text(content)
        subprocess.run(["git", "add", path], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-qm", path], cwd=self.repo, check=True)
        return self._head()

    def _versions(self) -> dict[str, str]:
        return {
            "claude_code": "2.1.228",
            "codex": "0.147.0",
            "antigravity": "1.1.12",
            "openclaw": "2026.7.1-2",
        }

    def test_source_change_is_eligible_but_installed_input_and_harness_change_are_not(self):
        source = self._commit("src/index.ts", "source-only\n")
        versions = self._versions()
        self.assertEqual(
            overlay.source_overlay_eligibility(
                self.repo,
                base_source_sha=self.base,
                source_sha=source,
                actual_versions=versions,
                base_versions=versions,
            ),
            (True, "source-only inputs are compatible with the qualified base"),
        )

        dependency = self._commit("package-lock.json", "changed dependency graph\n")
        allowed, reason = overlay.source_overlay_eligibility(
            self.repo,
            base_source_sha=self.base,
            source_sha=dependency,
            actual_versions=versions,
            base_versions=versions,
        )
        self.assertFalse(allowed)
        self.assertIn("full-build input", reason)

        changed_versions = {**versions, "codex": "0.148.0"}
        allowed, reason = overlay.source_overlay_eligibility(
            self.repo,
            base_source_sha=self.base,
            source_sha=source,
            actual_versions=changed_versions,
            base_versions=versions,
        )
        self.assertFalse(allowed)
        self.assertIn("harness versions", reason)

    def test_unrelated_history_is_never_eligible(self):
        subprocess.run(["git", "checkout", "--orphan", "unrelated"], cwd=self.repo, check=True)
        subprocess.run(["git", "rm", "-qrf", "."], cwd=self.repo, check=True)
        (self.repo / "src").mkdir()
        (self.repo / "src/index.ts").write_text("unrelated\n")
        subprocess.run(["git", "add", "src/index.ts"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-qm", "unrelated"], cwd=self.repo, check=True)
        allowed, reason = overlay.source_overlay_eligibility(
            self.repo,
            base_source_sha=self.base,
            source_sha=self._head(),
            actual_versions=self._versions(),
            base_versions=self._versions(),
        )
        self.assertFalse(allowed)
        self.assertIn("not an ancestor", reason)


class OverlayIndexTests(unittest.TestCase):
    def _candidate_fixture(self):
        args = argparse.Namespace(
            source_sha="b" * 40,
            base_source_sha="a" * 40,
            base_index_digest="sha256:" + "9" * 64,
            registry_ref="registry.internal:5000",
            repo="shizuha-agent-runtime",
            claude_code="2.1.228",
            codex="0.147.0",
            antigravity="1.1.12",
            openclaw="2026.7.1-2",
            scli="0.1.0.202608120900",
            skills_sha="c" * 40,
        )
        child = "sha256:" + "1" * 64
        base_labels = {
            "org.opencontainers.image.revision": args.base_source_sha,
            "org.shizuha.harness.claude_code": args.claude_code,
            "org.shizuha.harness.codex": args.codex,
            "org.shizuha.harness.antigravity": args.antigravity,
            "org.shizuha.harness.openclaw": args.openclaw,
        }
        runtime = {
            "User": overlay.EXPECTED_USER,
            "WorkingDir": overlay.EXPECTED_WORKDIR,
            "Entrypoint": overlay.EXPECTED_ENTRYPOINT,
            "Env": overlay.EXPECTED_ENV,
            "Labels": base_labels,
            "ExposedPorts": {"8080/tcp": {}},
        }
        base_config = {
            "architecture": "amd64",
            "os": "linux",
            "config": runtime,
            "history": [{"created_by": "qualified base"}],
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "2" * 64]},
        }
        base_manifest = {"layers": [{"digest": "sha256:" + "3" * 64}]}
        candidate_config = json.loads(json.dumps(base_config))
        candidate_config["rootfs"]["diff_ids"].extend(
            ["sha256:" + "4" * 64, "sha256:" + "5" * 64]
        )
        candidate_config["history"].extend([
            {"created": "0001-01-01T00:00:00Z"},
            {"created": "0001-01-01T00:00:00Z"},
        ])
        candidate_config["config"]["Labels"] = {
            **base_labels,
            **overlay._expected_labels(args, child),
        }
        candidate_manifest = {
            "layers": [
                *base_manifest["layers"],
                {"digest": "sha256:" + "6" * 64},
                {"digest": "sha256:" + "7" * 64},
            ]
        }
        return args, "amd64", child, base_manifest, base_config, candidate_manifest, candidate_config

    def test_candidate_preserves_exact_layers_diffids_config_history_and_labels(self):
        fixture = self._candidate_fixture()
        result, diff_ids = overlay._assert_candidate(*fixture)
        self.assertEqual(result["layers"], ["sha256:" + "6" * 64, "sha256:" + "7" * 64])
        self.assertEqual(diff_ids, ["sha256:" + "4" * 64, "sha256:" + "5" * 64])

        for field, value, expected_error in (
            ("WorkingDir", "/tmp", "process config"),
            ("Labels", {}, "labels differ"),
        ):
            broken = list(fixture)
            broken_config = json.loads(json.dumps(fixture[-1]))
            broken_config["config"][field] = value
            broken[-1] = broken_config
            with self.assertRaisesRegex(overlay.OverlayError, expected_error):
                overlay._assert_candidate(*broken)

        broken = list(fixture)
        broken_config = json.loads(json.dumps(fixture[-1]))
        broken_config["history"].append({"created_by": "unexpected"})
        broken[-1] = broken_config
        with self.assertRaisesRegex(overlay.OverlayError, "history"):
            overlay._assert_candidate(*broken)

        broken = list(fixture)
        broken_manifest = json.loads(json.dumps(fixture[-2]))
        broken_manifest["layers"][0]["digest"] = "sha256:" + "8" * 64
        broken[-2] = broken_manifest
        with self.assertRaisesRegex(overlay.OverlayError, "base layer prefix"):
            overlay._assert_candidate(*broken)

    def test_index_requires_exactly_one_native_child_per_architecture(self):
        good = {
            "manifests": [
                {
                    "digest": "sha256:" + "a" * 64,
                    "platform": {"os": "linux", "architecture": "amd64"},
                },
                {
                    "digest": "sha256:" + "b" * 64,
                    "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"},
                },
            ]
        }
        self.assertEqual(set(overlay._platform_children(good)), {"amd64", "arm64"})
        duplicate = {"manifests": [good["manifests"][0], good["manifests"][0]]}
        with self.assertRaisesRegex(overlay.OverlayError, "exactly one"):
            overlay._platform_children(duplicate)

    def test_candidate_tags_are_resolved_once_with_exact_native_configs(self):
        args = argparse.Namespace(
            registry_v2="http://registry.internal:5000/v2",
            repo="shizuha-agent-runtime",
            candidate_tag="candidate-77-deadbee",
        )
        amd = "sha256:" + "a" * 64
        arm = "sha256:" + "b" * 64

        def manifests(_registry, _repo, reference, _accept):
            if reference.endswith("-amd64") or reference == amd:
                return ({"config": {"digest": "sha256:" + "c" * 64}}, amd)
            return ({"config": {"digest": "sha256:" + "c" * 64}}, arm)

        def configs(_registry, _repo, _digest):
            # _fetch_blob is invoked in the same deterministic arch order.
            architecture = configs.architectures.pop(0)
            return {"os": "linux", "architecture": architecture}

        configs.architectures = ["amd64", "arm64"]
        with mock.patch.object(overlay, "_fetch_manifest", side_effect=manifests) as fetch, mock.patch.object(
            overlay, "_fetch_blob", side_effect=configs
        ), mock.patch("builtins.print") as emit:
            self.assertEqual(overlay.resolve_candidates(args), 0)
        self.assertEqual(json.loads(emit.call_args.args[0]), {"amd64": amd, "arm64": arm})

        calls = [call.args[2] for call in fetch.call_args_list]
        self.assertEqual(calls, ["candidate-77-deadbee-amd64", amd, "candidate-77-deadbee-arm64", arm])

    def test_combine_publishes_only_the_two_exact_smoked_children(self):
        args = argparse.Namespace(
            registry_ref="registry.internal:5000",
            registry_v2="http://registry.internal:5000/v2",
            repo="shizuha-agent-runtime",
            tag="harness-202608120900-deadbee",
            amd64_digest="sha256:" + "a" * 64,
            arm64_digest="sha256:" + "b" * 64,
            crane="/tools/crane",
        )
        amd = "sha256:" + "a" * 64
        arm = "sha256:" + "b" * 64
        final = "sha256:" + "c" * 64

        def manifests(_registry, _repo, reference, _accept):
            return (
                {
                    "manifests": [
                        {"digest": amd, "platform": {"os": "linux", "architecture": "amd64"}},
                        {"digest": arm, "platform": {"os": "linux", "architecture": "arm64"}},
                    ]
                },
                final,
            )

        with mock.patch.object(overlay.subprocess, "run") as run, mock.patch.object(
            overlay, "_fetch_manifest", side_effect=manifests
        ):
            self.assertEqual(overlay.combine(args), 0)
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ["/tools/crane", "index", "append"])
        self.assertEqual(command.count("-m"), 2)
        self.assertLess(command.index("-t"), command.index("-m"))
        self.assertIn(f"registry.internal:5000/shizuha-agent-runtime@{amd}", command)
        self.assertIn(f"registry.internal:5000/shizuha-agent-runtime@{arm}", command)

    def test_combine_retries_transient_crane_registry_refusal(self):
        args = argparse.Namespace(
            registry_ref="registry.internal:5000",
            registry_v2="http://registry.internal:5000/v2",
            repo="shizuha-agent-runtime",
            tag="harness-202608151214-5fbaf5e",
            amd64_digest="sha256:" + "a" * 64,
            arm64_digest="sha256:" + "b" * 64,
            crane="/tools/crane",
        )
        amd = "sha256:" + "a" * 64
        arm = "sha256:" + "b" * 64
        final = "sha256:" + "c" * 64
        refused = subprocess.CalledProcessError(1, args.crane, stderr="connection refused")

        def manifests(_registry, _repo, reference, _accept):
            return (
                {
                    "manifests": [
                        {"digest": amd, "platform": {"os": "linux", "architecture": "amd64"}},
                        {"digest": arm, "platform": {"os": "linux", "architecture": "arm64"}},
                    ]
                },
                final,
            )

        with mock.patch.object(
            overlay.subprocess,
            "run",
            side_effect=[refused, subprocess.CompletedProcess(args=[], returncode=0)],
        ) as run, mock.patch.object(
            overlay, "_fetch_manifest", side_effect=manifests
        ), mock.patch.object(overlay.time, "sleep") as sleep:
            self.assertEqual(overlay.combine(args), 0)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once()

    def test_combine_rejects_an_index_that_does_not_reference_smoked_child(self):
        args = argparse.Namespace(
            registry_ref="registry.internal:5000",
            registry_v2="http://registry.internal:5000/v2",
            repo="shizuha-agent-runtime",
            tag="harness-202608120900-deadbee",
            amd64_digest="sha256:" + "a" * 64,
            arm64_digest="sha256:" + "b" * 64,
            crane="/tools/crane",
        )
        amd = "sha256:" + "a" * 64
        arm = "sha256:" + "b" * 64
        wrong = "sha256:" + "d" * 64

        def manifests(_registry, _repo, reference, _accept):
            return (
                {
                    "manifests": [
                        {"digest": wrong, "platform": {"os": "linux", "architecture": "amd64"}},
                        {"digest": arm, "platform": {"os": "linux", "architecture": "arm64"}},
                    ]
                },
                "sha256:" + "c" * 64,
            )

        with mock.patch.object(overlay.subprocess, "run"), mock.patch.object(
            overlay, "_fetch_manifest", side_effect=manifests
        ), self.assertRaisesRegex(overlay.OverlayError, "smoked amd64"):
            overlay.combine(args)


class OverlayWorkflowTests(unittest.TestCase):
    def test_terminal_job_observer_exits_on_complete_and_failed_without_waiting_for_timeout(self):
        observer = ROOT / "scripts/wait-k8s-job-terminal.py"
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            responses = temp / "responses"
            calls = temp / "calls"
            fake_kubectl = fake_bin / "kubectl"
            fake_kubectl.write_text(
                "#!/bin/sh\n"
                "set -eu\n"
                "index=0\n"
                "[ ! -f \"$FAKE_CALLS\" ] || index=$(cat \"$FAKE_CALLS\")\n"
                "index=$((index + 1))\n"
                "printf '%s' \"$index\" >\"$FAKE_CALLS\"\n"
                "sed -n \"${index}p\" \"$FAKE_RESPONSES\"\n"
            )
            fake_kubectl.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
                "FAKE_CALLS": str(calls),
                "FAKE_RESPONSES": str(responses),
            }

            active = {"status": {"active": 1}}
            complete = {
                "status": {"conditions": [{"type": "Complete", "status": "True"}]}
            }
            responses.write_text("\n".join(json.dumps(value) for value in (active, complete)) + "\n")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(observer),
                    "--namespace", "build",
                    "--job", "fixture",
                    "--timeout-seconds", "60",
                    "--poll-seconds", "0",
                ],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(calls.read_text(), "2")
            self.assertIn("Complete=True", completed.stdout)

            calls.unlink()
            failed = {
                "status": {
                    "conditions": [
                        {"type": "Complete", "status": "True"},
                        {
                            "type": "Failed",
                            "status": "True",
                            "reason": "BackoffLimitExceeded",
                            "message": "fixture failed",
                        },
                    ]
                }
            }
            responses.write_text(json.dumps(failed) + "\n")
            failed_result = subprocess.run(
                [
                    sys.executable,
                    str(observer),
                    "--namespace", "build",
                    "--job", "fixture",
                    "--timeout-seconds", "60",
                    "--poll-seconds", "0",
                ],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(failed_result.returncode, 1)
            self.assertEqual(calls.read_text(), "1")
            self.assertIn("Failed=True", failed_result.stderr)
            self.assertIn("BackoffLimitExceeded", failed_result.stderr)

    def test_overlay_initializers_execute_in_production_order_on_empty_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            source_origin = temp / "source-origin"
            skills_origin = temp / "skills-origin"
            workspace = temp / "empty-workspace"
            workspace.mkdir()

            subprocess.run(["git", "init", "-q", str(source_origin)], check=True)
            subprocess.run(["git", "-C", str(source_origin), "config", "user.email", "ci@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(source_origin), "config", "user.name", "CI"], check=True)
            (source_origin / "package.json").write_text(
                json.dumps(
                    {
                        "name": "overlay-init-fixture",
                        "version": "1.0.0",
                        "scripts": {
                            "build:public": "mkdir -p dist && printf fixture > dist/shizuha.js"
                        },
                    }
                )
            )
            (source_origin / "package-lock.json").write_text(
                json.dumps(
                    {
                        "name": "overlay-init-fixture",
                        "version": "1.0.0",
                        "lockfileVersion": 3,
                        "requires": True,
                        "packages": {"": {"name": "overlay-init-fixture", "version": "1.0.0"}},
                    }
                )
            )
            subprocess.run(["git", "-C", str(source_origin), "add", "package.json", "package-lock.json"], check=True)
            subprocess.run(["git", "-C", str(source_origin), "commit", "-qm", "source"], check=True)
            source_sha = subprocess.check_output(
                ["git", "-C", str(source_origin), "rev-parse", "HEAD"], text=True
            ).strip()

            subprocess.run(["git", "init", "-q", str(skills_origin)], check=True)
            subprocess.run(["git", "-C", str(skills_origin), "config", "user.email", "ci@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(skills_origin), "config", "user.name", "CI"], check=True)
            for index in range(50):
                skill = skills_origin / f"skill-{index:02d}"
                skill.mkdir()
                (skill / "SKILL.md").write_text(f"# skill {index}\n")
            subprocess.run(["git", "-C", str(skills_origin), "add", "."], check=True)
            subprocess.run(["git", "-C", str(skills_origin), "commit", "-qm", "skills"], check=True)
            skills_sha = subprocess.check_output(
                ["git", "-C", str(skills_origin), "rev-parse", "HEAD"], text=True
            ).strip()

            rendered = json.loads(
                subprocess.check_output(
                    [
                        sys.executable,
                        str(ROOT / "scripts/render-agent-runtime-overlay-job.py"),
                        "--candidate-tag", "candidate-init-order",
                        "--image-repo", "shizuha-agent-runtime",
                        "--base-index-digest", "sha256:" + "a" * 64,
                        "--base-source-sha", "a" * 40,
                        "--source-sha", source_sha,
                        "--claude-code", "2.1.228",
                        "--codex", "0.147.0",
                        "--antigravity", "1.1.12",
                        "--openclaw", "2026.7.1-2",
                        "--scli", "0.1.0.202608121036",
                        "--skills-sha", skills_sha,
                    ],
                    text=True,
                )
            )
            init = rendered["spec"]["template"]["spec"]["initContainers"]
            fake_crane = temp / "crane"
            fake_crane.write_text("#!/bin/sh\nexit 0\n")
            fake_crane.chmod(0o755)
            env = {
                **os.environ,
                "SOURCE_SHA": source_sha,
                "SKILLS_SHA": skills_sha,
                "GIT_PASSWORD": "fixture",
            }
            for container in init:
                script = container["args"][0]
                script = script.replace(
                    "http://forgejo-http.origin.svc.cluster.local/shizuha-labs/shizuha-beta.git",
                    source_origin.as_uri(),
                ).replace(
                    "http://forgejo-http.origin.svc.cluster.local/shizuha-labs/skills.git",
                    skills_origin.as_uri(),
                ).replace("/ko-app/crane", str(fake_crane)).replace("/workspace", str(workspace))
                shell = "/bin/bash" if container["command"][0].endswith("bash") else "/bin/sh"
                subprocess.run([shell, "-c", script], env=env, check=True)

            self.assertEqual((workspace / "src/dist/shizuha.js").read_text(), "fixture")
            self.assertTrue(os.access(workspace / "tools/crane", os.X_OK))

    def test_source_and_full_paths_both_reach_native_smoke_before_exact_index_publish(self):
        workflow = (ROOT / ".forgejo/workflows/build-agent-runtime.yml").read_text()
        eligibility = workflow.index("agent_runtime_overlay.py eligible")
        overlay_apply = workflow.index("render_overlay_job | kubectl apply -f -", eligibility)
        full_amd64 = workflow.index("render_build_job amd64 | kubectl apply -f -", eligibility)
        full_arm64 = workflow.index("render_build_job arm64 | kubectl apply -f -", eligibility)
        smoke_amd64 = workflow.index("render_smoke_job amd64 | kubectl apply -f -", eligibility)
        smoke_arm64 = workflow.index("render_smoke_job arm64 | kubectl apply -f -", eligibility)
        aggregate = workflow.index('[ "$SMOKE_WAIT_STATUS" -eq 0 ] || exit', eligibility)
        combine = workflow.index("render-agent-runtime-manifest-job.py", aggregate)
        self.assertLess(overlay_apply, smoke_amd64)
        self.assertLess(full_amd64, smoke_amd64)
        self.assertLess(full_arm64, smoke_arm64)
        self.assertLess(workflow.index("resolve-candidates", eligibility), smoke_amd64)
        self.assertLess(smoke_amd64, aggregate)
        self.assertLess(smoke_arm64, aggregate)
        self.assertLess(aggregate, combine)
        self.assertNotIn("crane:latest", workflow)
        self.assertIn('--amd64-digest "$AMD64_CANDIDATE_DIGEST"', workflow)
        self.assertIn('--arm64-digest "$ARM64_CANDIDATE_DIGEST"', workflow)
        overlay_observer = workflow.index("wait-k8s-job-terminal.py", overlay_apply)
        overlay_trap_disable = workflow.index("trap - EXIT INT TERM", overlay_observer)
        overlay_cleanup = workflow.rindex("cleanup_overlay_on_failure()", eligibility, overlay_apply)
        self.assertLess(overlay_apply, overlay_observer)
        self.assertLess(overlay_observer, overlay_trap_disable)
        self.assertIn("kubectl logs", workflow[overlay_cleanup:overlay_apply])
        self.assertIn("trap cleanup_overlay_on_failure EXIT INT TERM", workflow[overlay_cleanup:overlay_apply])
        self.assertIn("--timeout-seconds 1200", workflow[overlay_observer:smoke_amd64])
        self.assertNotIn("--for=condition=complete", workflow[overlay_apply:smoke_amd64])

    def test_native_smoke_renderer_pins_each_candidate_to_its_architecture(self):
        script = ROOT / "scripts/render-agent-runtime-smoke-job.py"
        common = [
            "candidate-77-deadbee",
            "shizuha-agent-runtime",
            "2.1.228",
            "0.147.0",
            "1.1.12",
            "2026.7.1-2",
            "0.1.0.202608120900",
            "f69a6a090fcc48aa90f85937bcc0f15cc08efecf",
        ]
        for arch, digest in (
            ("amd64", "sha256:" + "a" * 64),
            ("arm64", "sha256:" + "b" * 64),
        ):
            rendered = json.loads(
                subprocess.check_output([sys.executable, str(script), arch, *common, digest], text=True)
            )
            pod_spec = rendered["spec"]["template"]["spec"]
            self.assertEqual(pod_spec["nodeSelector"]["kubernetes.io/arch"], arch)
            self.assertEqual(
                pod_spec["containers"][0]["image"],
                f"localhost:30500/shizuha-agent-runtime@{digest}",
            )

    def test_authoritative_overlay_and_manifest_jobs_pin_every_image_by_digest(self):
        overlay_job = json.loads(
            subprocess.check_output(
                [
                    sys.executable,
                    str(ROOT / "scripts/render-agent-runtime-overlay-job.py"),
                    "--candidate-tag", "candidate-77-deadbee",
                    "--image-repo", "shizuha-agent-runtime",
                    "--base-index-digest", "sha256:" + "a" * 64,
                    "--base-source-sha", "a" * 40,
                    "--source-sha", "b" * 40,
                    "--claude-code", "2.1.228",
                    "--codex", "0.147.0",
                    "--antigravity", "1.1.12",
                    "--openclaw", "2026.7.1-2",
                    "--scli", "0.1.0.202608120900",
                    "--skills-sha", "c" * 40,
                ],
                text=True,
            )
        )
        manifest_job = json.loads(
            subprocess.check_output(
                [
                    sys.executable,
                    str(ROOT / "scripts/render-agent-runtime-manifest-job.py"),
                    "--candidate-tag", "candidate-77-deadbee",
                    "--tag", "harness-202608120900-deadbee",
                    "--image-repo", "shizuha-agent-runtime",
                    "--base-index-digest", "sha256:" + "c" * 64,
                    "--amd64-digest", "sha256:" + "a" * 64,
                    "--arm64-digest", "sha256:" + "b" * 64,
                ],
                text=True,
            )
        )
        qualified_base = (
            "localhost:30500/shizuha-agent-runtime@" + "sha256:" + "a" * 64
        )
        manifest_base = (
            "localhost:30500/shizuha-agent-runtime@" + "sha256:" + "c" * 64
        )
        for job in (overlay_job, manifest_job):
            pod_spec = job["spec"]["template"]["spec"]
            containers = [
                *pod_spec["initContainers"],
                *pod_spec["containers"],
            ]
            images = [container["image"] for container in containers]
            self.assertTrue(all("@sha256:" in image for image in images), images)
            non_crane_images = [
                container["image"]
                for container in containers
                if container["name"] != "crane-bin"
            ]
            self.assertTrue(
                all(
                    image.startswith("localhost:30500/shizuha-agent-runtime@sha256:")
                    for image in non_crane_images
                ),
                non_crane_images,
            )
            init = pod_spec["initContainers"]
            crane = next(container for container in init if container["name"] == "crane-bin")
            self.assertRegex(crane["image"], r"crane:debug@sha256:[0-9a-f]{64}$")
            if job is overlay_job:
                self.assertEqual(
                    crane["args"],
                    [
                        "mkdir -p /workspace/tools && "
                        "cp /ko-app/crane /workspace/tools/crane && "
                        "chmod 0755 /workspace/tools/crane"
                    ],
                )

        overlay_init = overlay_job["spec"]["template"]["spec"]["initContainers"]
        git_clone = next(container for container in overlay_init if container["name"] == "git-clone")
        dist_builder = next(container for container in overlay_init if container["name"] == "dist-build")
        overlay_main = overlay_job["spec"]["template"]["spec"]["containers"][0]
        manifest_main = manifest_job["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(git_clone["image"], qualified_base)
        self.assertEqual(dist_builder["image"], qualified_base)
        self.assertEqual(overlay_main["image"], qualified_base)
        self.assertEqual(manifest_main["image"], manifest_base)
        self.assertNotIn("python:", overlay_main["image"])
        self.assertNotIn("python:", manifest_main["image"])
        self.assertNotIn("alpine/git", git_clone["image"])
        self.assertEqual(git_clone["command"], ["/bin/bash", "-c"])
        self.assertEqual(git_clone["securityContext"], {"runAsUser": 0})
        self.assertEqual(dist_builder["command"], ["/bin/bash", "-c"])
        self.assertEqual(dist_builder["securityContext"], {"runAsUser": 0})
        self.assertEqual(overlay_main["securityContext"], {"runAsUser": 0})
        self.assertEqual(manifest_main["securityContext"], {"runAsUser": 0})


if __name__ == "__main__":
    unittest.main()
