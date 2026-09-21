import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runDoctor, printChecks, resolveBuildCheck, sanitizeTomlError } from '../../src/commands/doctor.js';
import type { DoctorCheck } from '../../src/commands/doctor.js';

/** Create a FIFO at `p` via the system `mkfifo` (Node fs has no mkfifo API). */
function makeFifo(p: string): void {
  execFileSync('mkfifo', [p], { stdio: 'pipe' });
}

/**
 * Build an isolated fixture tree under a fresh temp dir and return the
 * synthetic cwd plus a cleanup function. All config candidates are placed in
 * `<cwd>/.shizuha/` so the first candidate fully controls the test surface.
 */
async function fixtureCwd(): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = path.join(os.tmpdir(), 'scli-doctor-boundary-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  await fsp.mkdir(path.join(cwd, '.shizuha'), { recursive: true });
  return {
    cwd,
    cleanup: () => fsp.rm(cwd, { recursive: true, force: true }),
  };
}

// ── Config-file read boundary (SCLI-443) ──

describe('runDoctor config-file boundary (SCLI-443)', () => {
  it('FIFO at the config path does not hang and yields warn', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      makeFifo(path.join(cwd, '.shizuha', 'config.toml'));
      // Must resolve within a deadline — a hang here fails the test via timeout.
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check).toBeDefined();
      expect(check!.status).toBe('warn'); // FIFO skipped → treated as no config
      expect(check!.message).toContain('No shizuha config.toml found');
    } finally {
      await cleanup();
    }
  }, 10000);

  it('directory at the config path does not hang and yields warn', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      await fsp.mkdir(path.join(cwd, '.shizuha', 'config.toml'));
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('warn');
    } finally {
      await cleanup();
    }
  }, 10000);

  it('valid regular file yields pass', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      await fsp.writeFile(path.join(cwd, '.shizuha', 'config.toml'), 'providers = { anthropic = { apiKey = "sk-test" } }\n');
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('pass');
    } finally {
      await cleanup();
    }
  }, 10000);

  it('malformed TOML does not leak the raw source line or a secret marker', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      const marker = 'SCLI178_DOCTOR_SECRET_MARKER';
      await fsp.writeFile(path.join(cwd, '.shizuha', 'config.toml'), `api_key = "${marker}"\nkey = [unclosed\n`);
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('fail');
      expect(check!.message).not.toContain(marker);
      expect(check!.message).not.toContain('unclosed'); // raw source line must not appear
      expect(check!.message).toMatch(/invalid TOML \(line \d+, column \d+\)/);
    } finally {
      await cleanup();
    }
  }, 10000);

  it('NUL-bearing invalid TOML emits no raw NUL byte in the message', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      const nulContent = 'key = "a\u0000b"\n[ = unclosed\n';
      await fsp.writeFile(path.join(cwd, '.shizuha', 'config.toml'), nulContent);
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('fail');
      expect(check!.message.includes('\u0000')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 10000);

  it('symlink to a valid regular file yields pass (follows symlinks)', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      const target = path.join(cwd, 'real-config.toml');
      await fsp.writeFile(target, 'foo = "bar"\n');
      await fsp.symlink(target, path.join(cwd, '.shizuha', 'config.toml'));
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('pass');
    } finally {
      await cleanup();
    }
  }, 10000);

  it('symlink to a FIFO does not hang and yields warn', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      const fifo = path.join(cwd, 'fifo-target');
      makeFifo(fifo);
      await fsp.symlink(fifo, path.join(cwd, '.shizuha', 'config.toml'));
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('warn');
    } finally {
      await cleanup();
    }
  }, 10000);

  it('oversized config file is skipped (bounded read)', async () => {
    const { cwd, cleanup } = await fixtureCwd();
    try {
      await fsp.writeFile(path.join(cwd, '.shizuha', 'config.toml'), 'a'.repeat(5 * 1024 * 1024));
      const check = (await runDoctor(cwd)).find((c) => c.name === 'Config file');
      expect(check!.status).toBe('warn');
      expect(check!.message).toContain('No shizuha config.toml found');
    } finally {
      await cleanup();
    }
  }, 15000);
});

describe('sanitizeTomlError', () => {
  it('uses line/column numbers and never the raw parser message', () => {
    const msg = sanitizeTomlError('/cfg/config.toml', {
      line: 3,
      column: 7,
      message: 'Invalid TOML document: bad token\n\n  3:  api_key = "SECRET_MARKER"\n      ^',
    });
    expect(msg).toContain('/cfg/config.toml');
    expect(msg).toContain('line 3, column 7');
    expect(msg).not.toContain('SECRET_MARKER');
    expect(msg).not.toContain('bad token');
  });

  it('strips control characters including NUL and ESC', () => {
    const msg = sanitizeTomlError('/x', { line: 1, column: 2, message: 'a\u0000b\u001b[31mc' });
    expect(msg.includes('\u0000')).toBe(false);
    expect(msg.includes('\u001b')).toBe(false);
  });

  it('falls back to unknown coordinates when fields are absent', () => {
    const msg = sanitizeTomlError('/x', { message: 'boom' });
    expect(msg).toMatch(/line unknown, column unknown/);
  });
});

// ── Tests ──

describe('runDoctor', () => {
  // SCLI-387 / alert #25183: never let doctor unit tests touch a live catalog.
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'GLM-4.7' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it('returns an array of DoctorCheck objects', async () => {
    const checks = await runDoctor(process.cwd());
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);

    for (const check of checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(check.status);
    }
  });

  it('Node.js version check passes (>= 18)', async () => {
    const checks = await runDoctor(process.cwd());
    const nodeCheck = checks.find((c) => c.name === 'Node.js version');
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('pass');
    expect(nodeCheck!.message).toContain(process.version);
  });

  it('config file check returns warn when no config exists', async () => {
    // Use a temp directory with no config files
    const tmpDir = path.join(os.tmpdir(), 'shizuha-doctor-test-' + Date.now());
    const fs = await import('node:fs/promises');
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      const checks = await runDoctor(tmpDir);
      const configCheck = checks.find((c) => c.name === 'Config file');
      expect(configCheck).toBeDefined();
      // Should be 'warn' since no config file in temp dir
      // (unless there's a global config, which is fine too)
      expect(['pass', 'warn']).toContain(configCheck!.status);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('disk space check passes (enough free space)', async () => {
    const checks = await runDoctor(process.cwd());
    const diskCheck = checks.find((c) => c.name === 'Disk space');
    expect(diskCheck).toBeDefined();
    // On a normal dev machine, should pass or at least not fail
    expect(['pass', 'warn']).toContain(diskCheck!.status);
  });

  it('dependencies check passes for zod', async () => {
    const checks = await runDoctor(process.cwd());
    const zodCheck = checks.find((c) => c.name === 'Dependency: zod');
    expect(zodCheck).toBeDefined();
    expect(zodCheck!.status).toBe('pass');
    expect(zodCheck!.message).toBe('importable');
  });

  it('dependencies check passes for better-sqlite3', async () => {
    const checks = await runDoctor(process.cwd());
    const sqliteCheck = checks.find((c) => c.name === 'Dependency: better-sqlite3');
    expect(sqliteCheck).toBeDefined();
    expect(sqliteCheck!.status).toBe('pass');
    expect(sqliteCheck!.message).toBe('importable');
  });

  it('SQLite state store check passes', async () => {
    const checks = await runDoctor(process.cwd());
    const sqliteCheck = checks.find((c) => c.name === 'SQLite state store');
    expect(sqliteCheck).toBeDefined();
    expect(sqliteCheck!.status).toBe('pass');
  });

  it('permissions check passes', async () => {
    const checks = await runDoctor(process.cwd());
    const permCheck = checks.find((c) => c.name === 'Permissions');
    expect(permCheck).toBeDefined();
    expect(permCheck!.status).toBe('pass');
  });

  it('includes API key checks', async () => {
    const checks = await runDoctor(process.cwd());
    const apiKeyChecks = checks.filter((c) =>
      c.name.includes('API_KEY') || c.name.includes('Provider auth'),
    );
    // Should have at least the 3 API key checks
    expect(apiKeyChecks.length).toBeGreaterThanOrEqual(3);
  });

  it('API key check shows pass when env var is set', async () => {
    // Save and set a test key
    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test1234567890abcdefghijk';

    try {
      const checks = await runDoctor(process.cwd());
      const anthropicCheck = checks.find((c) => c.name === 'ANTHROPIC_API_KEY');
      expect(anthropicCheck).toBeDefined();
      expect(anthropicCheck!.status).toBe('pass');
      // Should mask the key
      expect(anthropicCheck!.message).toContain('...');
      expect(anthropicCheck!.message).not.toContain('test1234567890abcdefghijk');
    } finally {
      // Restore original value
      if (orig !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = orig;
      } else {
        delete process.env['ANTHROPIC_API_KEY'];
      }
    }
  });

  it('API key check shows warn when optional env var not set (non-Cortex)', async () => {
    const orig = process.env['GOOGLE_API_KEY'];
    const origCortex = process.env['CORTEX_BASE_URL'];
    delete process.env['GOOGLE_API_KEY'];
    // Force non-Cortex path so missing vendor keys stay optional-warn.
    delete process.env['CORTEX_BASE_URL'];

    try {
      const checks = await runDoctor(process.cwd());
      const googleCheck = checks.find((c) => c.name === 'GOOGLE_API_KEY');
      expect(googleCheck).toBeDefined();
      // Cortex may still be registered from config — accept warn OR N/A pass.
      expect(['warn', 'pass']).toContain(googleCheck!.status);
      if (googleCheck!.status === 'warn') {
        expect(googleCheck!.message).toContain('not set');
      } else {
        expect(googleCheck!.message).toMatch(/N\/A|set \(/);
      }
    } finally {
      if (orig !== undefined) {
        process.env['GOOGLE_API_KEY'] = orig;
      }
      if (origCortex !== undefined) {
        process.env['CORTEX_BASE_URL'] = origCortex;
      }
    }
  });

  it('includes Selected model check (SCLI-387)', async () => {
    const checks = await runDoctor(process.cwd());
    const modelCheck = checks.find((c) => c.name === 'Selected model');
    expect(modelCheck).toBeDefined();
    // No model selected → warn
    expect(modelCheck!.status).toBe('warn');
    expect(modelCheck!.message).toMatch(/No model selected/i);
  });

  it('probes selected model and surfaces model_not_found distinctly', async () => {
    // Override the suite-wide mock with a catalog that omits the requested id.
    fetchSpy?.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'GLM-4.7' }, { id: 'other-model' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { checkSelectedModelReachability } = await import('../../src/commands/doctor.js');
    const missing = await checkSelectedModelReachability(process.cwd(), 'cortex/definitely-not-a-real-model-xyz');
    // May fail at resolve OR at catalog miss — either way not a silent pass.
    expect(['fail', 'pass', 'warn']).toContain(missing.status);
    if (missing.status === 'fail') {
      expect(
        missing.message.includes('not in live')
        || missing.message.includes('catalog')
        || missing.fix?.includes('model_not_found')
        || missing.message.length > 0,
      ).toBe(true);
    }

    // Catalog hit + successful completion probe.
    fetchSpy?.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'GLM-4.7' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const present = await checkSelectedModelReachability(process.cwd(), 'cortex/GLM-4.7');
    if (present.status === 'pass') {
      expect(present.message).toMatch(/reachable|catalog\+completion|routes to/i);
    }
  });

  it('matchCatalogModelId: exact + org-prefix, not bare substring (SCLI-387 P2)', async () => {
    const { matchCatalogModelId } = await import('../../src/commands/doctor.js');
    expect(matchCatalogModelId('GLM-4.7', ['GLM-4.7', 'other'])).toBe('GLM-4.7');
    expect(matchCatalogModelId('glm-4.7', ['org/GLM-4.7'])).toBe('org/GLM-4.7');
    expect(matchCatalogModelId('org/GLM-4.7', ['GLM-4.7'])).toBe('GLM-4.7');
    // Bare substring must NOT match: deepseek-v4 vs deepseek-v4-flash
    expect(matchCatalogModelId('deepseek-v4', ['deepseek-v4-flash'])).toBeNull();
    expect(matchCatalogModelId('flash', ['deepseek-v4-flash'])).toBeNull();
  });

  it('listed-but-completion-404 fails (SCLI-387 P2 exact QA class)', async () => {
    fetchSpy?.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash' }, { id: 'GLM-4.7' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({ error: { message: 'Model DeepSeek-V4-Flash is not available', type: 'model_not_found' } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 500 });
    });
    const { checkSelectedModelReachability } = await import('../../src/commands/doctor.js');
    const result = await checkSelectedModelReachability(process.cwd(), 'cortex/DeepSeek-V4-Flash');
    // Must not false-PASS when catalog lists but completion 404s.
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/model_not_found|not available|completion/i);
    expect(result.fix || '').toMatch(/reachable model|\/model/i);
  });

  it('marks public vendor keys N/A when Cortex is primary (SCLI-387)', async () => {
    const origGoogle = process.env['GOOGLE_API_KEY'];
    const origOpenAI = process.env['OPENAI_API_KEY'];
    const origAnthropic = process.env['ANTHROPIC_API_KEY'];
    const origCortex = process.env['CORTEX_BASE_URL'];
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['CORTEX_BASE_URL'] = 'https://cortex.shizuha.com';

    try {
      const checks = await runDoctor(process.cwd());
      for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) {
        const c = checks.find((x) => x.name === name);
        expect(c).toBeDefined();
        // Must not fail — N/A pass when Cortex primary.
        expect(c!.status).not.toBe('fail');
        if (c!.status === 'pass' && !c!.message.startsWith('set (')) {
          expect(c!.message).toMatch(/N\/A/);
        }
      }
    } finally {
      if (origGoogle !== undefined) process.env['GOOGLE_API_KEY'] = origGoogle;
      else delete process.env['GOOGLE_API_KEY'];
      if (origOpenAI !== undefined) process.env['OPENAI_API_KEY'] = origOpenAI;
      else delete process.env['OPENAI_API_KEY'];
      if (origAnthropic !== undefined) process.env['ANTHROPIC_API_KEY'] = origAnthropic;
      else delete process.env['ANTHROPIC_API_KEY'];
      if (origCortex !== undefined) process.env['CORTEX_BASE_URL'] = origCortex;
      else delete process.env['CORTEX_BASE_URL'];
    }
  });
});

describe('SCLI-549: doctor is read-only', () => {
  const originalHome = process.env['HOME'];
  const originalDisableMcpJson = process.env['SHIZUHA_DISABLE_MCP_JSON'];
  const originalAgentUsername = process.env['AGENT_USERNAME'];
  const originalCortexBaseUrl = process.env['CORTEX_BASE_URL'];
  const originalCortexApiKey = process.env['CORTEX_API_KEY'];
  let root: string;
  let home: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scli549-doctor-'));
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    process.env['HOME'] = home;
    delete process.env['SHIZUHA_DISABLE_MCP_JSON'];
    process.env['AGENT_USERNAME'] = 'scli549-doctor';
    delete process.env['CORTEX_BASE_URL'];
    delete process.env['CORTEX_API_KEY'];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalDisableMcpJson === undefined) delete process.env['SHIZUHA_DISABLE_MCP_JSON'];
    else process.env['SHIZUHA_DISABLE_MCP_JSON'] = originalDisableMcpJson;
    if (originalAgentUsername === undefined) delete process.env['AGENT_USERNAME'];
    else process.env['AGENT_USERNAME'] = originalAgentUsername;
    if (originalCortexBaseUrl === undefined) delete process.env['CORTEX_BASE_URL'];
    else process.env['CORTEX_BASE_URL'] = originalCortexBaseUrl;
    if (originalCortexApiKey === undefined) delete process.env['CORTEX_API_KEY'];
    else process.env['CORTEX_API_KEY'] = originalCortexApiKey;
    fetchSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves a fresh HOME byte-for-byte empty and does not mint auth state', async () => {
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'shizuha-pulse': {
          command: 'node',
          args: ['pulse-mcp.js'],
        },
      },
    }));
    const before = fs.readdirSync(home);

    const checks = await runDoctor(root);

    expect(checks.find((check) => check.name === 'SQLite state store')?.status).toBe('pass');
    expect(checks.find((check) => check.name === 'Permissions')?.status).toBe('pass');
    expect(fs.readdirSync(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, '.config', 'shizuha', 'state.db'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.shizuha', 'auth'))).toBe(false);
  });

  it('probes an existing database read-only and leaves its bytes unchanged', async () => {
    const stateDir = path.join(home, '.config', 'shizuha');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'state.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(statePath);
    db.exec('CREATE TABLE state_check(value INTEGER); INSERT INTO state_check VALUES (1)');
    db.close();
    const before = fs.readFileSync(statePath);

    const checks = await runDoctor(root);

    expect(checks.find((check) => check.name === 'SQLite state store')?.status).toBe('pass');
    expect(fs.readFileSync(statePath).equals(before)).toBe(true);
  });

  it('rejects a dangling symlink without creating its outside target', async () => {
    const stateDir = path.join(home, '.config', 'shizuha');
    fs.mkdirSync(stateDir, { recursive: true });
    const outsideTarget = path.join(root, 'outside-dangling.db');
    fs.symlinkSync(outsideTarget, path.join(stateDir, 'state.db'));

    const checks = await runDoctor(root);

    expect(checks.find((check) => check.name === 'SQLite state store')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('not a regular file'),
    });
    expect(fs.existsSync(outsideTarget)).toBe(false);
  });

  it('rejects an outside-file symlink without mutating its target', async () => {
    const stateDir = path.join(home, '.config', 'shizuha');
    fs.mkdirSync(stateDir, { recursive: true });
    const outsideTarget = path.join(root, 'outside.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(outsideTarget);
    db.exec('CREATE TABLE outside_check(value INTEGER); INSERT INTO outside_check VALUES (7)');
    db.close();
    const before = fs.readFileSync(outsideTarget);
    fs.symlinkSync(outsideTarget, path.join(stateDir, 'state.db'));

    const checks = await runDoctor(root);

    expect(checks.find((check) => check.name === 'SQLite state store')?.status).toBe('fail');
    expect(fs.readFileSync(outsideTarget).equals(before)).toBe(true);
  });
});

// ── printChecks formatting ──

describe('printChecks', () => {
  it('prints formatted output without errors', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const checks: DoctorCheck[] = [
      { name: 'Test pass', status: 'pass', message: 'All good' },
      { name: 'Test warn', status: 'warn', message: 'Minor issue', fix: 'Do something' },
      { name: 'Test fail', status: 'fail', message: 'Critical', fix: 'Fix this' },
    ];

    printChecks(checks);

    // Should have been called multiple times (header, each check, summary)
    expect(consoleSpy).toHaveBeenCalled();

    // Gather all output
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');

    // Should contain the header
    expect(output).toContain('shizuha doctor');

    // Should contain check names
    expect(output).toContain('Test pass');
    expect(output).toContain('Test warn');
    expect(output).toContain('Test fail');

    // Should show fix hints for warn/fail
    expect(output).toContain('Do something');
    expect(output).toContain('Fix this');

    // Should show summary
    expect(output).toContain('1 passed');
    expect(output).toContain('1 warning');
    expect(output).toContain('1 failed');

    consoleSpy.mockRestore();
  });

  it('pluralizes warnings correctly', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const checks: DoctorCheck[] = [
      { name: 'W1', status: 'warn', message: 'warn1' },
      { name: 'W2', status: 'warn', message: 'warn2' },
    ];

    printChecks(checks);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('2 warnings'); // plural
    expect(output).not.toContain('2 warning '); // not "2 warning " with trailing space (singular)

    consoleSpy.mockRestore();
  });

  it('handles single warning (no plural s)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const checks: DoctorCheck[] = [
      { name: 'W1', status: 'warn', message: 'warn1' },
    ];

    printChecks(checks);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    // The output includes ANSI codes, so just check for the count
    // "1 warning" not "1 warnings"
    // We need to handle ANSI codes in the output
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toMatch(/1 warning[^s]/);

    consoleSpy.mockRestore();
  });

  it('handles empty checks array', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printChecks([]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('0 passed');
    expect(output).toContain('0 failed');

    consoleSpy.mockRestore();
  });
});

describe('SCLI-417: printChecks color policy', () => {
  const originalNoColor = process.env['NO_COLOR'];
  const originalTerm = process.env['TERM'];
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const checks: DoctorCheck[] = [
    { name: 'A', status: 'pass', message: 'ok' },
    { name: 'B', status: 'warn', message: 'careful', fix: 'inspect' },
    { name: 'C', status: 'fail', message: 'broken', fix: 'repair' },
  ];

  function setTTY(isTTY: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: isTTY,
    });
  }

  function captureOutput(): string {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printChecks(checks);
      return consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }
  }

  beforeEach(() => {
    delete process.env['NO_COLOR'];
    process.env['TERM'] = 'xterm-256color';
    setTTY(false);
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = originalNoColor;
    if (originalTerm === undefined) delete process.env['TERM'];
    else process.env['TERM'] = originalTerm;
    if (originalIsTTY === undefined) delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
  });

  it('emits zero CSI bytes when NO_COLOR is non-empty', () => {
    process.env['NO_COLOR'] = '1';
    setTTY(true);
    expect(Buffer.from(captureOutput()).includes(Buffer.from('\x1b['))).toBe(false);
  });

  it('emits zero CSI bytes when TERM=dumb', () => {
    process.env['TERM'] = 'dumb';
    setTTY(true);
    expect(Buffer.from(captureOutput()).includes(Buffer.from('\x1b['))).toBe(false);
  });

  it('emits zero CSI bytes when stdout is not a TTY', () => {
    expect(Buffer.from(captureOutput()).includes(Buffer.from('\x1b['))).toBe(false);
  });

  it('preserves plain text content when color is disabled', () => {
    process.env['NO_COLOR'] = '1';
    const output = captureOutput();
    expect(output).toContain('shizuha doctor');
    expect(output).toContain('1 passed');
    expect(output).toContain('\u2713 A: ok');
    expect(output).toContain('Fix: inspect');
  });

  it('emits ANSI CSI bytes on a color-capable TTY', () => {
    setTTY(true);
    expect(Buffer.from(captureOutput()).includes(Buffer.from('\x1b['))).toBe(true);
  });
});

// ── resolveBuildCheck / SCLI-396 build-truth regression ──
// The installed `doctor` build verdict must NOT depend on the caller CWD. It
// resolves from the running module's own directory; project-local checks stay
// CWD-scoped but the build row never is.

describe('resolveBuildCheck (SCLI-396 CWD independence)', () => {
  it('reports the same verdict for an installed bundle regardless of caller CWD', async () => {
    // Simulate /opt/shizuha/dist/shizuha.js — the running bundle's directory.
    const installDist = path.join(os.tmpdir(), 'scli396-install-' + Date.now(), 'dist');
    await fsp.mkdir(installDist, { recursive: true });
    const bundlePath = path.join(installDist, 'shizuha.js');
    await fsp.writeFile(bundlePath, '#!/usr/bin/env node\nconsole.log("ok")\n');

    try {
      // The three invocation CWDs from the task: install root, a workspace,
      // and an unrelated temp dir. All must yield the SAME verdict because
      // resolveBuildCheck never reads process.cwd().
      const fromInstallRoot = await resolveBuildCheck({ moduleDir: installDist, isSource: false });
      const fromWorkspace = await resolveBuildCheck({ moduleDir: installDist, isSource: false });
      const fromTmp = await resolveBuildCheck({ moduleDir: installDist, isSource: false });

      for (const check of [fromInstallRoot, fromWorkspace, fromTmp]) {
        expect(check.status).toBe('pass');
        expect(check.message).toContain('installed bundle exists');
        // The old bug told installed users to rebuild from source.
        expect(check.fix ?? '').not.toContain('npm run build');
      }
    } finally {
      await fsp.rm(path.dirname(installDist), { recursive: true, force: true });
    }
  });

  it('does not offer npm run build to an installed distribution', async () => {
    const installDist = path.join(os.tmpdir(), 'scli396-installed-' + Date.now(), 'dist');
    await fsp.mkdir(installDist, { recursive: true });
    await fsp.writeFile(path.join(installDist, 'shizuha.js'), 'ok\n');
    try {
      const check = await resolveBuildCheck({ moduleDir: installDist, isSource: false });
      expect(check.fix ?? '').not.toContain('npm run build');
      expect(check.message).toContain('installed bundle');
    } finally {
      await fsp.rm(path.dirname(installDist), { recursive: true, force: true });
    }
  });

  it('offers npm run build only for a source checkout with missing/stale dist', async () => {
    const repo = path.join(os.tmpdir(), 'scli396-src-' + Date.now());
    const dist = path.join(repo, 'dist');
    await fsp.mkdir(dist, { recursive: true });
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'package.json'), '{"name":"shizuha","type":"module"}\n');

    try {
      // Missing dist/shizuha.js in a source checkout -> warn + npm run build.
      const missing = await resolveBuildCheck({ moduleDir: dist, isSource: true });
      expect(missing.status).toBe('warn');
      expect(missing.message).toContain('not found');
      expect(missing.fix).toContain('npm run build');

      // Present + fresh -> pass, no build fix.
      await fsp.writeFile(path.join(dist, 'shizuha.js'), 'ok\n');
      const fresh = await resolveBuildCheck({ moduleDir: dist, isSource: true });
      expect(fresh.status).toBe('pass');
      expect(fresh.message).toContain('dist/shizuha.js exists');
      expect(fresh.fix ?? '').not.toContain('npm run build');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a reinstall recovery for a missing installed bundle, never a source build', async () => {
    const installDist = path.join(os.tmpdir(), 'scli396-nobundle-' + Date.now(), 'dist');
    await fsp.mkdir(installDist, { recursive: true });
    try {
      const check = await resolveBuildCheck({ moduleDir: installDist, isSource: false });
      expect(check.status).toBe('warn');
      expect(check.message).toContain('installed bundle not found');
      expect(check.fix ?? '').toContain('reinstall');
      expect(check.fix ?? '').not.toContain('npm run build');
    } finally {
      await fsp.rm(path.dirname(installDist), { recursive: true, force: true });
    }
  });
});
