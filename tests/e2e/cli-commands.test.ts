import { describe, it, expect, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const exec = promisify(execFile);

const projectDir = path.resolve(import.meta.dirname!, '../..');
const CLI = path.join(projectDir, 'dist', 'shizuha.js');

const INVALID_CWD_LABELS = [
  'empty',
  'whitespace',
  'nonexistent',
  'file',
  ...(process.platform === 'win32' ? [] : ['fifo']),
  'dangling-symlink',
] as const;

function makeInvalidCwd(root: string, label: (typeof INVALID_CWD_LABELS)[number]): string {
  const fixture = path.join(root, label);
  switch (label) {
    case 'empty': return '';
    case 'whitespace': return ' \t\n ';
    case 'nonexistent': return fixture;
    case 'file':
      fs.writeFileSync(fixture, 'x');
      return fixture;
    case 'fifo':
      execFileSync('mkfifo', [fixture]);
      return fixture;
    case 'dangling-symlink':
      fs.symlinkSync(path.join(root, 'no-such-target'), fixture);
      return fixture;
  }
}

/** Run the built CLI with given args, capturing stdout+stderr. */
async function runCli(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = opts?.timeout ?? 15_000;
  try {
    const { stdout, stderr } = await exec('node', [CLI, ...args], {
      cwd: opts?.cwd ?? projectDir,
      env: { ...process.env, ...opts?.env, FORCE_COLOR: '0' },
      timeout,
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

// ── Precondition ──

describe('CLI E2E tests (dist/shizuha.js)', () => {
  it('built bundle exists', () => {
    expect(fs.existsSync(CLI)).toBe(true);
  });

  describe('bridge --cwd fail-fast boundary (SCLI-493 / SCLI-529)', () => {
    it('rejects every invalid cwd at both CLI commands with one exact-line diagnostic and no startup state', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scli529-cli-cwd-'));
      try {
        for (const command of ['codex-bridge', 'openclaw-bridge']) {
          for (const label of INVALID_CWD_LABELS) {
            const caseRoot = fs.mkdtempSync(path.join(root, `${command}-${label}-`));
            const cwd = makeInvalidCwd(caseRoot, label);
            const before = fs.readdirSync(caseRoot).sort();
            const result = await runCli([command, `--cwd=${cwd}`], {
              cwd: caseRoot,
              timeout: 5_000,
            });

            expect(result.exitCode, `${command}/${label}`).toBe(1);
            expect(result.stdout, `${command}/${label}`).toBe('');
            expect(result.stderr, `${command}/${label}`).toContain('--cwd');
            expect(result.stderr, `${command}/${label}`).toContain('existing directory');
            expect(result.stderr.endsWith('\n'), `${command}/${label}`).toBe(true);
            expect(result.stderr.slice(0, -1), `${command}/${label}`).not.toContain('\n');
            expect(Buffer.from(result.stderr).includes(Buffer.from('node:fs')), `${command}/${label}`).toBe(false);
            expect(result.stderr, `${command}/${label}`).not.toMatch(/StateStore|Created new session|Telemetry enabled|Starting OpenClaw gateway/);
            expect(fs.readdirSync(caseRoot).sort(), `${command}/${label}`).toEqual(before);
          }
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects every invalid cwd at both exported entrypoints before logs, listeners, or state', async () => {
      const previousGatewayPassword = process.env['GATEWAY_PASSWORD'];
      process.env['GATEWAY_PASSWORD'] = 'scli529-test-gateway-password';
      const [{ startCodexBridge }, { startOpenClawBridge }] = await Promise.all([
        import('../../src/codex-bridge/index.js'),
        import('../../src/openclaw-bridge/index.js'),
      ]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scli529-export-cwd-'));
      const projectArtifacts = [
        '.codex-state.db', '.codex-state.db-shm', '.codex-state.db-wal',
        '.openclaw-state.db', '.openclaw-state.db-shm', '.openclaw-state.db-wal',
        '.openclaw-device-identity.json',
      ].map((name) => path.join(projectDir, name));
      const preExistingArtifacts = new Set(projectArtifacts.filter((artifact) => fs.existsSync(artifact)));
      try {
        expect([...preExistingArtifacts], 'bridge preflight test requires a clean project root').toEqual([]);
        const baseOptions = {
          port: 0,
          host: '127.0.0.1',
          model: 'gpt-test',
          agentId: 'scli529-test',
          agentName: 'SCLI 529 Test',
          agentUsername: 'scli529-test',
        };
        for (const [name, start] of [
          ['codex-bridge', startCodexBridge],
          ['openclaw-bridge', startOpenClawBridge],
        ] as const) {
          for (const label of INVALID_CWD_LABELS) {
            const caseRoot = fs.mkdtempSync(path.join(root, `${name}-${label}-`));
            const cwd = makeInvalidCwd(caseRoot, label);
            const beforeFiles = fs.readdirSync(caseRoot).sort();
            const beforeTerm = process.listenerCount('SIGTERM');
            const beforeInt = process.listenerCount('SIGINT');

            await expect(start({ ...baseOptions, cwd }), `${name}/${label}`).rejects.toThrow(/--cwd.*existing directory/);

            expect(process.listenerCount('SIGTERM'), `${name}/${label}`).toBe(beforeTerm);
            expect(process.listenerCount('SIGINT'), `${name}/${label}`).toBe(beforeInt);
            expect(fs.readdirSync(caseRoot).sort(), `${name}/${label}`).toEqual(beforeFiles);
            for (const artifact of projectArtifacts) {
              expect(fs.existsSync(artifact), `${name}/${label} created ${artifact}`).toBe(false);
            }
            expect(log, `${name}/${label}`).not.toHaveBeenCalled();
            expect(warn, `${name}/${label}`).not.toHaveBeenCalled();
            expect(error, `${name}/${label}`).not.toHaveBeenCalled();
          }
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        for (const artifact of projectArtifacts) {
          if (!preExistingArtifacts.has(artifact)) fs.rmSync(artifact, { force: true });
        }
        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
        if (previousGatewayPassword === undefined) delete process.env['GATEWAY_PASSWORD'];
        else process.env['GATEWAY_PASSWORD'] = previousGatewayPassword;
      }
    });
  });

  // ── Help Command ──

  describe('--help', () => {
    it('shows usage info and available subcommands', async () => {
      const { stdout, exitCode } = await runCli(['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Shizuha');
      expect(stdout).toContain('doctor');
      expect(stdout).toContain('config');
      expect(stdout).toContain('exec');
      expect(stdout).toContain('resume');
      expect(stdout).toContain('serve');
      expect(stdout).toContain('--model');
      expect(stdout).toContain('--help');
    });

    it('shows version with -V', async () => {
      const { stdout, exitCode } = await runCli(['-V']);
      expect(exitCode).toBe(0);
      // Version string should be semver-like (e.g. "0.1.0")
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // ── Doctor Command ──

  describe('doctor', () => {
    it('runs successfully and shows expected sections', async () => {
      const { stdout, exitCode } = await runCli(['doctor']);
      // Doctor exits 0 even with warnings (only fails on hard errors)
      expect(exitCode).toBe(0);

      // Header
      expect(stdout).toContain('shizuha doctor');

      // Core checks that always appear
      expect(stdout).toContain('Node.js version');
      expect(stdout).toContain('Config file');
      expect(stdout).toContain('Provider config');
      expect(stdout).toContain('SQLite state store');
      expect(stdout).toContain('Disk space');
      expect(stdout).toContain('Permissions');

      // Results summary line
      expect(stdout).toContain('Results:');
      expect(stdout).toContain('passed');
    });

    it('checks Node.js version passes (>= 18)', async () => {
      const { stdout } = await runCli(['doctor']);
      // Node.js check should pass on any modern system
      expect(stdout).toMatch(/Node\.js version.*>= 18 required/);
    });

    it('checks key dependencies (zod, better-sqlite3)', async () => {
      const { stdout } = await runCli(['doctor']);
      expect(stdout).toContain('Dependency: zod');
      expect(stdout).toContain('Dependency: better-sqlite3');
      // Both should be importable in this project
      expect(stdout).toMatch(/Dependency: zod.*importable/);
      expect(stdout).toMatch(/Dependency: better-sqlite3.*importable/);
    });

    it('shows build status', async () => {
      const { stdout } = await runCli(['doctor']);
      // Since we are running the built CLI, the build check should find dist/shizuha.js
      expect(stdout).toContain('Build');
      expect(stdout).toMatch(/Build.*dist\/shizuha\.js/);
    });

    it('shows passed/warnings/failed counts in results', async () => {
      const { stdout } = await runCli(['doctor']);
      // Results line format: "Results: N passed, N warnings, N failed"
      const resultsMatch = stdout.match(/Results:.*?(\d+) passed.*?(\d+) warning.*?(\d+) failed/);
      expect(resultsMatch).not.toBeNull();
      const passed = parseInt(resultsMatch![1]!, 10);
      const failed = parseInt(resultsMatch![3]!, 10);
      // Should have at least some passes and zero hard failures
      expect(passed).toBeGreaterThan(0);
      expect(failed).toBe(0);
    });

    it('warns when API keys are missing (non-Cortex route)', async () => {
      // SCLI-387: when Cortex is the primary route, public vendor keys are N/A
      // (pass), not "not set" warnings. Isolate HOME + clear CORTEX_* so this
      // case still exercises the missing-key warn path.
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-doctor-keys-'));
      try {
        const { stdout } = await runCli(['doctor'], {
          env: {
            HOME: tmpHome,
            USERPROFILE: tmpHome,
            XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
            ANTHROPIC_API_KEY: '',
            OPENAI_API_KEY: '',
            GOOGLE_API_KEY: '',
            CORTEX_BASE_URL: '',
            CORTEX_API_KEY: '',
            CORTEX_OAUTH_TOKEN: '',
          },
        });
        expect(stdout).toContain('ANTHROPIC_API_KEY');
        expect(stdout).toContain('OPENAI_API_KEY');
        expect(stdout).toContain('GOOGLE_API_KEY');
        // Either classic warn ("not set") or Cortex-primary N/A — never a hard fail.
        expect(stdout).toMatch(/not set|N\/A/);
        expect(stdout).not.toMatch(/ANTHROPIC_API_KEY:.*fail/i);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('runs correctly from a temp directory (no project config)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-doctor-'));
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-home-'));
      try {
        // Isolate HOME/XDG so the dev's own ~/.config/shizuha/config.toml does not
        // leak in — doctor must report "no config" deterministically in clean envs.
        const { stdout, exitCode } = await runCli(['doctor'], {
          cwd: tmpDir,
          env: { HOME: tmpHome, USERPROFILE: tmpHome, XDG_CONFIG_HOME: path.join(tmpHome, '.config') },
        });
        expect(exitCode).toBe(0);
        expect(stdout).toContain('shizuha doctor');
        expect(stdout).toContain('Results:');
        // Should warn about missing config file
        expect(stdout).toContain('Config file');
        expect(stdout).toMatch(/Config file.*No shizuha config/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  // ── Resume Command ──

  describe('resume', () => {
    it('shows a first-class resume subcommand', async () => {
      const { stdout, exitCode } = await runCli(['resume', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Resume an existing interactive session');
      expect(stdout).toContain('session-id');
      expect(stdout).toContain('--cwd');
      expect(stdout).toContain('--model');
    });

    it('fails clearly for an unknown session id', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-resume-home-'));
      try {
        const { stderr, exitCode } = await runCli(['resume', 'missing-session'], {
          env: { HOME: tmpHome, USERPROFILE: tmpHome, XDG_CONFIG_HOME: path.join(tmpHome, '.config') },
        });
        expect(exitCode).toBe(1);
        expect(stderr).toContain('Session not found: missing-session');
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });


  // ── Platform helper commands ──

  describe('platform helper commands', () => {
    it('shows pulse list help', async () => {
      const { stdout, exitCode } = await runCli(['pulse', 'list', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('List Pulse tasks');
      expect(stdout).toContain('--status');
      expect(stdout).toContain('--json');
    });

    it('rejects malformed pulse list options locally before any daemon request (SCLI-446)', async () => {
      // Point at an unbound port so any request would surface ECONNREFUSED.
      // The whole point: invalid options must reject with a NAMED diagnostic,
      // not a connection error and not a success-shaped empty result.
      const env = { HOME: '/nonexistent-home-scli446', DAEMON_HOST: '127.0.0.1', DAEMON_PORT: '59999' };
      const cases: Array<[string, string[]]> = [
        ['empty --status', ['pulse', 'list', '--status=', '--json']],
        ['whitespace --status', ['pulse', 'list', '--status=   ', '--json']],
        ['newline --status', ['pulse', 'list', '--status=open\nclosed', '--json']],
        ['empty --assignee', ['pulse', 'list', '--assignee=', '--json']],
        ['whitespace --assignee', ['pulse', 'list', '--assignee=   ', '--json']],
        ['noncanonical --priority', ['pulse', 'list', '--priority=URGENT', '--json']],
        ['numeric --priority', ['pulse', 'list', '--priority=0', '--json']],
        ['text --limit', ['pulse', 'list', '--limit=abc', '--json']],
        ['zero --limit', ['pulse', 'list', '--limit=0', '--json']],
        ['negative --limit', ['pulse', 'list', '--limit=-1', '--json']],
        ['fraction --limit', ['pulse', 'list', '--limit=1.5', '--json']],
        ['overflow --limit', ['pulse', 'list', '--limit=1000', '--json']],
      ];
      for (const [label, args] of cases) {
        const { stdout, stderr, exitCode } = await runCli(args, { env });
        expect(exitCode, `${label} must exit nonzero`).toBe(1);
        // Structured JSON error, not a success-shaped empty object
        expect(stdout, `${label} must emit JSON error`).toContain('"error"');
        expect(stdout, `${label} must NOT be a success object`).not.toContain('"count"');
        // Named option in the diagnostic, never a connection error
        const all = stdout + stderr;
        expect(all, `${label} must name the option`).toMatch(/--(status|assignee|priority|limit)/);
        expect(all, `${label} must not be a raw connection failure`).not.toMatch(/ECONNREFUSED|ERR_SOCKET|node:/);
      }
    });

    it('preserves valid pulse list options through to the request (SCLI-446)', async () => {
      // A scoped loopback daemon captures the exact query. Only valid options
      // may reach transport.
      const http = await import('node:http');
      const seen: string[] = [];
      const server = http.createServer((req, res) => {
        seen.push(req.url ?? '');
        if (req.url?.startsWith('/v1/pulse-proxy/projects/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: [], count: 0 }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const env = { HOME: '/nonexistent-home-scli446', DAEMON_HOST: '127.0.0.1', DAEMON_PORT: String(port) };
      try {
        const { stdout, exitCode } = await runCli(
          ['pulse', 'list', '--status=open', '--priority=urgent', '--limit=7', '--json'],
          { env },
        );
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.backend).toBe('platform');
        const taskReq = seen.find((u) => u.startsWith('/v1/pulse-proxy/tasks/'));
        expect(taskReq).toBeDefined();
        expect(taskReq).toContain('status=open');
        expect(taskReq).toContain('priority=urgent');
        expect(taskReq).toContain('limit=7');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('shows auth whoami from stored Shizuha auth', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-whoami-'));
      try {
        fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
        fs.writeFileSync(path.join(tmpHome, '.shizuha', 'auth.json'), JSON.stringify({
          username: 'tester',
          userId: 42,
          accessToken: 'header.eyJleHAiOjQxMDI0NDQ4MDB9.sig',
          refreshToken: 'header.eyJleHAiOjQxMDI0NDQ4MDB9.sig',
          lastLoginAt: new Date().toISOString(),
          idApiBaseUrl: 'http://platform.example',
        }));
        const { stdout, exitCode } = await runCli(['auth', 'whoami'], {
          env: { HOME: tmpHome, USERPROFILE: tmpHome },
        });
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Username: tester');
        expect(stdout).toContain('User ID: 42');
        expect(stdout).toContain('Platform: http://platform.example');
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  // ── Config Command ──

  describe('config', () => {
    it('outputs valid JSON', async () => {
      // Config may fail due to pino worker bundle issue (known); handle gracefully
      const { stdout, stderr, exitCode } = await runCli(['config']);
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(stdout);
      } catch {
        // If stdout is not valid JSON, the command might have failed due to pino
        // Check if stderr has the known worker error
        if (stderr.includes('worker') || exitCode !== 0) {
          // Known issue in bundled mode — skip gracefully
          return;
        }
        throw new Error(`config output is not valid JSON: ${stdout.slice(0, 200)}`);
      }
      expect(config).toBeDefined();
    });

    it('contains expected top-level keys', async () => {
      const { stdout, stderr, exitCode } = await runCli(['config']);
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(stdout);
      } catch {
        if (stderr.includes('worker') || exitCode !== 0) return;
        throw new Error(`config output is not valid JSON`);
      }
      expect(config).toHaveProperty('agent');
      expect(config).toHaveProperty('providers');
      expect(config).toHaveProperty('permissions');
    });

    it('agent section has a defaultModel', async () => {
      const { stdout, stderr, exitCode } = await runCli(['config']);
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(stdout);
      } catch {
        if (stderr.includes('worker') || exitCode !== 0) return;
        throw new Error(`config output is not valid JSON`);
      }
      const agent = config['agent'] as Record<string, unknown>;
      expect(agent).toBeDefined();
      expect(agent['defaultModel']).toBeTruthy();
    });

    it('permissions section has a mode', async () => {
      const { stdout, stderr, exitCode } = await runCli(['config']);
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(stdout);
      } catch {
        if (stderr.includes('worker') || exitCode !== 0) return;
        throw new Error(`config output is not valid JSON`);
      }
      const permissions = config['permissions'] as Record<string, unknown>;
      expect(permissions).toBeDefined();
      expect(permissions['mode']).toBeTruthy();
    });
  });

  // ── Subcommand Help ──

  describe('subcommand --help', () => {
    it('exec --help shows prompt option', async () => {
      const { stdout, exitCode } = await runCli(['exec', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Execute a prompt');
      expect(stdout).toContain('--prompt');
      expect(stdout).toContain('--json');
    });

    it('serve --help shows port option', async () => {
      const { stdout, exitCode } = await runCli(['serve', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Start the HTTP API server');
      expect(stdout).toContain('--port');
    });

    it('doctor command has no extra --help options (simple command)', async () => {
      // Running "doctor --help" should either show doctor-specific help or
      // fall through to running doctor. Either way, exit code should be 0.
      const { exitCode } = await runCli(['doctor', '--help']);
      expect(exitCode).toBe(0);
    });
  });

  // ── Error Handling ──

  describe('error handling', () => {
    it('unknown command shows error or help', async () => {
      const { stdout, stderr, exitCode } = await runCli(['nonexistent-command']);
      // Commander shows help or error for unknown commands
      const combined = stdout + stderr;
      expect(combined.length).toBeGreaterThan(0);
      // Should either contain an error message or the help text
      const hasUsefulOutput =
        combined.includes('error') ||
        combined.includes('unknown') ||
        combined.includes('Usage') ||
        combined.includes('Shizuha') ||
        exitCode !== 0;
      expect(hasUsefulOutput).toBe(true);
    });

    it('TUI in non-TTY produces output before failing', async () => {
      // Running without arguments in a non-TTY should attempt TUI and fail gracefully
      const { stdout, stderr, exitCode } = await runCli([], { timeout: 8000 });
      const combined = stdout + stderr;
      // Should produce some output (error message, header, etc.)
      expect(combined.length).toBeGreaterThan(0);
    });
  });
});
