/**
 * SCLI-547 e2e — antigravity-bridge --context-prompt fail-closed boundary.
 *
 * The installed SCLI accepted blank/control/overlong --context-prompt values,
 * crossed semantic preflight, and wrote them into workspace instruction files
 * (AGENTS.md / ANTIGRAVITY.md) after heavy startup side effects (fleet-skill
 * links, MCP config, child process, runtime init). This file proves the fix at
 * the real `dist/shizuha.js` process boundary:
 *  - explicit-empty / blank / control-bearing / over-limit --context-prompt
 *    values reject nonzero BEFORE any filesystem/instruction-file write;
 *  - the rejection creates no workspace instruction files and no state;
 *  - a valid printable prompt is accepted (reaches the bridge bootstrap, which
 *    fails on the unresolvable antigravity CLI rather than on the prompt).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createConnection, createServer, type Socket } from 'node:net';

const exec = promisify(execFile);
const projectDir = path.resolve(import.meta.dirname!, '../..');
const CLI = path.join(projectDir, 'dist', 'shizuha.js');

function createOccupiedListener() {
  return createServer((socket) => socket.destroy());
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], home: string, cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec('node', [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        TMPDIR: home,
        FORCE_COLOR: '0',
        SHIZUHA_AUTO_UPDATE: '0',
        SHIZUHA_LOG_LEVEL: 'info',
      },
      timeout: 20_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function bridgeArgs(port: number, cwd: string, contextPrompt: string): string[] {
  return [
    'antigravity-bridge',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--cwd', cwd,
    '--context-prompt', contextPrompt,
  ];
}

/** Attached-empty form: `--context-prompt=` as a single token. */
function bridgeArgsAttachedEmpty(port: number, cwd: string): string[] {
  return [
    'antigravity-bridge',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--cwd', cwd,
    '--context-prompt=',
  ];
}

describe.skipIf(!fs.existsSync(CLI))('SCLI-547 antigravity-bridge --context-prompt fail-closed (process boundary)', () => {
  let emptyHome: string;

  beforeAll(() => {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-e2e-'));
  });

  const rejectMatrix = [
    ['separate empty', ''],
    ['single space', ' '],
    ['TAB', '\t'],
    ['embedded LF', 'line1\nline2'],
    ['ANSI escape', '\u001b[31mred\u001b[0m'],
    ['over-limit 4097', 'x'.repeat(4097)],
  ] as const;

  for (const [label, value] of rejectMatrix) {
    it(`${label} rejects nonzero with clean stderr and no instruction files`, async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-work-'));
      const r = await runCli(bridgeArgs(18000 + Math.floor(Math.random() * 1000), workDir, value), emptyHome, workDir);

      // Fail-closed: nonzero exit.
      expect(r.exitCode).not.toBe(0);

      // stdout is empty/protocol-clean.
      expect(r.stdout.trim()).toBe('');

      // stderr is concise and names --context-prompt; no ANSI, no bundle path.
      expect(r.stderr).toContain('--context-prompt');
      expect(r.stderr).not.toMatch(/\x1b\[/);
      expect(r.stderr).not.toContain('dist/shizuha.js');

      // No workspace instruction files were written.
      expect(fs.existsSync(path.join(workDir, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(workDir, 'ANTIGRAVITY.md'))).toBe(false);

      fs.rmSync(workDir, { recursive: true, force: true });
    });
  }

  it('attached-empty (--context-prompt=) rejects nonzero with clean stderr and no instruction files', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-work-'));
    const r = await runCli(bridgeArgsAttachedEmpty(18500 + Math.floor(Math.random() * 500), workDir), emptyHome, workDir);

    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('--context-prompt');
    expect(r.stderr).not.toMatch(/\x1b\[/);
    expect(fs.existsSync(path.join(workDir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'ANTIGRAVITY.md'))).toBe(false);

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('accepts a valid printable context prompt (fails on unresolvable CLI, not the prompt)', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-valid-'));
    const r = await runCli(bridgeArgs(19000 + Math.floor(Math.random() * 1000), workDir, 'You are a helpful assistant.'), emptyHome, workDir);
    // The composition is valid; the bridge bootstrap proceeds and fails on the
    // missing antigravity CLI — NOT on a --context-prompt applicability error.
    expect(r.stderr).not.toContain('Invalid --context-prompt');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('reads an exact multiline/large file before writing Antigravity instructions', { timeout: 60_000 }, async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-file-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-file-home-'));
    const promptFile = path.join(workDir, 'context prompt.txt');
    const prompt = 'Multiline 日本語 context\nwith literal $text and trailing newlines.\n'.repeat(100);
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    // Let the real bridge resolve a local binary, then fail at its occupied
    // listener after instruction-file creation and before queue/heartbeat work.
    const binDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'antigravity'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const occupied = createOccupiedListener();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const port = (occupied.address() as { port: number }).port;
    try {
      const r = await runCli([
        'antigravity-bridge', '--host', '127.0.0.1', '--port', String(port),
        '--cwd', workDir, '--context-prompt-file', promptFile,
      ], home, workDir);
      expect(r.stderr).not.toContain('unknown option');
      expect(r.stderr).not.toContain('Invalid --context-prompt');
      expect(r.stderr).toContain('EADDRINUSE');
      expect(fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8')).toBe(prompt);
      expect(fs.readFileSync(path.join(workDir, 'ANTIGRAVITY.md'), 'utf8')).toBe(prompt);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((err) => err ? reject(err) : resolve()));
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a non-regular prompt file before Antigravity startup', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli547-badfile-'));
    try {
      const r = await runCli([
        'antigravity-bridge', '--cwd', workDir, '--context-prompt-file', workDir,
      ], emptyHome, workDir);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('Invalid --context-prompt-file');
      expect(fs.existsSync(path.join(workDir, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(workDir, 'ANTIGRAVITY.md'))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('closes owned HTTP probes without releasing the occupied listener', async () => {
    const occupied = createOccupiedListener();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const port = (occupied.address() as { port: number }).port;
    const accepted = new Promise<Socket>((resolve) => occupied.once('connection', resolve));
    const probeErrors: NodeJS.ErrnoException[] = [];
    const probe = createConnection({ host: '127.0.0.1', port });
    probe.on('error', (error: NodeJS.ErrnoException) => probeErrors.push(error));
    probe.end('GET / HTTP/1.0\r\nHost: fixture-owned\r\n\r\n');
    const acceptedSocket = await accepted;
    const competitor = createServer();
    try {
      expect(acceptedSocket.destroyed).toBe(true);
      expect(occupied.listening).toBe(true);
      const collision = new Promise<NodeJS.ErrnoException>((resolve) => competitor.once('error', resolve));
      competitor.listen(port, '127.0.0.1');
      expect((await collision).code).toBe('EADDRINUSE');
    } finally {
      probe.destroy();
      acceptedSocket.destroy();
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
    expect(probeErrors.every((error) => error.code === 'ECONNRESET')).toBe(true);
    const rearmed = createOccupiedListener();
    await new Promise<void>((resolve) => rearmed.listen(port, '127.0.0.1', resolve));
    await new Promise<void>((resolve, reject) => rearmed.close((error) => error ? reject(error) : resolve()));
  });
});
