import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import { loadConfig } from '../../src/config/loader.js';

/**
 * SCLI-440: `shizuha config` must not hang on a FIFO .mcp.json and must not
 * false-succeed on malformed/non-regular .mcp.json.
 */
describe('loadConfig .mcp.json safety (SCLI-440)', () => {
  let tmpCwd: string;
  const originalHome = process.env['HOME'];
  const originalDisable = process.env['SHIZUHA_DISABLE_MCP_JSON'];

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scli440-'));
    process.env['HOME'] = tmpCwd;
    // The CI full-suite runs with SHIZUHA_DISABLE_MCP_JSON=1; this suite
    // exercises the .mcp.json path, so force it enabled deterministically.
    delete process.env['SHIZUHA_DISABLE_MCP_JSON'];
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    if (originalDisable === undefined) delete process.env['SHIZUHA_DISABLE_MCP_JSON'];
    else process.env['SHIZUHA_DISABLE_MCP_JSON'] = originalDisable;
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('loads a valid .mcp.json', async () => {
    fs.writeFileSync(
      path.join(tmpCwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { echo: { command: 'echo', args: ['hi'] } } }),
    );
    const config = await loadConfig(tmpCwd);
    const servers = (config.mcp?.servers ?? []) as Array<{ name?: string }>;
    expect(servers.map((s) => s.name)).toContain('echo');
  });

  it('does not hang on a FIFO .mcp.json and skips it', async () => {
    const fifo = path.join(tmpCwd, '.mcp.json');
    execFileSync('mkfifo', [fifo]);
    // A hang would time out the test; loadConfig must return promptly.
    const config = await loadConfig(tmpCwd);
    expect(config).toBeDefined();
  });

  it('skips a directory .mcp.json without throwing', async () => {
    fs.mkdirSync(path.join(tmpCwd, '.mcp.json'), { recursive: true });
    const config = await loadConfig(tmpCwd);
    expect(config).toBeDefined();
  });

  it('skips a malformed .mcp.json without throwing', async () => {
    fs.writeFileSync(path.join(tmpCwd, '.mcp.json'), '{ not valid json');
    const config = await loadConfig(tmpCwd);
    expect(config).toBeDefined();
  });

  it('skips an oversized .mcp.json', async () => {
    fs.writeFileSync(path.join(tmpCwd, '.mcp.json'), 'x'.repeat(5 * 1024 * 1024));
    const config = await loadConfig(tmpCwd);
    expect(config).toBeDefined();
  });
});

/**
 * SCLI-440 (rui review round): the `shizuha config` command is a
 * configuration-truth surface — present-but-malformed/non-regular/unreadable
 * .mcp.json must be classified `suspect` (command fails nonzero with a
 * concise diagnostic) instead of being silently skipped into a plausible
 * zero-server resolved config. The loader keeps its skip behavior for runtime
 * callers; these tests pin the command-level classifier for all nine
 * black-box cases, including the FIFO deadline and outside-target integrity.
 */
describe('inspectMcpJsonCandidate classification (SCLI-440)', () => {
  let tmpCwd: string;
  const originalHome = process.env['HOME'];

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scli440-inspect-'));
    process.env['HOME'] = tmpCwd;
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('1. missing .mcp.json is absent (clean first-use control)', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    expect(await inspectMcpJsonCandidate(tmpCwd)).toEqual({ kind: 'absent' });
  });

  it('2. valid owner-controlled regular file is ok', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    fs.writeFileSync(
      path.join(tmpCwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { echo: { command: 'echo', args: ['hi'] } } }),
    );
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result.kind).toBe('ok');
  });

  it('3. malformed JSON is suspect with a concise reason', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    fs.writeFileSync(path.join(tmpCwd, '.mcp.json'), '{ not valid json');
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result.kind).toBe('suspect');
    if (result.kind === 'suspect') {
      expect(result.path).toBe(path.join(tmpCwd, '.mcp.json'));
      expect(result.reason).toMatch(/not valid JSON/);
    }
  });

  it('4. directory is suspect', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    fs.mkdirSync(path.join(tmpCwd, '.mcp.json'), { recursive: true });
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result).toMatchObject({ kind: 'suspect', reason: expect.stringMatching(/directory/) });
  });

  it('5. dangling symlink is suspect (target integrity)', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    fs.symlinkSync(path.join(tmpCwd, 'does-not-exist.json'), path.join(tmpCwd, '.mcp.json'));
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result).toMatchObject({ kind: 'suspect', reason: expect.stringMatching(/dangling symlink/) });
  });

  it('6. symlink to a target OUTSIDE the project boundary is suspect and never followed', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli440-outside-'));
    try {
      const outsideTarget = path.join(outsideDir, 'secret.json');
      fs.writeFileSync(outsideTarget, '{ "mcpServers": {} }');
      const before = fs.statSync(outsideTarget);
      fs.symlinkSync(outsideTarget, path.join(tmpCwd, '.mcp.json'));
      const result = await inspectMcpJsonCandidate(tmpCwd);
      expect(result.kind).toBe('suspect');
      if (result.kind === 'suspect') {
        expect(result.reason).toMatch(/escapes the .* boundary/);
        expect(result.reason).toContain(outsideTarget);
      }
      // Outside-target integrity: inspection must not have touched it.
      const after = fs.statSync(outsideTarget);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('7. mode-000 regular file is suspect (unreadable)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Root reads anything; EACCES classification is untestable as root.
      return;
    }
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    const p = path.join(tmpCwd, '.mcp.json');
    fs.writeFileSync(p, '{ "mcpServers": {} }');
    fs.chmodSync(p, 0o000);
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result).toMatchObject({ kind: 'suspect', reason: expect.stringMatching(/not readable/) });
    fs.chmodSync(p, 0o644); // allow cleanup
  });

  it('8. FIFO is suspect without opening (never blocks)', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    execFileSync('mkfifo', [path.join(tmpCwd, '.mcp.json')]);
    // A hang would time out the test; classification must be prompt.
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result).toMatchObject({ kind: 'suspect', reason: expect.stringMatching(/FIFO/) });
  });

  it('9. unix socket is suspect', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    const sockPath = path.join(tmpCwd, '.mcp.json');
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const result = await inspectMcpJsonCandidate(tmpCwd);
      expect(result).toMatchObject({ kind: 'suspect', reason: expect.stringMatching(/socket/) });
    } finally {
      server.close();
      fs.rmSync(sockPath, { force: true });
    }
  });

  it('oversized regular file is suspect (bound)', async () => {
    const { inspectMcpJsonCandidate } = await import('../../src/config/loader.js');
    fs.writeFileSync(path.join(tmpCwd, '.mcp.json'), 'x'.repeat(5 * 1024 * 1024));
    const result = await inspectMcpJsonCandidate(tmpCwd);
    expect(result).toMatchObject({ kind: 'suspect', reason: expect.stringMatching(/bound/) });
  });
});
