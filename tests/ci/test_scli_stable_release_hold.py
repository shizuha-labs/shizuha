"""Execute the actual workflow policy and finalize shell with a local package API."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = Path(os.environ.get('SCLI_WORKFLOW_UNDER_TEST',
                              ROOT / '.forgejo/workflows/build-publish-scli.yml'))
SOURCE = 'a' * 40
PLATFORMS = ('linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64')


class StableReleaseHoldTests(unittest.TestCase):
    def policy(self, hold='', expected='', source=SOURCE):
        text = WORKFLOW.read_text()
        match = re.search(r'# BEGIN SCLI stable release policy\n(.*?)# END SCLI stable release policy',
                          text, re.S)
        self.assertIsNotNone(match, 'workflow must validate release policy before cluster access')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', match[1]],
                                    env={**os.environ, 'STABLE_RELEASE_HOLD': hold,
                                         'SOURCE_SHA': source, 'EXPECTED_SOURCE_SHA': expected,
                                         'GITHUB_OUTPUT': str(output)}, capture_output=True, text=True)
            return result, output.read_text() if output.exists() else ''

    def test_missing_and_false_keep_existing_automatic_release(self):
        for value in ('', 'false'):
            result, output = self.policy(value)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output, 'held=false\n')

    def test_hold_and_exact_dispatch_fence(self):
        result, output = self.policy('true', SOURCE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, 'held=true\n')

    def test_invalid_policy_and_wrong_source_refuse_before_output(self):
        for hold, expected, source in [('TRUE', '', SOURCE), ('1', '', SOURCE),
                                        (' true', '', SOURCE), ('true\n', '', SOURCE),
                                        ('false', 'b' * 40, SOURCE),
                                        ('false', 'main', SOURCE), ('false', '', 'main')]:
            with self.subTest(hold=hold, expected=expected, source=source):
                result, output = self.policy(hold, expected, source)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, '')

    def finalize(self, hold, *, missing=None, wrong_source=None, corrupt=None):
        text = WORKFLOW.read_text()
        start = text.index('                        set -eu\n', text.index('name: finalize'))
        end = text.index('\n          YAML', start)
        script = '\n'.join(line[24:] for line in text[start:end].splitlines())
        script = script.replace('\\$', '$')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = root / 'fixtures'; fixtures.mkdir()
            uploads = root / 'uploads'; uploads.mkdir()
            binary = root / 'bin'; binary.mkdir()
            calls = root / 'calls'
            for platform in PLATFORMS:
                if platform == missing:
                    continue
                data = ('synthetic ' + platform).encode()
                name = platform + '.tar.gz'
                (fixtures / name).write_bytes(data + (b'corrupt' if platform == corrupt else b''))
                (fixtures / (platform + '.json')).write_text(json.dumps({
                    'platform': platform, 'sourceSha': 'b' * 40 if platform == wrong_source else SOURCE,
                    'version': 'fixture-version', 'publishedAt': '2026-01-01T00:00:00Z',
                    'url': 'https://example.test/' + name,
                    'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}))
            (fixtures / 'install.sh').write_text('#!/bin/sh\n# synthetic fixture\n')
            for name in ('apk', 'sed'):
                (binary / name).write_text('#!/bin/sh\nexit 0\n')
                (binary / name).chmod(0o755)
            curl = binary / 'curl'
            curl.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
a=sys.argv[1:]; url=next(x for x in a if x.startswith('http://') or x.startswith('https://')); method=a[a.index('-X')+1] if '-X' in a else 'GET'
with open(os.environ['CALLS'], 'a') as f: f.write(json.dumps([method,url])+'\\n')
name=url.rsplit('/',1)[-1]
if method=='GET':
 p=pathlib.Path(os.environ['FIXTURES'])/name
 if not p.is_file(): sys.exit(22)
 shutil.copyfile(p,a[a.index('-o')+1])
elif method=='PUT':
 p=pathlib.Path(os.environ['UPLOADS'])/('latest-' if '/latest/' in url else 'stage-')
 shutil.copyfile(a[a.index('-T')+1],str(p)+name)
elif method!='DELETE': sys.exit(23)
''')
            curl.chmod(0o755)
            result = subprocess.run(['bash', '-c', script], capture_output=True, text=True,
                                    env={**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH'],
                                         'FORGEJO_TOKEN': 'synthetic-package-fixture',
                                         'CI_SOURCE_SHA': SOURCE, 'RELEASE_ID': 'fixture-run',
                                         'STABLE_RELEASE_HOLD': hold, 'CALLS': str(calls),
                                         'FIXTURES': str(fixtures), 'UPLOADS': str(uploads)})
            observed = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            artifacts = {p.name: p.read_bytes() for p in uploads.iterdir()}
            return result, observed, artifacts

    def test_held_real_finalizer_qualifies_four_artifacts_without_latest_writes(self):
        result, calls, artifacts = self.finalize('true')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any('/latest/' in url for _, url in calls), calls)
        receipt = json.loads(artifacts['stage-release.json'])
        self.assertEqual(receipt['sourceSha'], SOURCE)
        self.assertEqual(set(receipt['platforms']), set(PLATFORMS))
        self.assertIn('QUALIFIED_CANDIDATE', result.stdout)

    def test_unheld_real_finalizer_preserves_coherent_stable_promotion(self):
        result, calls, artifacts = self.finalize('false')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(artifacts['latest-release.json'], artifacts['stage-release.json'])
        writes = [(method, url) for method, url in calls if method in ('PUT', 'DELETE')]
        self.assertTrue(writes[-1][1].endswith('/latest/release.json'))
        for platform in PLATFORMS:
            self.assertIn('latest-' + platform + '.json', artifacts)

    def test_any_missing_foreign_or_corrupt_platform_refuses_all_receipt_and_stable_writes(self):
        for platform in PLATFORMS:
            for field in ('missing', 'wrong_source', 'corrupt'):
                with self.subTest(platform=platform, field=field):
                    result, calls, artifacts = self.finalize('true', **{field: platform})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(artifacts, {})
                    self.assertFalse(any(method in ('PUT', 'DELETE') for method, _ in calls))

    def test_finalizer_invalid_hold_refuses_before_any_package_access(self):
        result, calls, artifacts = self.finalize('invalid')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])
        self.assertEqual(artifacts, {})

    def test_workflow_binds_hold_to_both_stable_writers_and_preserves_checkout_source_pin(self):
        text = WORKFLOW.read_text()
        self.assertLess(text.index('name: Validate stable release policy'),
                        text.index('name: Install kubectl'))
        self.assertIn('STABLE_RELEASE_HOLD: ${{ vars.SCLI_STABLE_RELEASE_HOLD }}', text)
        self.assertIn('STABLE_RELEASE_HOLD: ${{ steps.release-policy.outputs.held }}', text)
        self.assertRegex(text, r'name: Trigger publisher \+ indexer \(singleton\)\n\s+if: success\(\) && steps.release-policy.outputs.held == \'false\'')
        self.assertIn('test "\\$(git rev-parse HEAD)" = "\\${CI_SOURCE_SHA}"', text)
        self.assertIn('EXPECTED_SOURCE_SHA: ${{ github.event.inputs.expected_source_sha }}', text)


if __name__ == '__main__':
    unittest.main()
