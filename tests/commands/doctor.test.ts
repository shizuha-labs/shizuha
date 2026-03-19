import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor, printChecks } from '../../src/commands/doctor.js';
import type { DoctorCheck } from '../../src/commands/doctor.js';

// ── Tests ──

describe('runDoctor', () => {
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

  it('API key check shows warn when optional env var not set', async () => {
    const orig = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];

    try {
      const checks = await runDoctor(process.cwd());
      const googleCheck = checks.find((c) => c.name === 'GOOGLE_API_KEY');
      expect(googleCheck).toBeDefined();
      expect(googleCheck!.status).toBe('warn');
      expect(googleCheck!.message).toContain('not set');
    } finally {
      if (orig !== undefined) {
        process.env['GOOGLE_API_KEY'] = orig;
      }
    }
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
