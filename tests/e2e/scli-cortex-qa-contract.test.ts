import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const harness = path.join(projectRoot, 'benchmark', 'scli-cortex-qa.sh');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function runFixture(scenario: 'green' | 'empty' | 'drift' | 'stable-remap') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'scli-354-'));
  temporaryRoots.push(root);
  const home = path.join(root, 'home');
  const fakeShizuha = path.join(root, 'shizuha');
  const fakeCurl = path.join(root, 'curl');
  const resultFile = path.join(root, 'results.ndjson');

  executable(fakeShizuha, `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "--version" ]; then echo 'shizuha fixture'; exit 0; fi
mkdir -p "$HOME/.shizuha"
case "\${1:-}" in
  login)
    printf '{"accessToken":"login-token"}' >"$HOME/.shizuha/auth.json"
    echo 'Logged in';;
  auth)
    [ "\${2:-}" = cortex ]
    printf '{"cortex":{"apiKey":"%s"}}' "\${3:-}" >"$HOME/.shizuha/credentials.json"
    echo 'saved';;
  exec)
    model=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --model ]; then model="$2"; shift 2; else shift; fi
    done
    case "$model" in *stable*) exit 91;; esac
    if [ -n "\${CORTEX_API_KEY:-}" ]; then :
    elif [ -f "$HOME/.shizuha/auth.json" ]; then :
    elif [ -f "$HOME/.shizuha/credentials.json" ]; then :
    else exit 92
    fi
    echo 4;;
  *) exit 93;;
esac
`);

  executable(fakeCurl, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let output = '', data = '', auth = '', url = '';
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o') output = args[++i];
  else if (arg === '-w') i++;
  else if (arg === '-d') data = args[++i];
  else if (arg === '-H') { const h = args[++i]; if (h.startsWith('Authorization:')) auth = h; }
  else if (!arg.startsWith('-')) url = arg;
}
let status = 200;
let body;
if (!/Bearer (login-token|qa-key)$/.test(auth)) {
  status = 401; body = { error: { code: 'unauthorized' } };
} else if (url.endsWith('/models')) {
  if (${JSON.stringify(scenario)} === 'empty') body = { data: [] };
  else if (${JSON.stringify(scenario)} === 'drift') body = { data: [{ id: 'Replacement-999', context_window: 777 }] };
  else body = { data: [{ id: 'Model-Z', context_window: 200 }, { id: 'Model-A', context_window: 100 }] };
} else if (url.endsWith('/chat/completions')) {
  const model = JSON.parse(data).model;
  if (model === 'stable' || model === 'cortex/stable') {
    if (${JSON.stringify(scenario)} === 'stable-remap') body = { model: 'Model-A', choices: [] };
    else { status = 404; body = { error: { type: 'model_not_found' } }; }
  } else body = { model, choices: [] };
} else {
  status = 404; body = { error: { code: 'not_found' } };
}
if (output) fs.writeFileSync(output, JSON.stringify(body));
process.stdout.write(String(status));
`);

  const run = spawnSync('bash', [harness], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      QA_SKIP_INSTALL: '1',
      QA_SHIZUHA_BIN: fakeShizuha,
      QA_CURL_BIN: fakeCurl,
      QA_ID_USER: 'scli-qa',
      QA_ID_PASS: 'fixture-password',
      QA_CORTEX_KEY: 'qa-key',
      QA_CORTEX_BASE_URL: 'https://cortex.invalid/v1',
      QA_RESULT_FILE: resultFile,
    },
  });
  const records = run.status === 0
    ? readFileSync(resultFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { ...run, output: `${run.stdout}${run.stderr}`, records };
}

describe.skipIf(!existsSync(harness))('SCLI-354 dynamic Cortex fresh-install QA contract', () => {
  it('discovers, deterministically selects, records, and exercises live inventory for all auth modes', () => {
    const run = runFixture('green');
    expect(run.status, run.output).toBe(0);
    expect(run.records).toHaveLength(6);
    for (const mode of ['login', 'stored-key', 'env-key']) {
      const selected = run.records.filter((record) => record.auth_mode === mode);
      expect(selected.map((record) => [record.coverage, record.selected_model])).toEqual([
        ['primary', 'Model-A'],
        ['additional', 'Model-Z'],
      ]);
      expect(selected[0].profile).toEqual({ id: 'Model-A', context_window: 100 });
    }
    expect(run.output).toContain('rejects cortex/stable with model_not_found');
  });

  it('fails loudly when authenticated inventory is empty', () => {
    const run = runFixture('empty');
    expect(run.status).toBe(1);
    expect(run.output).toContain('inventory is empty or malformed — entitlement/serving failure');
  });

  it('accepts concrete inventory drift without any hardcoded model dependency', () => {
    const run = runFixture('drift');
    expect(run.status, run.output).toBe(0);
    expect(run.records.map((record) => record.selected_model)).toEqual([
      'Replacement-999', 'Replacement-999', 'Replacement-999',
    ]);
  });

  it('fails if stable silently remaps instead of returning model_not_found', () => {
    const run = runFixture('stable-remap');
    expect(run.status).toBe(1);
    expect(run.output).toContain('contract breach: stable must return 404 model_not_found');
    expect(run.output).toContain('contract breach: cortex/stable must return 404 model_not_found');
  });
});
