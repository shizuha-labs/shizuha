import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
let scratch: string;
let fixtureDist: string;
let testBin: string;

// Run the real shell entrypoint, then the real semantic preflight. Only the
// post-preflight runtime is replaced with a receipt writer (no model/listener).
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-prompt-'));
  fixtureDist = path.join(scratch, 'dist');
  testBin = path.join(scratch, 'bin');
  fs.mkdirSync(fixtureDist);
  fs.mkdirSync(testBin);
  // CI runs as root; do not let the entrypoint's unrelated package-cache
  // bootstrap write /etc while testing its agent-user launch contract.
  fs.writeFileSync(path.join(testBin, 'id'), '#!/bin/sh\nprintf 1000\n', { mode: 0o755 });
  const entry = path.join(scratch, 'receipt.ts');
  fs.writeFileSync(entry, `
    import * as fs from 'node:fs';
    import * as path from 'node:path';
    import { validateCommonAgentOptions } from ${JSON.stringify(path.join(root, 'src/cli/option-preflight.ts'))};
    const argv = process.argv.slice(2);
    const value = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
    try {
      const pf = validateCommonAgentOptions({ contextPrompt: value('--context-prompt'), contextPromptFile: value('--context-prompt-file') });
      const file = pf.contextPromptFile;
      console.log(JSON.stringify({ argv, file, content: file ? fs.readFileSync(file, 'utf8') : pf.contextPrompt,
        regular: file ? fs.statSync(file).isFile() : undefined,
        mode: file ? fs.statSync(file).mode & 0o777 : undefined,
        parentMode: file ? fs.statSync(path.dirname(file)).mode & 0o777 : undefined }));
    } catch (err) { console.error(err.message); process.exit(1); }
  `);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(fixtureDist, 'shizuha.js') });
});

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function launch(env: Record<string, string> = {}, args: string[] = []) {
  const temp = fs.mkdtempSync(path.join(scratch, 'launch space-'));
  const result = spawnSync('bash', [path.join(root, 'agent-runtime-entrypoint.sh'), ...args], {
    env: {
      PATH: `${testBin}:${process.env.PATH}`,
      TMPDIR: temp,
      SHIZUHA_DIST: fixtureDist,
      AGENT_ID: 'fixture-agent',
      AGENT_USERNAME: 'fixture',
      ...env,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const line = result.stdout.trim().split('\n').findLast((s) => s.startsWith('{'));
  return { result, receipt: line ? JSON.parse(line) : undefined, temp };
}

describe('agent runtime context document transport', () => {
  it.each([
    ['multiline', 'Role: 日本語\n\nKeep "quotes", $variables, $(commands), backticks `literal`, and trailing lines.\n\n'],
    ['large', 'a long context line\n'.repeat(1024)],
  ])('preserves exact %s bytes in a private regular file, never argv', (_label, prompt) => {
    const { result, receipt, temp } = launch({ CONTEXT_PROMPT: prompt });
    expect(result.status, result.stderr).toBe(0);
    expect(receipt.content).toBe(prompt);
    expect(receipt.regular).toBe(true);
    expect(receipt.mode).toBe(0o600);
    expect(receipt.parentMode).toBe(0o700);
    expect(receipt.file.startsWith(`${temp}${path.sep}`)).toBe(true);
    expect(receipt.argv).toContain('--context-prompt-file');
    expect(receipt.argv).not.toContain('--context-prompt');
    expect(receipt.argv).not.toContain(prompt);
    expect(receipt.argv[0]).toBe('gateway');
  });

  it.each([
    ['shizuha', 'gateway'], ['codex', 'codex-bridge'], ['claude', 'claude-bridge'],
    ['openclaw_bridge', 'openclaw-bridge'], ['antigravity_server', 'antigravity-bridge'],
  ])('keeps %s bridge selection and runtime options', (method, command) => {
    const { result, receipt } = launch({ SHIZUHA_K8S_PRIMARY_METHOD: method, MODEL: 'fixture-model', REASONING_EFFORT: 'high', PORT: '8123', CONTEXT_PROMPT: 'first\nsecond' });
    expect(result.status, result.stderr).toBe(0);
    expect(receipt.argv.slice(0, 11)).toEqual([command, '--agent-id', 'fixture-agent', '--agent-name', 'fixture', '--agent-username', 'fixture', '--port', '8123', '--model', 'fixture-model']);
    expect(receipt.argv.slice(11, 13)).toEqual(['--effort', 'high']);
    expect(receipt.content).toBe('first\nsecond');
  });

  it('does not create a context file for absent/empty environment context', () => {
    for (const env of [{}, { CONTEXT_PROMPT: '' }]) {
      const { result, receipt, temp } = launch(env);
      expect(result.status).toBe(0);
      expect(receipt.file).toBeUndefined();
      expect(fs.readdirSync(temp)).toEqual([]);
    }
  });

  it('fails before runtime launch if private-file creation fails', () => {
    const { result, receipt } = launch({ CONTEXT_PROMPT: 'first\nsecond', TMPDIR: path.join(scratch, 'absent') });
    expect(result.status).not.toBe(0);
    expect(receipt).toBeUndefined();
    expect(result.stderr).not.toContain('first');
  });

  it('leaves explicit arguments verbatim and ignores environment context', () => {
    const args = ['gateway', '--agent-name', 'name with spaces', '--context-prompt', 'valid inline'];
    const { result, receipt, temp } = launch({ CONTEXT_PROMPT: 'environment\ncontext' }, args);
    expect(result.status, result.stderr).toBe(0);
    expect(receipt.argv).toEqual(args);
    expect(receipt.content).toBe('valid inline');
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it.each(['', 'line1\nline2', '\u001b[31mred', 'x'.repeat(4097)])('preserves explicit invalid-inline preflight rejection (%#)', (prompt) => {
    const { result, receipt, temp } = launch({ CONTEXT_PROMPT: prompt }, ['gateway', '--context-prompt', prompt]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --context-prompt');
    expect(receipt).toBeUndefined();
    expect(fs.readdirSync(temp)).toEqual([]);
  });
});
