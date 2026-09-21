"""Verify the live observer and Forgejo's exact compiled runtime-release policy."""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request


OBSERVER_SHA256 = "254f820774c235feb356a7b3495dbee850083feb0365e9bbffb34dd11ed6ad02"
AUTHORITY = "forgejo-native-concurrency"
WORKFLOW = "build-agent-runtime.yml"
GROUP = "build-agent-runtime"


def remote_receipt(run_id, source_sha, source_ref, repository):
    with urllib.request.urlopen("http://127.0.0.1:8080/version", timeout=10) as response:
        version = json.load(response)
    if version != {"authority": AUTHORITY, "source_sha256": OBSERVER_SHA256}:
        raise RuntimeError("running observer authority/source is not qualified")
    if hashlib.sha256(Path("/app/server.py").read_bytes()).hexdigest() != OBSERVER_SHA256:
        raise RuntimeError("projected observer source differs from qualified runtime")

    import psycopg2

    owner, name = repository.split("/")
    with closing(psycopg2.connect(
        host=os.environ.get("DB_HOST", "forgejo-db.origin.svc.cluster.local"),
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ.get("DB_NAME", "forgejo"),
        user=os.environ.get("DB_USER", "forgejo"),
        password=os.environ.get("DB_PASSWORD", ""),
        connect_timeout=10,
        options="-c default_transaction_read_only=on -c statement_timeout=10000",
    )) as connection:
        connection.set_session(readonly=True, isolation_level="REPEATABLE READ")
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT run.repo_id, run.workflow_id, run.ref, run.commit_sha, '
                'run.workflow_source_commit, run.workflow_directory, '
                'run.concurrency_type, run.concurrency_group, run.status, run.event '
                'FROM action_run run JOIN repository repo ON repo.id=run.repo_id '
                'JOIN "user" owner ON owner.id=repo.owner_id '
                'WHERE run.id=%s AND repo.lower_name=%s AND owner.lower_name=%s',
                (run_id, name, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise RuntimeError("exact runtime release run is unavailable")
            repo_id, workflow, ref, commit, workflow_commit, directory, mode, group, status, event = row
            if (workflow, ref, commit, workflow_commit or commit, directory, mode, group, status) != (
                WORKFLOW, source_ref, source_sha, source_sha, ".forgejo/workflows", 1, GROUP, 6
            ) or event not in ("push", "workflow_dispatch"):
                raise RuntimeError("runtime release identity/native queue-behind policy mismatch")
            cursor.execute(
                "SELECT id FROM action_run WHERE repo_id=%s AND concurrency_group=%s "
                "AND id<%s AND (status IS NULL OR status NOT IN (1,2,3,4)) LIMIT 1",
                (repo_id, GROUP, run_id),
            )
            if cursor.fetchone() is not None:
                raise RuntimeError("an older native release owner is not terminal")
    return {
        **version,
        "run_id": run_id,
        "source_commit": source_sha,
        "ref": source_ref,
        "repository": repository,
        "workflow": f".forgejo/workflows/{WORKFLOW}",
        "compiled_policy": "queue-behind",
        "concurrency_group": GROUP,
        "older_nonterminal_runs": 0,
    }


def kubectl(arguments, source=None):
    completed = subprocess.run(
        ["kubectl", *arguments], input=source, text=True, stdout=subprocess.PIPE,
        check=True, timeout=45,
    )
    return json.loads(completed.stdout)


def pod_identity(pod):
    metadata = pod.get("metadata", {})
    status = pod.get("status", {})
    containers = status.get("containerStatuses", [])
    if metadata.get("deletionTimestamp") or status.get("phase") != "Running":
        return None
    if not any(row.get("type") == "Ready" and row.get("status") == "True" for row in status.get("conditions", [])):
        return None
    if len(containers) != 1 or containers[0].get("name") != "coalescer" or not containers[0].get("ready"):
        return None
    identity = (metadata.get("name"), metadata.get("uid"), containers[0].get("containerID"))
    return identity if all(identity) else None


def verify(run_id, source_sha, source_ref, repository):
    if run_id <= 0 or not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("invalid release run/source")
    if source_ref not in ("refs/heads/main", "refs/heads/master"):
        raise ValueError("runtime release must use the primary ref")
    if repository != "shizuha-labs/shizuha-beta":
        raise ValueError("unexpected runtime source repository")
    inventory = kubectl(["get", "pods", "-n", "origin", "-l", "app=run-coalescer", "-o", "json"])
    candidates = [identity for pod in inventory["items"] if (identity := pod_identity(pod))]
    if len(candidates) != 1:
        raise RuntimeError("expected exactly one Ready nondeleting observer")
    name, uid, container_id = candidates[0]
    receipt = kubectl([
        "exec", "-i", "-n", "origin", name, "-c", "coalescer", "--", "python3", "-B", "-",
        "--remote", "--run-id", str(run_id), "--source-sha", source_sha,
        "--source-ref", source_ref, "--repository", repository,
    ], Path(__file__).read_text())
    expected = {
        "authority": AUTHORITY, "source_sha256": OBSERVER_SHA256,
        "run_id": run_id, "source_commit": source_sha, "ref": source_ref,
        "repository": repository, "workflow": f".forgejo/workflows/{WORKFLOW}",
        "compiled_policy": "queue-behind", "concurrency_group": GROUP,
        "older_nonterminal_runs": 0,
    }
    if receipt != expected:
        raise RuntimeError("runtime concurrency receipt mismatch")
    current = kubectl(["get", "pod", "-n", "origin", name, "-o", "json"])
    if pod_identity(current) != (name, uid, container_id):
        raise RuntimeError("observer incarnation changed during verification")
    return {**receipt, "observer_pod_uid": uid, "observer_container_id": container_id}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--remote", action="store_true")
    args = parser.parse_args()
    operation = remote_receipt if args.remote else verify
    print(json.dumps(operation(args.run_id, args.source_sha, args.source_ref, args.repository), sort_keys=True))


if __name__ == "__main__":
    main()
