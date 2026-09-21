"""PLAT-4734 — `${{ github.* }}` / `${{ secrets.* }}` must never reach a `run:` shell body.

semgrep `run-shell-injection` / CWE-78. Forgejo/GitHub expand `${{ ... }}` by
substituting the value into the shell script *as text*, before the shell parses it.
Any expansion whose value a caller can influence is therefore code execution on the
runner, with whatever credentials that lane carries.

Two of the values this repo interpolated are genuinely caller-controlled:

  * `github.event.inputs.version` — free text from whoever dispatches the workflow.
  * `github.ref` — a git ref. Refs may legally contain `$`, backticks, `;`, `&`,
    `(`, `)` and quotes; only a short list of characters is actually forbidden. A
    branch named `x";id;"` is a valid branch.

Both landed inside a heredoc that renders a Kubernetes Job applied with cluster
credentials on `deploy-lane`, so the blast radius was the cluster, not just the job.

The fix is to bind every such value through `env:` and reference `"$VAR"` in the
body: env values are passed to the process, never parsed as script text.

This file is the committed negative control. Fixing the affected workflows proves
the state today; this test is what keeps a *new* workflow from reintroducing the
pattern tomorrow, which is where the finding came from in the first place.

DETECTION STRATEGY — parse, don't pattern-match (@rui, PR #129 review).
The first version of this scanner walked raw lines and recognised only a bare
`run:` or `run: |`. Both of these are valid workflow syntax and both slipped past:

    - run: echo "${{ github.ref }}"        # inline scalar
    - run: >                               # folded scalar
        echo "${{ github.ref }}"

so the guard could stay green while the CWE-78 pattern returned. It now parses the
workflow and inspects `jobs.*.steps[*].run` strings, which is form-agnostic: inline,
literal (`|`) and folded (`>`) all arrive as the same Python string.

That was the third time on this task that the *instrument* was the defect rather
than the code under test — first a `github.`-only regex that missed four `secrets.`
interpolations, then an unquoted step name that broke the workflow itself, now
run-scalar coverage. Hence the controls below, which are not ceremony: they assert
the detector still detects.

STRUCTURAL INVARIANT — no `${{ ... }}` in a run body at all (@rui, PR #129 review,
round 2). The earlier rule matched `github.`/`secrets.` dot notation only, which
left documented index-form contexts (`github['sha']`) and caller-supplied dispatch
`inputs` as bypasses — a regex over the expression grammar silently inherits every
syntax form the author did not think of. The robust invariant is structural: **no
`${{ ... }}` expression may appear in a `run:` body**; every value binds through
`env:` and is referenced as `"$VAR"`. Forgejo/GitHub expand `${{ ... }}` into the
shell script *as text* before the shell parses it, so *any* expression in a run
body is a code-execution surface regardless of which context it reads. This rule is
form-agnostic by construction (dot, index, `inputs`, `env`, `matrix` — all are
caught uniformly) and it cannot be bypassed by learning a new syntax form.
"""
from pathlib import Path
import re
import unittest

# Imported at module scope deliberately. If no parser is available every test
# here must ERROR rather than skip: a guard that quietly does nothing when its
# parser is absent reports the same green as a clean repo, which is the exact
# failure class this file exists to prevent.
#
# PyYAML is used when the environment ships it. The premerge-parity runner
# image ships no PyYAML and has no PyPI egress (the step's `pip install`
# fallback failed on every run — PLAT-9226 parity lane), so when the import
# fails we fall back to the vendored fail-closed subset parser in
# tests/ci/_mini_yaml.py. That fallback parses for real and raises on anything
# it does not understand, so the guard still fails closed — it never degrades
# to a silent skip.
try:
    import yaml
    _mini_loads = None
except ImportError:
    yaml = None
    try:
        from tests.ci._mini_yaml import loads as _mini_loads
    except ImportError:  # executed as a bare file with tests/ci on sys.path
        from _mini_yaml import loads as _mini_loads  # type: ignore[no-redef]


def _safe_load(text):
    """Parse with PyYAML when present, else the vendored fail-closed parser."""
    if yaml is not None:
        return yaml.safe_load(text)
    return _mini_loads(text)

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIRS = (ROOT / ".forgejo" / "workflows", ROOT / ".github" / "workflows")

# Structural invariant: NO `${{ ... }}` expression may appear in a run body at all
# (see the module docstring). Forgejo/GitHub splice the expanded value into the
# shell script as text before parsing, so any expression is a code-execution
# surface — dot form, index form (`github['sha']`), and caller-supplied dispatch
# `inputs` included. The sanctioned pattern binds every value through `env:` and
# references "$VAR" in the body, which contains no `${{`.
EXPRESSION = re.compile(r"\$\{\{")


def iter_run_scripts(doc):
    """Yield ``(location, script)`` for every ``jobs.*.steps[*].run`` in a workflow.

    Covers inline, literal and folded scalars identically — YAML resolves the
    scalar style before we see the value.
    """
    jobs = (doc or {}).get("jobs")
    if not isinstance(jobs, dict):
        return
    for job_name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps")
        if not isinstance(steps, list):
            continue
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            script = step.get("run")
            if isinstance(script, str):
                yield f"jobs.{job_name}.steps[{index}].run", script


def find_context_in_run_bodies(text):
    """Return ``[(location, line)]`` for dangerous context expansions in run scripts.

    Raises on unparseable input rather than returning ``[]`` — see the module note
    about failing closed.
    """
    doc = _safe_load(text)
    offenders = []
    for location, script in iter_run_scripts(doc):
        for lineno, line in enumerate(script.splitlines(), 1):
            if EXPRESSION.search(line):
                offenders.append((f"{location}:{lineno}", line.strip()))
    return offenders


def workflow_files():
    files = []
    for directory in WORKFLOW_DIRS:
        if directory.is_dir():
            files.extend(sorted(p for p in directory.iterdir()
                                if p.suffix in (".yml", ".yaml")))
    return files


class DetectorSelfTests(unittest.TestCase):
    """Positive/negative controls for the scanner itself.

    Every clean-repo assertion in the next class is worth exactly as much as these.
    """

    def _wf(self, step_yaml):
        # A complete, valid workflow so the parser sees what Forgejo sees.
        return "name: t\non:\n  push: {}\njobs:\n  j:\n    steps:\n" + step_yaml

    def test_detects_literal_block_scalar(self):
        hits = find_context_in_run_bodies(self._wf(
            '      - run: |\n          echo "${{ github.ref }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"literal form missed: {hits}")
        self.assertIn("github.ref", hits[0][1])

    def test_detects_inline_scalar(self):
        """@rui's first bypass case — `- run: echo ...` on one line."""
        hits = find_context_in_run_bodies(self._wf(
            '      - run: echo "${{ github.ref }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"inline form missed: {hits}")
        self.assertIn("github.ref", hits[0][1])

    def test_detects_folded_scalar(self):
        """@rui's second bypass case — `- run: >` folded block."""
        hits = find_context_in_run_bodies(self._wf(
            '      - run: >\n          echo "${{ github.ref }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"folded form missed: {hits}")
        self.assertIn("github.ref", hits[0][1])

    def test_detects_secrets_context_too(self):
        """The original scanner matched `github.` only and missed four real
        `secrets.KUBE_CONFIG_B64` interpolations of the identical class."""
        hits = find_context_in_run_bodies(self._wf(
            '      - run: printf %s "${{ secrets.KUBE_CONFIG_B64 }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"secrets context missed: {hits}")

    def test_detects_index_form_github(self):
        """@rui's round-2 bypass — documented index syntax `github['sha']`."""
        hits = find_context_in_run_bodies(self._wf(
            '      - run: echo "${{ github[\'sha\'] }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"index-form github missed: {hits}")
        self.assertIn("github['sha']", hits[0][1])

    def test_detects_index_form_secrets(self):
        """Index syntax on secrets is the same injection class as dot form."""
        hits = find_context_in_run_bodies(self._wf(
            '      - run: printf %s "${{ secrets[\'KUBE_CONFIG_B64\'] }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"index-form secrets missed: {hits}")

    def test_detects_caller_supplied_inputs(self):
        """@rui's round-2 bypass — `inputs` carries values from manual/reusable
        dispatch, i.e. caller-controlled, and must be env-bound like any other."""
        hits = find_context_in_run_bodies(self._wf(
            '      - run: echo "${{ inputs.version }}"\n'
        ))
        self.assertEqual(len(hits), 1, msg=f"inputs context missed: {hits}")
        self.assertIn("inputs.version", hits[0][1])

    def test_does_not_flag_env_bindings(self):
        """The sanctioned fix must not be flagged, or the rule is unusable and gets
        switched off."""
        hits = find_context_in_run_bodies(self._wf(
            "      - env:\n"
            "          SHA: ${{ github.sha }}\n"
            "          TOK: ${{ secrets.KUBE_CONFIG_B64 }}\n"
            "        run: |\n"
            '          printf %s "$TOK" | base64 -d\n'
            '          echo "$SHA"\n'
        ))
        self.assertEqual(hits, [])

    def test_does_not_flag_non_run_keys(self):
        """`uses:`/`with:`/`if:` inputs are not shell bodies and are out of scope."""
        hits = find_context_in_run_bodies(self._wf(
            "      - uses: actions/checkout@v4\n"
            "        with:\n"
            "          ref: ${{ github.sha }}\n"
        ))
        self.assertEqual(hits, [])

    def test_unparseable_input_raises_rather_than_returning_clean(self):
        """Failing closed: a broken workflow must not read as 'no offenders'."""
        with self.assertRaises(Exception):
            find_context_in_run_bodies("jobs:\n  j:\n    steps: [oops\n")


class ContextInjectionTests(unittest.TestCase):
    def test_no_workflow_interpolates_context_into_a_shell_body(self):
        found = []
        for path in workflow_files():
            for location, line in find_context_in_run_bodies(path.read_text()):
                found.append(f"{path.relative_to(ROOT)} {location}: {line}")
        self.assertEqual(
            found, [],
            msg=(
                "github/secrets context interpolated into a run: body — bind it "
                "through `env:` and reference \"$VAR\" instead:\n  "
                + "\n  ".join(found)
            ),
        )

    def test_every_workflow_is_parseable_yaml(self):
        """A workflow that does not parse is not a workflow — the runner falls back
        to labelling the check with the commit message and the job never runs the
        steps you think it does.

        This exists because I broke it: the step name added for this very finding
        was `No github/secrets context in run: bodies`, and the unquoted `: ` inside
        a plain scalar is a YAML mapping error. I had parse-checked the workflows
        BEFORE making that edit and not after, so a manual pre-flight passed while
        the pushed tree was broken. Manual checks bind to the moment they were run;
        committed ones bind to the tree.
        """
        broken = []
        for path in workflow_files():
            try:
                _safe_load(path.read_text())
            except Exception as exc:
                broken.append(f"{path.relative_to(ROOT)}: {exc}")
        self.assertEqual(broken, [], msg="unparseable workflow(s):\n  " + "\n  ".join(broken))

    def test_scan_actually_covered_the_workflows(self):
        """Guards the scan itself: an empty or mis-rooted file list would make the
        assertions above pass vacuously."""
        files = workflow_files()
        self.assertGreaterEqual(len(files), 5, msg=f"suspiciously few workflows scanned: {files}")
        self.assertTrue(
            any(p.name == "build-publish-scli.yml" for p in files),
            msg="the workflow the finding was raised against was not scanned",
        )

    def test_scan_reaches_run_scripts_in_the_real_workflows(self):
        """Coverage assertion for the parser path specifically: if `iter_run_scripts`
        yielded nothing for the real tree — a schema change, a rename, a parser
        regression — the clean result above would be meaningless."""
        total = 0
        for path in workflow_files():
            total += sum(1 for _ in iter_run_scripts(_safe_load(path.read_text())))
        self.assertGreater(total, 5, msg=f"only {total} run scripts found across the tree")

    def test_dispatch_version_input_is_shape_constrained(self):
        """env-binding stops the SHELL parsing the value, but `inputs.version` is
        also spliced into rendered YAML, where a newline still restructures the Job
        spec. Defence for that lives at the boundary, not the interpolation site."""
        text = (ROOT / ".forgejo" / "workflows" / "build-publish-scli.yml").read_text()
        self.assertIn("INPUT_VERSION: ${{ github.event.inputs.version }}", text,
                      msg="dispatch input must be env-bound")
        self.assertRegex(
            text, r"grep -qE '\^\[A-Za-z0-9\._\+-\]\{1,64\}\$'",
            msg="dispatch input must be shape-validated before it reaches rendered YAML",
        )
        self.assertIn("refusing dispatch input", text,
                      msg="validation must fail closed with a stated reason")


if __name__ == "__main__":
    unittest.main()
