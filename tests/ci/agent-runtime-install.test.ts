import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function harnessInstallCommand(): string {
  // Execute the Dockerfile's actual POSIX shell instruction. No image build,
  // package install, network request or /opt and /usr mutation is performed.
  const instructions = fs.readFileSync(path.join(root, 'Dockerfile.agent-runtime'), 'utf8')
    .replace(/\\\r?\n/g, '')
    .split('\n');
  const command = instructions.find((line) => line.startsWith('RUN ')
    && line.includes('npm install -g') && line.includes('.harness-build-versions.lock'));
  if (!command) throw new Error('actual harness install RUN instruction is missing');
  return command.slice(4);
}

function runInstall(failCommand: string, manifestVersion = '1.2.3') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-install-'));
  const receipt = path.join(scratch, 'commands');
  const stub = `#!/bin/sh
name="\${0##*/}"
printf '%s\\n' "$name" >> "$RECEIPT"
if [ "$name" = "$FAIL_COMMAND" ]; then
  echo "fixture $name failed" >&2
  exit 73
fi
if [ "$name" = python3 ]; then
  case "$*" in
    *url*) printf '%s\\n' 'https://fixture.invalid/agy' ;;
    *sha512*) printf '%s\\n' fixture-sha ;;
    *version*) printf '%s\\n' "$MANIFEST_VERSION" ;;
    *) exit 74 ;;
  esac
elif [ "$name" = find ]; then
  printf '%s\\n' /fixture/agy
fi
`;
  for (const name of ['grep', 'npm', 'claude', 'codex', 'openclaw', 'curl', 'python3', 'sha512sum', 'mkdir', 'tar', 'find', 'install', 'ln', 'rm']) {
    fs.writeFileSync(path.join(scratch, name), stub, { mode: 0o755 });
  }
  try {
    const result = spawnSync('/bin/sh', ['-c', harnessInstallCommand()], {
      env: {
        PATH: `${scratch}:${process.env.PATH}`,
        RECEIPT: receipt,
        FAIL_COMMAND: failCommand,
        MANIFEST_VERSION: manifestVersion,
        CLAUDE_CODE_VERSION: '2.1.263',
        CODEX_VERSION: '0.153.4',
        ANTIGRAVITY_VERSION: '1.2.3',
        OPENCLAW_VERSION: '2026.9.3',
        TARGETARCH: 'amd64',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });
    return { result, commands: fs.readFileSync(receipt, 'utf8').trim().split('\n') };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

describe('agent-runtime harness install failure attribution', () => {
  it.each([
    ['npm', 'curl'],
    ['curl', 'python3'],
    ['python3', 'install'],
  ])('stops at %s failure without blaming later Antigravity checks', (failed, neverReached) => {
    const { result, commands } = runInstall(failed);
    expect(result.status, result.stderr).toBe(73);
    expect(result.stderr).toContain(`fixture ${failed} failed`);
    expect(result.stderr).not.toContain('FATAL: antigravity');
    expect(commands.at(-1)).toBe(failed);
    expect(commands).not.toContain(neverReached);
  });

  it('still identifies an actual manifest version mismatch before install', () => {
    const { result, commands } = runInstall('never', '9.9.9');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: antigravity manifest version 9.9.9 != pin 1.2.3');
    expect(commands).not.toContain('install');
  });

  it('lets valid metadata reach binary install and preserves its own failure', () => {
    const { result, commands } = runInstall('install');
    expect(result.status, result.stderr).toBe(73);
    expect(commands.at(-1)).toBe('install');
    expect(result.stderr).toContain('fixture install failed');
    expect(result.stderr).not.toContain('manifest version');
    expect(result.stderr).not.toContain('gemini CLI');
    expect(commands).not.toContain('ln');
  });
});
