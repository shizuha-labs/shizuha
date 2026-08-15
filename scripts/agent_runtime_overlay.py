#!/usr/bin/env python3
"""Build and verify source-only OCI overlays for the agent runtime.

The module is embedded into finite CI Jobs by the renderers beside this file.
It deliberately operates on registry manifests and new source layers only: it
never extracts the qualified base image or its Playwright payload.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.parse


WHITEOUT_PATHS = (
    "opt/shizuha/.wh.dist",
    "opt/.wh.skills",
    "usr/local/bin/.wh.agent-runtime-entrypoint.sh",
    "opt/shizuha/.wh.harness-versions.json",
)

EXPECTED_USER = "agent"
EXPECTED_WORKDIR = "/home/agent"
EXPECTED_ENTRYPOINT = [
    "/usr/bin/tini",
    "--",
    "/usr/local/bin/agent-runtime-entrypoint.sh",
]
EXPECTED_ENV = [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "DEBIAN_FRONTEND=noninteractive",
    "NODE_MAJOR=22",
    "NPM_CONFIG_REGISTRY=http://s1.tail.shizuha.com:30512/",
    "PIP_INDEX_URL=http://s1.tail.shizuha.com:30511/simple/",
    "PIP_TRUSTED_HOST=s1.tail.shizuha.com",
    "PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers",
    "SHIZUHA_DIST=/opt/shizuha/dist",
    "HOME=/home/agent",
]

# Changes to any of these inputs can alter files outside the four source trees
# replaced by the overlay, so they require the full native Dockerfile build.
PROTECTED_FULL_BUILD_INPUTS = (
    "Dockerfile.agent-runtime",
    "package.json",
    "package-lock.json",
    "requirements-agent-runtime.txt",
)

INDEX_ACCEPT = (
    "application/vnd.oci.image.index.v1+json,"
    "application/vnd.docker.distribution.manifest.list.v2+json"
)
IMAGE_ACCEPT = (
    "application/vnd.oci.image.manifest.v1+json,"
    "application/vnd.docker.distribution.manifest.v2+json"
)


class OverlayError(RuntimeError):
    """A release-contract violation that must fail the candidate closed."""


def _require_digest(name: str, value: str) -> str:
    if len(value) != 71 or not value.startswith("sha256:"):
        raise OverlayError(f"{name} must be a full sha256 digest")
    try:
        int(value[7:], 16)
    except ValueError as exc:
        raise OverlayError(f"{name} must be a full sha256 digest") from exc
    return value


def _require_sha(name: str, value: str) -> str:
    if len(value) != 40:
        raise OverlayError(f"{name} must be a full git SHA")
    try:
        int(value, 16)
    except ValueError as exc:
        raise OverlayError(f"{name} must be a full git SHA") from exc
    return value


def _safe_archive_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise OverlayError(f"unsafe archive path: {value!r}")
    if any(part.startswith(".wh.") for part in path.parts):
        raise OverlayError(f"source content cannot impersonate an OCI whiteout: {value!r}")
    return path


def _tar_info(name: str, *, mode: int, kind: bytes = tarfile.REGTYPE, size: int = 0) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = size
    info.mode = mode
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def _write_delete_layer(path: Path) -> None:
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as archive:
        for name in WHITEOUT_PATHS:
            info = _tar_info(name, mode=0o000)
            archive.addfile(info, io.BytesIO(b""))


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _tree_entries(source: Path, archive_root: str) -> list[tuple[Path, PurePosixPath]]:
    source = source.resolve(strict=True)
    archive_prefix = _safe_archive_path(archive_root)
    entries: list[tuple[Path, PurePosixPath]] = [(source, archive_prefix)]
    for item in sorted(source.rglob("*"), key=lambda p: p.relative_to(source).as_posix()):
        relative = item.relative_to(source)
        archive_path = _safe_archive_path((archive_prefix / PurePosixPath(relative.as_posix())).as_posix())
        entries.append((item, archive_path))
    return entries


def _add_tree(archive: tarfile.TarFile, source: Path, archive_root: str) -> None:
    root = source.resolve(strict=True)
    for item, archive_path in _tree_entries(source, archive_root):
        metadata = item.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        name = archive_path.as_posix()
        if stat.S_ISDIR(metadata.st_mode):
            archive.addfile(_tar_info(name, mode=0o755, kind=tarfile.DIRTYPE))
        elif stat.S_ISREG(metadata.st_mode):
            normalized_mode = 0o755 if mode & 0o111 else 0o644
            info = _tar_info(name, mode=normalized_mode, size=metadata.st_size)
            with item.open("rb") as payload:
                archive.addfile(info, payload)
        elif stat.S_ISLNK(metadata.st_mode):
            link = os.readlink(item)
            if PurePosixPath(link).is_absolute():
                raise OverlayError(f"absolute symlink rejected: {item} -> {link}")
            resolved = item.resolve(strict=True)
            if not _is_within(resolved, root):
                raise OverlayError(f"escaping symlink rejected: {item} -> {link}")
            info = _tar_info(name, mode=0o777, kind=tarfile.SYMTYPE)
            info.linkname = link
            archive.addfile(info)
        else:
            raise OverlayError(f"special filesystem entry rejected: {item}")


def _add_bytes(archive: tarfile.TarFile, name: str, payload: bytes, mode: int) -> None:
    _safe_archive_path(name)
    archive.addfile(_tar_info(name, mode=mode, size=len(payload)), io.BytesIO(payload))


def build_layers(
    source_root: Path,
    output_dir: Path,
    *,
    versions: dict[str, str],
    skills_sha: str,
) -> tuple[Path, Path]:
    """Create deterministic delete/content layers without touching the source tree."""

    _require_sha("skills_sha", skills_sha)
    source_root = source_root.resolve(strict=True)
    dist = source_root / "dist"
    skills = source_root / ".runtime-skills"
    entrypoint = source_root / "agent-runtime-entrypoint.sh"
    if not (dist / "shizuha.js").is_file():
        raise OverlayError("dist/shizuha.js is absent")
    if not entrypoint.is_file():
        raise OverlayError("agent-runtime-entrypoint.sh is absent")
    if (skills / ".git").exists():
        raise OverlayError("embedded skills checkout still contains .git")
    skill_count = sum(1 for path in skills.glob("*/*") if path.name == "SKILL.md" and path.is_file())
    if skill_count < 50:
        raise OverlayError(f"embedded skill catalog is incomplete: {skill_count} skills")

    required_versions = ("codex", "claude_code", "antigravity", "openclaw", "scli")
    if set(versions) != set(required_versions) or any(not versions[key] for key in required_versions):
        raise OverlayError("version ledger must contain exactly codex, claude_code, antigravity, openclaw, scli")

    output_dir.mkdir(parents=True, exist_ok=True)
    delete_layer = output_dir / "delete.tar"
    content_layer = output_dir / "content.tar"
    _write_delete_layer(delete_layer)

    ordered_ledger = {key: versions[key] for key in required_versions}
    ledger = (json.dumps(ordered_ledger, separators=(",", ":")) + "\n").encode()
    with tarfile.open(content_layer, "w", format=tarfile.PAX_FORMAT) as archive:
        _add_tree(archive, dist, "opt/shizuha/dist")
        _add_tree(archive, skills, "opt/skills")
        _add_bytes(archive, "opt/skills/.source-revision", f"{skills_sha}\n".encode(), 0o644)
        _add_bytes(archive, "opt/shizuha/harness-versions.json", ledger, 0o644)
        _add_bytes(
            archive,
            "usr/local/bin/agent-runtime-entrypoint.sh",
            entrypoint.read_bytes(),
            0o755,
        )
    return delete_layer, content_layer


def source_overlay_eligibility(
    repo_root: Path,
    *,
    base_source_sha: str,
    source_sha: str,
    actual_versions: dict[str, str],
    base_versions: dict[str, str],
) -> tuple[bool, str]:
    """Prove a commit can reuse the qualified runtime rootfs and harnesses."""

    _require_sha("base_source_sha", base_source_sha)
    _require_sha("source_sha", source_sha)
    repo_root = repo_root.resolve(strict=True)
    if actual_versions != base_versions:
        return False, "resolved harness versions differ from the qualified base"
    if subprocess.run(
        ["git", "cat-file", "-e", f"{base_source_sha}^{{commit}}"],
        cwd=repo_root,
        check=False,
    ).returncode:
        return False, "qualified base source commit is unavailable"
    if subprocess.run(
        ["git", "merge-base", "--is-ancestor", base_source_sha, source_sha],
        cwd=repo_root,
        check=False,
    ).returncode:
        return False, "qualified base source is not an ancestor"
    diff = subprocess.run(
        [
            "git",
            "diff",
            "--quiet",
            base_source_sha,
            source_sha,
            "--",
            *PROTECTED_FULL_BUILD_INPUTS,
        ],
        cwd=repo_root,
        check=False,
    )
    if diff.returncode == 1:
        return False, "an installed/full-build input changed"
    if diff.returncode:
        raise OverlayError(f"git diff eligibility check failed with exit {diff.returncode}")
    return True, "source-only inputs are compatible with the qualified base"


def eligible(args: argparse.Namespace) -> int:
    actual = {
        "claude_code": args.claude_code,
        "codex": args.codex,
        "antigravity": args.antigravity,
        "openclaw": args.openclaw,
    }
    base = {
        "claude_code": args.base_claude_code,
        "codex": args.base_codex,
        "antigravity": args.base_antigravity,
        "openclaw": args.base_openclaw,
    }
    allowed, reason = source_overlay_eligibility(
        Path(args.repo_root),
        base_source_sha=args.base_source_sha,
        source_sha=args.source_sha,
        actual_versions=actual,
        base_versions=base,
    )
    print(reason)
    return 0 if allowed else 1


def _request_json(url: str, *, accept: str) -> tuple[dict, str]:
    request = urllib.request.Request(url, headers={"Accept": accept})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed internal registry
        raw = response.read()
        digest = response.headers.get("Docker-Content-Digest", "")
    calculated_digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    if digest and digest != calculated_digest:
        raise OverlayError(f"registry digest header does not match response bytes for {url}")
    if not digest:
        digest = calculated_digest
    _require_digest("registry content digest", digest)
    try:
        return json.loads(raw), digest
    except json.JSONDecodeError as exc:
        raise OverlayError(f"registry returned malformed JSON for {url}") from exc


def _registry_url(registry_v2: str, repo: str, kind: str, reference: str) -> str:
    safe_repo = "/".join(urllib.parse.quote(part, safe="") for part in repo.split("/"))
    safe_reference = urllib.parse.quote(reference, safe=":")
    return f"{registry_v2.rstrip('/')}/{safe_repo}/{kind}/{safe_reference}"


def _fetch_manifest(registry_v2: str, repo: str, reference: str, accept: str) -> tuple[dict, str]:
    return _request_json(_registry_url(registry_v2, repo, "manifests", reference), accept=accept)


def _fetch_blob(registry_v2: str, repo: str, digest: str) -> dict:
    expected = _require_digest("blob digest", digest)
    value, observed = _request_json(
        _registry_url(registry_v2, repo, "blobs", expected),
        accept="application/octet-stream",
    )
    if observed != expected:
        raise OverlayError("registry blob bytes do not match the referenced digest")
    return value


def _platform_children(index: dict) -> dict[str, dict]:
    manifests = index.get("manifests")
    if not isinstance(manifests, list) or len(manifests) != 2:
        raise OverlayError("qualified base index must contain exactly two manifests")
    result: dict[str, dict] = {}
    for descriptor in manifests:
        platform = descriptor.get("platform") or {}
        arch = platform.get("architecture")
        if platform.get("os") != "linux" or arch not in ("amd64", "arm64") or arch in result:
            raise OverlayError("qualified base index must contain exactly one linux/amd64 and one linux/arm64")
        _require_digest(f"{arch} child digest", descriptor.get("digest", ""))
        result[arch] = descriptor
    if set(result) != {"amd64", "arm64"}:
        raise OverlayError("qualified base index is missing a required architecture")
    return result


def _expected_labels(args: argparse.Namespace, child_digest: str) -> dict[str, str]:
    return {
        "org.opencontainers.image.revision": args.source_sha,
        "org.opencontainers.image.base.digest": child_digest,
        "org.opencontainers.image.base.name": f"{args.registry_ref}/{args.repo}@{child_digest}",
        "org.shizuha.harness.claude_code": args.claude_code,
        "org.shizuha.harness.codex": args.codex,
        "org.shizuha.harness.antigravity": args.antigravity,
        "org.shizuha.harness.openclaw": args.openclaw,
        "org.shizuha.harness.scli": args.scli,
        "org.shizuha.skills.revision": args.skills_sha,
        "org.shizuha.runtime.overlay": "source-v1",
        "org.shizuha.runtime.overlay.base_index": args.base_index_digest,
    }


def _assert_base_config(args: argparse.Namespace, arch: str, config: dict) -> None:
    if config.get("architecture") != arch or config.get("os") != "linux":
        raise OverlayError(f"base config platform mismatch for {arch}")
    runtime = config.get("config") or {}
    if runtime.get("User") != EXPECTED_USER:
        raise OverlayError(f"base user mismatch for {arch}")
    if runtime.get("WorkingDir") != EXPECTED_WORKDIR:
        raise OverlayError(f"base workdir mismatch for {arch}")
    if runtime.get("Entrypoint") != EXPECTED_ENTRYPOINT or runtime.get("Cmd") not in (None, []):
        raise OverlayError(f"base process contract mismatch for {arch}")
    if runtime.get("Env") != EXPECTED_ENV:
        raise OverlayError(f"base environment contract mismatch for {arch}")
    labels = runtime.get("Labels") or {}
    expected = {
        "org.opencontainers.image.revision": args.base_source_sha,
        "org.shizuha.harness.claude_code": args.claude_code,
        "org.shizuha.harness.codex": args.codex,
        "org.shizuha.harness.antigravity": args.antigravity,
        "org.shizuha.harness.openclaw": args.openclaw,
    }
    for key, value in expected.items():
        if labels.get(key) != value:
            raise OverlayError(f"base label mismatch for {arch}: {key}")


def _assert_candidate(
    args: argparse.Namespace,
    arch: str,
    child_digest: str,
    base_manifest: dict,
    base_config: dict,
    candidate_manifest: dict,
    candidate_config: dict,
) -> tuple[dict, list[str]]:
    base_layers = base_manifest.get("layers") or []
    candidate_layers = candidate_manifest.get("layers") or []
    if len(candidate_layers) != len(base_layers) + 2 or candidate_layers[:-2] != base_layers:
        raise OverlayError(f"candidate {arch} does not preserve the exact base layer prefix")
    base_diff_ids = ((base_config.get("rootfs") or {}).get("diff_ids") or [])
    candidate_diff_ids = ((candidate_config.get("rootfs") or {}).get("diff_ids") or [])
    if len(candidate_diff_ids) != len(base_diff_ids) + 2 or candidate_diff_ids[:-2] != base_diff_ids:
        raise OverlayError(f"candidate {arch} does not preserve the exact base DiffID prefix")
    if candidate_config.get("architecture") != arch or candidate_config.get("os") != "linux":
        raise OverlayError(f"candidate config platform mismatch for {arch}")
    base_runtime = base_config.get("config") or {}
    candidate_runtime = candidate_config.get("config") or {}
    base_runtime_without_labels = {
        key: value for key, value in base_runtime.items() if key != "Labels"
    }
    candidate_runtime_without_labels = {
        key: value for key, value in candidate_runtime.items() if key != "Labels"
    }
    if candidate_runtime_without_labels != base_runtime_without_labels:
        raise OverlayError(f"candidate {arch} changed the base runtime process config")
    # crane mutate --append uses mutate.AppendLayers: one zero-value History
    # record is appended for each real layer. v1.Time's JSON encoding preserves
    # its zero timestamp even with omitempty. No prior entry may be rewritten
    # and no extra empty/config-only history entry may appear.
    zero_history = {"created": "0001-01-01T00:00:00Z"}
    expected_history = [*(base_config.get("history") or []), zero_history, zero_history]
    if candidate_config.get("history") != expected_history:
        raise OverlayError(f"candidate {arch} history is not the exact base prefix plus two overlay layers")
    labels = candidate_runtime.get("Labels") or {}
    expected_labels = {
        **(base_runtime.get("Labels") or {}),
        **_expected_labels(args, child_digest),
    }
    if labels != expected_labels:
        raise OverlayError(f"candidate {arch} labels differ from the exact qualified overlay contract")
    if any("gemini" in key.lower() for key in labels):
        raise OverlayError(f"candidate {arch} reintroduced a Gemini label")
    return {
        "layers": [layer.get("digest") for layer in candidate_layers[-2:]],
        "diff_ids": candidate_diff_ids[-2:],
    }, candidate_diff_ids[-2:]


def publish(args: argparse.Namespace) -> int:
    _require_digest("base_index_digest", args.base_index_digest)
    _require_sha("base_source_sha", args.base_source_sha)
    _require_sha("source_sha", args.source_sha)
    _require_sha("skills_sha", args.skills_sha)
    base_index, observed_index_digest = _fetch_manifest(
        args.registry_v2, args.repo, args.base_index_digest, INDEX_ACCEPT
    )
    if observed_index_digest != args.base_index_digest:
        raise OverlayError("qualified base index digest does not match registry content")
    children = _platform_children(base_index)
    versions = {
        "codex": args.codex,
        "claude_code": args.claude_code,
        "antigravity": args.antigravity,
        "openclaw": args.openclaw,
        "scli": args.scli,
    }
    delete_layer, content_layer = build_layers(
        Path(args.source_root), Path(args.output_dir), versions=versions, skills_sha=args.skills_sha
    )

    candidate_overlay: dict[str, dict] = {}
    base_ref = f"{args.registry_ref}/{args.repo}@{args.base_index_digest}"
    for arch in ("amd64", "arm64"):
        child_digest = children[arch]["digest"]
        base_manifest, observed_child = _fetch_manifest(
            args.registry_v2, args.repo, child_digest, IMAGE_ACCEPT
        )
        if observed_child != child_digest:
            raise OverlayError(f"base child digest mismatch for {arch}")
        base_config = _fetch_blob(args.registry_v2, args.repo, base_manifest["config"]["digest"])
        _assert_base_config(args, arch, base_config)
        destination = f"{args.registry_ref}/{args.repo}:{args.candidate_tag}-{arch}"
        command = [
            args.crane,
            "mutate",
            "--insecure",
            "--platform",
            f"linux/{arch}",
            base_ref,
            "--append",
            str(delete_layer),
            "--append",
            str(content_layer),
        ]
        for key, value in _expected_labels(args, child_digest).items():
            command.extend(("--label", f"{key}={value}"))
        command.extend(("--tag", destination))
        subprocess.run(command, check=True)

        candidate_manifest, candidate_digest = _fetch_manifest(
            args.registry_v2, args.repo, f"{args.candidate_tag}-{arch}", IMAGE_ACCEPT
        )
        candidate_config = _fetch_blob(
            args.registry_v2, args.repo, candidate_manifest["config"]["digest"]
        )
        overlay, _ = _assert_candidate(
            args,
            arch,
            child_digest,
            base_manifest,
            base_config,
            candidate_manifest,
            candidate_config,
        )
        candidate_overlay[arch] = {
            "digest": candidate_digest,
            "base_digest": child_digest,
            **overlay,
        }

    if candidate_overlay["amd64"]["layers"] != candidate_overlay["arm64"]["layers"]:
        raise OverlayError("source overlay layer blobs differ between architectures")
    if candidate_overlay["amd64"]["diff_ids"] != candidate_overlay["arm64"]["diff_ids"]:
        raise OverlayError("source overlay DiffIDs differ between architectures")
    result_path = Path(args.output_dir) / "result.json"
    result_path.write_text(json.dumps(candidate_overlay, sort_keys=True) + "\n")
    print(json.dumps({"overlay": "source-v1", "candidates": candidate_overlay}, sort_keys=True))
    return 0


def resolve_candidates(args: argparse.Namespace) -> int:
    """Resolve run-scoped candidate tags once, before native smoke."""

    candidates: dict[str, str] = {}
    for arch in ("amd64", "arm64"):
        # A run-scoped tag is only a discovery name. Resolve its manifest bytes,
        # then re-read those same bytes by immutable digest before returning it
        # to the smoke/combine pipeline. A concurrent tag move therefore cannot
        # turn two different manifests into one claimed candidate.
        manifest, digest = _fetch_manifest(
            args.registry_v2,
            args.repo,
            f"{args.candidate_tag}-{arch}",
            IMAGE_ACCEPT,
        )
        immutable_manifest, immutable_digest = _fetch_manifest(
            args.registry_v2,
            args.repo,
            digest,
            IMAGE_ACCEPT,
        )
        if immutable_digest != digest or immutable_manifest != manifest:
            raise OverlayError(f"candidate tag changed while resolving {arch}")
        config = _fetch_blob(args.registry_v2, args.repo, manifest["config"]["digest"])
        if config.get("os") != "linux" or config.get("architecture") != arch:
            raise OverlayError(f"candidate tag platform mismatch for {arch}")
        candidates[arch] = digest
    print(json.dumps(candidates, sort_keys=True))
    return 0


def _run_crane(cmd: list[str], attempts: int = 5) -> None:
    """Retry crane against transient in-cluster registry refusals."""
    last: subprocess.CalledProcessError | None = None
    for attempt in range(1, attempts + 1):
        try:
            subprocess.run(cmd, check=True)
            return
        except subprocess.CalledProcessError as exc:
            last = exc
            if attempt == attempts:
                raise
            delay = min(2 ** attempt, 16)
            print(
                f"crane retry {attempt}/{attempts} after exit {exc.returncode}; sleeping {delay}s",
                file=sys.stderr,
            )
            time.sleep(delay)
    if last is not None:
        raise last


def combine(args: argparse.Namespace) -> int:
    destination = f"{args.registry_ref}/{args.repo}:{args.tag}"
    expected = {
        "amd64": _require_digest("smoked amd64 digest", args.amd64_digest),
        "arm64": _require_digest("smoked arm64 digest", args.arm64_digest),
    }
    candidates = {
        arch: f"{args.registry_ref}/{args.repo}@{digest}"
        for arch, digest in expected.items()
    }
    # This is intentionally the first publication of the promotable tag and is
    # called only after both native smoke Jobs have passed. The in-cluster
    # registry can refuse for a few seconds during GC/endpoint flaps
    # (harness-202608151214-5fbaf5e died on one connection-refused crane
    # call after both smokes were green). Retry here — do not require a
    # full rebuild to republish already-smoked children.
    _run_crane(
        [
            args.crane,
            "index",
            "append",
            "--insecure",
            "-t",
            destination,
            "-m",
            candidates["amd64"],
            "-m",
            candidates["arm64"],
        ]
    )
    index, index_digest = _fetch_manifest(args.registry_v2, args.repo, args.tag, INDEX_ACCEPT)
    children = _platform_children(index)
    for arch, digest in expected.items():
        if children[arch]["digest"] != digest:
            raise OverlayError(f"final index does not reference the smoked {arch} manifest")
    print(json.dumps({"tag": args.tag, "digest": index_digest, "children": expected}, sort_keys=True))
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    eligible_parser = subparsers.add_parser("eligible")
    for flag in (
        "repo-root",
        "base-source-sha",
        "source-sha",
        "claude-code",
        "codex",
        "antigravity",
        "openclaw",
        "base-claude-code",
        "base-codex",
        "base-antigravity",
        "base-openclaw",
    ):
        eligible_parser.add_argument(f"--{flag}", required=True)
    eligible_parser.set_defaults(func=eligible)

    publish_parser = subparsers.add_parser("publish")
    for flag in (
        "source-root",
        "output-dir",
        "registry-v2",
        "registry-ref",
        "repo",
        "base-index-digest",
        "base-source-sha",
        "source-sha",
        "candidate-tag",
        "claude-code",
        "codex",
        "antigravity",
        "openclaw",
        "scli",
        "skills-sha",
        "crane",
    ):
        publish_parser.add_argument(f"--{flag}", required=True)
    publish_parser.set_defaults(func=publish)

    resolve_parser = subparsers.add_parser("resolve-candidates")
    for flag in ("registry-v2", "repo", "candidate-tag"):
        resolve_parser.add_argument(f"--{flag}", required=True)
    resolve_parser.set_defaults(func=resolve_candidates)

    combine_parser = subparsers.add_parser("combine")
    for flag in (
        "registry-v2",
        "registry-ref",
        "repo",
        "tag",
        "amd64-digest",
        "arm64-digest",
        "crane",
    ):
        combine_parser.add_argument(f"--{flag}", required=True)
    combine_parser.set_defaults(func=combine)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return args.func(args)
    except (OverlayError, OSError, subprocess.CalledProcessError) as exc:
        print(f"FATAL: agent runtime OCI overlay rejected: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
