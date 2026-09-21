"""PLAT-5655 regression: re-keyed accepted false positive is suppressed.

The Semgrep `run-shell-injection` finding on `.forgejo/workflows/build-publish-scli.yml`
was accepted as a false positive (PLAT-4771) and allowlisted under source
`security-ci:a8d052ce...`. Because the source_id fingerprint includes the line
number, the same finding re-keyed to `security-ci:94cf54e3...` after line
movement (now at line 60) and stopped matching the allowlist.

This test exercises the REAL `load_allowlist()` / `allowlisted()` boundary in
`scripts/security-ci-to-pulse.py` and asserts:
  - the checked-in allowlist carries the re-keyed source_id with the exact
    tool/rule/path/owner/rationale binding (the task's core requirement);
  - `allowlisted()` suppresses a finding carrying that exact source_id;
  - an unrelated path with the same rule is NOT suppressed;
  - a wrong-rule variant on the same path is NOT suppressed.
"""

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "security-ci-to-pulse.py"
ALLOWLIST = REPO_ROOT / ".security-ci-allowlist.json"

_spec = importlib.util.spec_from_file_location("security_ci_to_pulse", SCRIPT)
sci = importlib.util.module_from_spec(_spec)
sys.modules["security_ci_to_pulse"] = sci
_spec.loader.exec_module(sci)

RULE = "yaml.github-actions.security.run-shell-injection.run-shell-injection"
PATH = ".forgejo/workflows/build-publish-scli.yml"
REKEYED_SOURCE = "security-ci:94cf54e38e65480cdef04927"
ORIGINAL_SOURCE = "security-ci:a8d052ce9db1c7a6f5d0b04e"

# Exact semgrep rule message (semgrep-rules run-shell-injection.yaml). The
# source_id fingerprint is sha256(tool|rule|path|line|title)[:24], so the title
# must match what the scanner emitted for the fingerprint to reproduce.
SEMGREP_MESSAGE = (
    "Using variable interpolation `${{...}}` with `github` context data in a `run:` step could "
    "allow an attacker to inject their own code into the runner. This would allow them to steal secrets "
    "and code. `github` context data can have arbitrary user input and should be treated as untrusted. "
    "Instead, use an intermediate environment variable with `env:` to store the data and use the environment "
    "variable in the `run:` script. Be sure to use double-quotes the environment variable, like this: \"$ENVVAR\"."
)


def _finding(tool="semgrep", rule=RULE, path=PATH, line=60, title=SEMGREP_MESSAGE):
    return sci.Finding(
        tool=tool,
        rule=rule,
        severity="high",
        title=title,
        path=path,
        line=line,
        detail=SEMGREP_MESSAGE,
    )


def _entries():
    return sci.load_allowlist(str(ALLOWLIST))


def _find_entry(source_id):
    for e in _entries():
        if e.get("source_id") == source_id:
            return e
    return None


def test_rekeyed_entry_binding():
    """The re-keyed source must be allowlisted with exact tool/rule/path/owner/reason."""
    e = _find_entry(REKEYED_SOURCE)
    assert e is not None, "re-keyed source_id entry missing from allowlist"
    assert e["tool"] == "semgrep"
    assert e["rule"] == RULE
    assert e["path_contains"] == PATH
    assert e["owner"]
    assert e["reason"]


def test_original_entry_preserved():
    """The original PLAT-4771 entry must remain (no regression)."""
    e = _find_entry(ORIGINAL_SOURCE)
    assert e is not None, "original PLAT-4771 allowlist entry missing"
    assert e["tool"] == "semgrep"
    assert e["rule"] == RULE
    assert e["path_contains"] == PATH


def test_rekeyed_finding_suppressed():
    """A finding carrying the exact re-keyed source_id must be suppressed.

    The source_id is sha256(tool|rule|path|line|title)[:24]. We reproduce the
    exact re-keyed fingerprint (line 60) from the real semgrep message and
    assert the allowlist suppresses it.
    """
    entries = _entries()
    f = _finding(line=60)
    assert f.source_id == REKEYED_SOURCE, f.source_id
    assert sci.allowlisted(f, entries) is not None


def test_original_finding_still_suppressed():
    """The original PLAT-4771 finding (line 62) must remain suppressed."""
    entries = _entries()
    f = _finding(line=62)
    assert f.source_id == ORIGINAL_SOURCE, f.source_id
    assert sci.allowlisted(f, entries) is not None


def test_unrelated_path_not_suppressed():
    """Same rule on a different path must NOT be suppressed."""
    entries = _entries()
    f = _finding(path=".forgejo/workflows/some-other-workflow.yml", line=60)
    assert sci.allowlisted(f, entries) is None


def test_wrong_rule_not_suppressed():
    """A different rule on the same path must NOT be suppressed."""
    entries = _entries()
    f = _finding(rule="yaml.github-actions.security.injection.generic-injection", line=60)
    assert sci.allowlisted(f, entries) is None


def test_allowlist_file_shape():
    """The allowlist file must parse and carry the required binding fields."""
    data = json.loads(ALLOWLIST.read_text())
    entries = data.get("allowlist") or data.get("suppressions") or []
    assert len(entries) >= 2
    for e in entries:
        assert e.get("source_id")
        assert e.get("tool")
        assert e.get("rule")
        assert e.get("path_contains")
        assert e.get("owner")
        assert e.get("reason")
