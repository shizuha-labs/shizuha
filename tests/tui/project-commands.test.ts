import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectProjectEcosystem,
  detectProjectCommands,
  buildAgentsMdBoilerplate,
} from '../../src/tui/utils/projectCommands.js';

describe('projectCommands (SCLI-391)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-proj-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects python from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname="x"\n');
    expect(detectProjectEcosystem(tmpDir)).toBe('python');
    const cmds = detectProjectCommands(tmpDir);
    expect(cmds.ecosystem).toBe('python');
    expect(cmds.commandsBlock).toMatch(/pytest|uv run/);
    expect(cmds.commandsBlock).not.toMatch(/\bnpm\b/);
  });

  it('detects node from package.json and prefers it over python', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run', dev: 'vite' } }),
    );
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname="x"\n');
    expect(detectProjectEcosystem(tmpDir)).toBe('node');
    const body = buildAgentsMdBoilerplate(tmpDir);
    expect(body).toContain('npm run build');
    expect(body).toContain('npm test');
  });

  it('detects rust and go', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(detectProjectEcosystem(tmpDir)).toBe('rust');
    expect(detectProjectCommands(tmpDir).commandsBlock).toContain('cargo test');

    fs.rmSync(path.join(tmpDir, 'Cargo.toml'));
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/x\n');
    expect(detectProjectEcosystem(tmpDir)).toBe('go');
    expect(detectProjectCommands(tmpDir).commandsBlock).toContain('go test');
  });

  it('unknown leaves placeholders without inventing npm', () => {
    const body = buildAgentsMdBoilerplate(tmpDir);
    expect(body).toMatch(/unset|not auto-detected/i);
    expect(body).not.toMatch(/\bnpm\b/);
  });
});
