"""Actual source-publication helper boundary; no credentials or cluster calls."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from tests.ci._mini_yaml import loads as safe_load

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts' / 'update-hive-broker-pins.py'
OLD = 'localhost:30500/mcp-auth-proxy:src-02faad3c0452'
SHA = 'a' * 40
NEW = 'localhost:30500/mcp-auth-proxy:src-' + SHA[:12]
FILES = {
    'hive_project/settings.py': "FLEET_BROKER_IMAGE = os.environ.get(\n    'FLEET_BROKER_IMAGE',\n    '%s',\n)\n",
    'k8s/hive-backend-live.yaml': '            - name: FLEET_BROKER_IMAGE\n              value: %s\n',
    'k8s/shizuha-hive.yaml': '            - name: FLEET_BROKER_IMAGE\n              value: %s\n',
    '.forgejo/scripts/ring-release-fleet.sh': '    ensure_env(container, "FLEET_BROKER_IMAGE", "%s")\n',
}

class HiveBrokerPinPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, template in FILES.items():
            p = self.root / name; p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(template % OLD)
    def run_helper(self, image=NEW):
        return subprocess.run([sys.executable, str(HELPER), '--hive-root', str(self.root),
            '--image', image, '--source-sha', SHA], capture_output=True, text=True)
    def snapshot(self):
        return {name: (self.root / name).read_bytes() for name in FILES}
    def test_actual_caller_updates_exact_four_sources_then_is_idempotent(self):
        before = self.snapshot(); result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['changed_paths'], list(FILES))
        for name, old in before.items():
            self.assertEqual((self.root / name).read_bytes(), old.replace(OLD.encode(), NEW.encode()))
        again = self.run_helper(); self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)['changed_paths'], [])
    def test_one_drifted_source_refuses_before_any_write(self):
        p = self.root / 'k8s/shizuha-hive.yaml'; p.write_text(FILES['k8s/shizuha-hive.yaml'] % NEW)
        before = self.snapshot(); result = self.run_helper()
        self.assertNotEqual(result.returncode, 0); self.assertEqual(self.snapshot(), before)
    def test_missing_or_duplicate_pin_refuses_before_any_write(self):
        p = self.root / '.forgejo/scripts/ring-release-fleet.sh'
        for body in ('# missing\n', (FILES[str(p.relative_to(self.root))] % OLD) * 2):
            p.write_text(body); before = self.snapshot(); result = self.run_helper()
            self.assertNotEqual(result.returncode, 0); self.assertEqual(self.snapshot(), before)
    def test_image_must_bind_exact_published_source(self):
        before = self.snapshot()
        for image in ('mcp-auth-proxy:latest', 'localhost:30500/mcp-auth-proxy:src-' + 'b' * 12):
            self.assertNotEqual(self.run_helper(image).returncode, 0)
            self.assertEqual(self.snapshot(), before)

    def run_publication(self):
        """Execute the actual workflow shell; only cluster/remote transport is stubbed."""
        real_git = shutil.which('git')
        subprocess.run([real_git, 'init', '-b', 'main', str(self.root)], check=True, capture_output=True)
        for args in (['config', 'user.name', 'fixture'], ['config', 'user.email', 'fixture@example.test'],
                     ['add', *FILES], ['commit', '-m', 'fixture']):
            subprocess.run([real_git, '-C', str(self.root), *args], check=True, capture_output=True)
        bindir = self.root / 'bin'; bindir.mkdir()
        log = self.root / 'operations'
        git = bindir / 'git'
        git.write_text(f'''#!{sys.executable}
import os, pathlib, subprocess, sys
a = sys.argv[1:]
if 'clone' in a:
    sys.exit(subprocess.call([os.environ['REAL_GIT'], 'clone', '--branch', 'main', os.environ['FIXTURE_REPO'], a[-1]]))
if 'commit' in a or 'push' in a:
    with open(os.environ['OPERATIONS'], 'a') as f: f.write(('push' if 'push' in a else 'commit') + '\\n')
if 'push' in a:
    root = a[a.index('-C') + 1]
    pathlib.Path(os.environ['PUBLISHED_TREE']).write_text(subprocess.check_output([os.environ['REAL_GIT'], '-C', root, 'show', 'HEAD:hive_project/settings.py'], text=True))
    sys.exit(0)
sys.exit(subprocess.call([os.environ['REAL_GIT'], *a]))
''')
        git.chmod(0o755)
        kubectl = bindir / 'kubectl'
        kubectl.write_text('#!/bin/sh\nprintf Zml4dHVyZS10b2tlbg==\n')
        kubectl.chmod(0o755)
        result = subprocess.run(['bash', str(ROOT / 'scripts/publish-hive-broker.sh')], cwd=ROOT, capture_output=True, text=True,
            env={**os.environ, 'PATH': str(bindir) + ':' + os.environ['PATH'], 'SOURCE_SHA': SHA,
                 'GIT_PASSWORD': 'fixture-token',
                 'REAL_GIT': real_git, 'FIXTURE_REPO': str(self.root), 'OPERATIONS': str(log),
                 'PUBLISHED_TREE': str(self.root / 'published')})
        return result, log.read_text() if log.exists() else ''

    def test_actual_workflow_shell_commits_all_pins_before_one_push(self):
        result, operations = self.run_publication()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(operations, 'commit\npush\n')
        self.assertIn(NEW, (self.root / 'published').read_text())

    def test_actual_workflow_shell_drift_never_commits_or_pushes(self):
        (self.root / 'k8s/shizuha-hive.yaml').write_text(FILES['k8s/shizuha-hive.yaml'] % NEW)
        result, operations = self.run_publication()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source pins disagree', result.stderr)
        self.assertEqual(operations, '')

    def test_actual_workflow_shell_idempotence_does_not_publish_empty_commit(self):
        self.assertEqual(self.run_helper().returncode, 0)
        result, operations = self.run_publication()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(operations, '')

    def run_runner_transport(self, existing=False):
        workflow = (ROOT / '.forgejo/workflows/build-mcp-auth-proxy.yml').read_text()
        steps = safe_load(workflow)['jobs']['build']['steps']
        step = next(s for s in steps if s.get('name') == 'Publish qualified broker to native Hive source authority')
        bindir = self.root / 'bin'; bindir.mkdir()
        rendered = self.root / 'job.yaml'
        kubectl = bindir / 'kubectl'
        kubectl.write_text('#!/bin/sh\necho "$*" >> "$TRANSPORT_CALLS"\ncase "$*" in\n*"get secret"*) echo Forbidden >&2; exit 1;;\ndelete*) echo "refuse deleting a Git writer" >&2; exit 1;;\n"create -f -") cat > "$RENDERED_JOB"; if [ "$EXISTING_WRITER" = 1 ]; then echo AlreadyExists >&2; exit 1; fi;;\nesac\n')
        kubectl.chmod(0o755)
        result = subprocess.run(['bash', '-c', step['run']], capture_output=True, text=True,
            env={**os.environ, 'PATH': str(bindir) + ':' + os.environ['PATH'],
                 'SOURCE_SHA': SHA, 'RENDERED_JOB': str(rendered), 'EXISTING_WRITER': str(int(existing)),
                 'TRANSPORT_CALLS': str(self.root / 'transport-calls')})
        return result, rendered

    def test_existing_same_source_git_writer_refuses_replacement(self):
        result, _ = self.run_runner_transport(existing=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('AlreadyExists', result.stderr)
        self.assertEqual((self.root / 'transport-calls').read_text(), 'create -f -\n')

    def test_actual_runner_renders_secret_bound_job_without_reading_secret(self):
        result, rendered = self.run_runner_transport()
        self.assertEqual(result.returncode, 0, result.stderr)
        # The vendored parser supports mapping block scalars but not a block
        # scalar as a sequence item; normalize only that representation.
        document = re.sub(r'(args:)\n( +)- \|\n', r'\1 |\n', rendered.read_text())
        job = safe_load(document)
        self.assertEqual(job['metadata']['namespace'], 'build')
        self.assertEqual(str(job['spec']['backoffLimit']), '0')
        self.assertEqual(str(job['spec']['activeDeadlineSeconds']), '300')
        spec = job['spec']['template']['spec']
        self.assertEqual(str(spec['automountServiceAccountToken']), 'false')
        for container in spec['initContainers'] + spec['containers']:
            secret = next(e for e in container['env'] if e['name'] == 'GIT_PASSWORD')
            self.assertEqual(secret['valueFrom']['secretKeyRef'], {'name': 'forgejo-token', 'key': 'password'})
        source = spec['initContainers'][0]['args']
        self.assertIn('fetch --depth=1 origin "' + SHA + '"', source)
        self.assertIn('rev-parse HEAD)', source)
        self.assertEqual(spec['containers'][0]['command'], ['bash', '/workspace/src/scripts/publish-hive-broker.sh'])
