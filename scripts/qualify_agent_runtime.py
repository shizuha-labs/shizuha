"""Requalify an existing runtime index through native CI gates, without rebuilding."""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

from agent_runtime_overlay import (
    IMAGE_ACCEPT, INDEX_ACCEPT, _fetch_blob, _fetch_manifest,
    _platform_children, _require_digest, _require_sha,
)

REPOSITORY = "shizuha-labs/shizuha"
IMAGE_REPO = "shizuha-agent-runtime"
REGISTRY = "http://registry.registry.svc.cluster.local:5000/v2"
API = "http://forgejo-http.origin.svc.cluster.local/api/v1"
LOGS = "http://ci-logs.origin.svc.cluster.local:8080"
VERSIONS = ("claude_code", "codex", "antigravity", "openclaw", "scli")


def command(arguments, source=None):
    return subprocess.check_output(arguments, input=source, text=True, timeout=60)


def kubectl(arguments, source=None):
    return command(["kubectl", *arguments], source)


def authenticated(url, token, scheme="token"):
    request = urllib.request.Request(url, headers={"Authorization": f"{scheme} {token}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode()


def validate_run(run, run_id, source_sha):
    validate_primary_run(run)
    if (run.get("id") != run_id or run.get("commit_sha") != source_sha
            or run.get("workflow_id") != "build-agent-runtime.yml"
            or run.get("repository", {}).get("full_name") != REPOSITORY
            or run.get("status") not in ("success", "failure")):
        raise ValueError("original build run identity/source/terminal status mismatch")
    match = re.fullmatch(
        r"https://origin\.shizuha\.com/shizuha-labs/shizuha/actions/runs/([1-9][0-9]*)",
        run.get("html_url", ""),
    )
    if not match:
        raise ValueError("original build run URL mismatch")
    return match.group(1)


def validate_primary_run(run):
    payload = json.loads(run.get("event_payload", "{}"))
    if (run.get("is_fork_pull_request") is not False or run.get("repository", {}).get("fork") is not False
            or run.get("prettyref") != "master" or payload.get("ref") != "refs/heads/master"
            or run.get("trigger_event") not in ("push", "workflow_dispatch")):
        raise ValueError("runtime qualification requires a canonical non-fork primary-branch run")
    return payload


def structured_records(log):
    records = []
    for line in log.splitlines():
        payload = re.sub(r"^\d{4}-\d\d-\d\dT\S+\s+", "", line).strip()
        if not payload.startswith("{"):
            continue
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and {"children", "digest", "tag"} <= value.keys():
            records.append(value)
    return records


def publication_details(log, run):
    matches = re.findall(
        r"^\d{4}-\d\d-\d\dT\S+\s+Building shizuha-agent-runtime:([a-z0-9][a-z0-9._-]{0,127})"
        r"\s+claude-code=(\S+) codex=(\S+) antigravity=(\S+) openclaw=(\S+) scli=(\S+)\s*$", log, re.M,
    )
    if len(set(matches)) != 1:
        raise ValueError("original build has no unambiguous resolved harness publication")
    tag, *resolved = matches[0]
    versions = dict(zip(VERSIONS, resolved, strict=True))
    if any(not re.fullmatch(r"[0-9][0-9A-Za-z.+_-]{0,79}", value) for value in versions.values()):
        raise ValueError("original build has invalid resolved harness versions")
    inputs = json.loads(run.get("event_payload", "{}")).get("inputs", {})
    for name in VERSIONS[:-1]:
        requested = inputs.get(f"{name}_version")
        if requested and requested != versions[name]:
            raise ValueError("original resolved harness differs from explicit build input")
    return tag, versions


def validate_records(records, index_digest, children):
    for record in records:
        if record.get("digest") != index_digest or record.get("children") != children:
            raise ValueError("original structured publication contradicts requested index/children")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", record.get("tag", "")):
            raise ValueError("original publication has invalid tag")


def verify_registry(index_digest, source_sha, run_id, skills_sha, expected_versions):
    _require_digest("runtime index", index_digest)
    index, observed = _fetch_manifest(REGISTRY, IMAGE_REPO, index_digest, INDEX_ACCEPT)
    if observed != index_digest:
        raise ValueError("runtime index digest substitution")
    descriptors = _platform_children(index)
    children = {}
    for arch, descriptor in descriptors.items():
        digest = descriptor["digest"]
        manifest, actual = _fetch_manifest(REGISTRY, IMAGE_REPO, digest, IMAGE_ACCEPT)
        candidate, candidate_digest = _fetch_manifest(
            REGISTRY, IMAGE_REPO, f"candidate-{run_id}-{source_sha[:7]}-{arch}", IMAGE_ACCEPT,
        )
        if actual != digest or candidate_digest != digest or candidate != manifest:
            raise ValueError(f"{arch} original run candidate differs from immutable index child")
        config = _fetch_blob(REGISTRY, IMAGE_REPO, manifest["config"]["digest"])
        labels = config.get("config", {}).get("Labels") or {}
        if (config.get("os") != "linux" or config.get("architecture") != arch
                or labels.get("org.opencontainers.image.revision") != source_sha
                or labels.get("org.shizuha.skills.revision") != skills_sha):
            raise ValueError(f"{arch} runtime platform/source/skills labels mismatch")
        actual_versions = {name: labels.get(f"org.shizuha.harness.{name}", "") for name in VERSIONS}
        if any(not re.fullmatch(r"[0-9][0-9A-Za-z.+_-]{0,79}", value)
               for value in actual_versions.values()):
            raise ValueError(f"{arch} invalid harness version labels")
        if actual_versions != expected_versions:
            raise ValueError(f"{arch} harness versions differ from authenticated original build")
        children[arch] = digest
    return children, expected_versions


def validate_live_manifest(job, log, run, run_id, source_sha, index_digest, children):
    expected = f"ci-manifest-agentrt-candidate-{run_id}-{source_sha[:7]}"
    metadata = job.get("metadata", {})
    if metadata.get("name") != expected or metadata.get("namespace") != "build" or not metadata.get("uid"):
        raise ValueError("original manifest Job identity mismatch")
    status = job.get("status", {})
    if status.get("succeeded") != 1 or not any(
        condition.get("type") == "Complete" and condition.get("status") == "True"
        for condition in status.get("conditions", [])
    ):
        raise ValueError("original manifest Job did not succeed")
    parse = lambda value: datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not (parse(run["started"]) <= parse(metadata["creationTimestamp"])
            <= parse(status["completionTime"]) <= parse(run["stopped"])):
        raise ValueError("original manifest Job is outside original build run lifetime")
    containers = job["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1 or containers[0].get("name") != "combine-and-verify":
        raise ValueError("original manifest Job container mismatch")
    environment = {item["name"]: item.get("value") for item in containers[0].get("env", [])}
    if (environment.get("IMAGE_REPO") != IMAGE_REPO
            or environment.get("AMD64_DIGEST") != children["amd64"]
            or environment.get("ARM64_DIGEST") != children["arm64"]):
        raise ValueError("original manifest Job child binding mismatch")
    records = structured_records(log)
    if not records:
        raise ValueError("original manifest Job has no structured publication")
    validate_records(records, index_digest, children)
    return {"uid": metadata["uid"], "name": expected, "publication": records[-1]}


def eligible_nodes(items):
    result = []
    for node in items:
        labels = node["metadata"].get("labels", {})
        if (node.get("spec", {}).get("unschedulable") is True
                or labels.get("shizuha.io/disk-class") == "small"
                or not any(item.get("type") == "Ready" and item.get("status") == "True"
                           for item in node.get("status", {}).get("conditions", []))):
            continue
        if labels.get("node-role.kubernetes.io/control-plane") is None or labels.get("shizuha.io/platform") == "true":
            result.append(node["metadata"]["name"])
    if not result:
        raise ValueError("no Ready agent-eligible pre-pull nodes found")
    return sorted(set(result))


def render_prepull(node, candidate_tag, digest):
    return {
        "apiVersion": "batch/v1", "kind": "Job",
        "metadata": {"name": f"ci-prepull-agentrt-{candidate_tag}-{node}", "namespace": "build",
                     "labels": {"app": "ci-prepull", "service": "agent-runtime"}},
        "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 900, "ttlSecondsAfterFinished": 3600,
                 "template": {"spec": {"restartPolicy": "Never", "nodeName": node,
                     "tolerations": [{"operator": "Exists"}], "containers": [{
                         "name": "prepull", "image": f"localhost:30500/{IMAGE_REPO}@{digest}",
                         "imagePullPolicy": "Always", "command": ["/bin/true"],
                         "resources": {"requests": {"cpu": "10m", "memory": "16Mi"},
                                       "limits": {"cpu": "100m", "memory": "64Mi"}},
                     }]}}},
    }


def terminal_result(job, pods, node=None):
    conditions = job.get("status", {}).get("conditions", [])
    if any(item.get("type") == "Complete" and item.get("status") == "True" for item in conditions):
        return {"status": "passed"}
    failed = any(item.get("type") == "Failed" and item.get("status") == "True" for item in conditions)
    phase = pods[0].get("status", {}).get("phase") if pods else None
    if node is None:
        if failed or phase == "Failed":
            raise ValueError("native runtime smoke failed")
        return {"status": "passed"} if phase == "Succeeded" else None
    if failed:
        status = pods[0].get("status", {}) if pods else {}
        messages = [item.get("message", "") for item in status.get("conditions", [])
                    if item.get("type") == "PodScheduled"]
        messages += [status.get("reason", ""), status.get("message", "")]
        message = " ".join(messages)
        if re.search(r"Insufficient memory|didn.t satisfy plugin|OutOfmemory|didn.t have enough resource", message, re.I):
            return {"status": "skipped", "reason": f"unschedulable ({message})"}
        raise ValueError(f"runtime image fleet pre-pull failed: {message}")
    ready = any(item.get("type") == "Ready" and item.get("status") == "True"
                for item in node.get("status", {}).get("conditions", []))
    return None if ready else {"status": "skipped", "reason": "node became unavailable"}


def wait_job(name, timeout, node_name=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = json.loads(kubectl(["-n", "build", "get", "job", name, "-o", "json"]))
        pods = json.loads(kubectl(["-n", "build", "get", "pods", "-l", f"job-name={name}", "-o", "json"]))["items"]
        node = json.loads(kubectl(["get", "node", node_name, "-o", "json"])) if node_name else None
        result = terminal_result(job, pods, node)
        if result:
            if result["status"] == "skipped":
                kubectl(["-n", "build", "delete", "job", name, "--wait=false"])
            elif node_name is None:
                print(kubectl(["-n", "build", "logs", f"job/{name}"]), flush=True)
            return {"job": name, **result}
        time.sleep(5)
    raise ValueError(f"runtime qualification timed out: {name}")


def qualify(args):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("runtime qualification is an Origin CI operation")
    if Path(args.receipt).exists():
        raise ValueError("qualification receipt already exists")
    _require_sha("runtime source", args.source_sha)
    _require_sha("qualification source", args.workflow_sha)
    _require_digest("runtime index", args.index_digest)
    if args.build_run_id <= 0 or args.qualification_run_id <= args.build_run_id:
        raise ValueError("invalid original or qualification run ID")
    if command(["git", "rev-parse", "HEAD"]).strip() != args.workflow_sha:
        raise ValueError("qualification checkout differs from its event source")
    command(["git", "merge-base", "--is-ancestor", args.source_sha, args.workflow_sha])
    skills_sha = command(["git", "show", f"{args.source_sha}:runtime-skills.lock"]).strip()
    _require_sha("skills lock", skills_sha)
    secret = json.loads(kubectl(["-n", "origin", "get", "secret", "ci-logs-reader", "-o", "json"]))
    token = base64.b64decode(secret["data"]["FORGEJO_TOKEN"]).decode()
    run = json.loads(authenticated(f"{API}/repos/{REPOSITORY}/actions/runs/{args.build_run_id}", token))
    run_index = validate_run(run, args.build_run_id, args.source_sha)
    current = json.loads(authenticated(f"{API}/repos/{REPOSITORY}/actions/runs/{args.qualification_run_id}", token))
    validate_primary_run(current)
    if (current.get("id") != args.qualification_run_id or current.get("commit_sha") != args.workflow_sha
            or current.get("workflow_id") != "qualify-agent-runtime.yml"
            or current.get("repository", {}).get("full_name") != REPOSITORY
            or current.get("status") != "running" or current.get("trigger_event") != "workflow_dispatch"):
        raise ValueError("qualification run authority mismatch")
    log = authenticated(f"{LOGS}/logs?repo={REPOSITORY}&run={run_index}", token, "Bearer")
    if run["status"] == "failure" and not re.search(
        r"^\d{4}-\d\d-\d\dT\S+\s+::error::runtime image fleet pre-pull (?:failed|timed out) on ", log, re.M,
    ):
        raise ValueError("failed original build did not reach fleet pre-pull qualification")
    display_tag, versions = publication_details(log, run)
    children, versions = verify_registry(args.index_digest, args.source_sha, args.build_run_id, skills_sha, versions)
    _, tag_digest = _fetch_manifest(REGISTRY, IMAGE_REPO, display_tag, INDEX_ACCEPT)
    if tag_digest != args.index_digest:
        raise ValueError("original publication tag differs from requested immutable index")
    records = structured_records(log)
    validate_records(records, args.index_digest, children)
    old_name = f"ci-manifest-agentrt-candidate-{args.build_run_id}-{args.source_sha[:7]}"
    old_job = kubectl(["-n", "build", "get", "job", old_name, "--ignore-not-found", "-o", "json"]).strip()
    retained = None
    if old_job:
        retained = validate_live_manifest(json.loads(old_job), kubectl(["-n", "build", "logs", f"job/{old_name}"]),
                                          run, args.build_run_id, args.source_sha, args.index_digest, children)
    source = Path(args.source_directory)
    source.mkdir(parents=True, exist_ok=False)
    for name in ("scripts/render-agent-runtime-smoke-job.py", "scripts/verify-agent-runtime-startup.py", "agent-runtime-entrypoint.sh"):
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(command(["git", "show", f"{args.source_sha}:{name}"]))
    candidate_tag = f"qualify-{args.qualification_run_id}-{args.source_sha[:7]}"
    smoke_names = []
    for arch in ("amd64", "arm64"):
        rendered = command(["python3", str(source / "scripts/render-agent-runtime-smoke-job.py"), arch,
                            candidate_tag, IMAGE_REPO, *[versions[name] for name in VERSIONS], skills_sha, children[arch]])
        job = json.loads(rendered)
        kubectl(["create", "-f", "-"], json.dumps(job))
        smoke_names.append(job["metadata"]["name"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        smokes = list(pool.map(lambda name: wait_job(name, 1800), smoke_names))
    nodes = eligible_nodes(json.loads(kubectl(["get", "nodes", "-o", "json"]))["items"])
    names = {}
    for node in nodes:
        job = render_prepull(node, candidate_tag, args.index_digest)
        kubectl(["create", "-f", "-"], json.dumps(job))
        names[node] = job["metadata"]["name"]
    with ThreadPoolExecutor(max_workers=min(len(nodes), 32)) as pool:
        pulls = list(pool.map(lambda node: {"node": node, **wait_job(names[node], 900, node)}, nodes))
    receipt = {"passed": True, "source_sha": args.source_sha, "workflow_source_sha": args.workflow_sha,
               "run_id": args.qualification_run_id, "ci_url": current["html_url"], "display_tag": display_tag,
               "build_run_id": args.build_run_id, "qualification_run_id": args.qualification_run_id,
               "image_digest": args.index_digest, "children": children, "harness_versions": versions,
               "skills_sha": skills_sha, "native_smokes": smokes, "prepulls": pulls,
               "provenance": {"authenticated_build_run": run["html_url"], "candidate_tags_verified": True,
                              "child_labels_verified": True, "structured_publications": records,
                              "retained_manifest_job": retained},
               "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    Path(args.receipt).write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"runtime_qualification_receipt": receipt}, sort_keys=True), flush=True)


def main():
    parser = argparse.ArgumentParser()
    for name in ("source-sha", "workflow-sha", "index-digest", "receipt", "source-directory"):
        parser.add_argument(f"--{name}", required=True)
    for name in ("build-run-id", "qualification-run-id"):
        parser.add_argument(f"--{name}", type=int, required=True)
    args = parser.parse_args()
    try:
        qualify(args)
    except Exception as error:
        if not Path(args.receipt).exists():
            Path(args.receipt).write_text(json.dumps({"passed": False, "error": str(error),
                "source_sha": args.source_sha, "workflow_source_sha": args.workflow_sha,
                "build_run_id": args.build_run_id, "run_id": args.qualification_run_id,
                "image_digest": args.index_digest}, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
