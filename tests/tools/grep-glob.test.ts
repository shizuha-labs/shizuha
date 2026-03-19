import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { globTool } from '../../src/tools/builtin/glob.js';
import { grepTool } from '../../src/tools/builtin/grep.js';
import type { ToolContext } from '../../src/tools/types.js';

let tmpDir: string;
let ctx: ToolContext;

// Check if rg is available at module level
let hasRg = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'ignore' });
  hasRg = true;
} catch {
  // rg not available
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-test-'));
  ctx = { cwd: tmpDir, sessionId: 'test-session' };

  // Create test file structure
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'src/app.ts'), 'export function main() {\n  console.log("hello");\n}\n');
  await fs.writeFile(path.join(tmpDir, 'src/utils.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  await fs.writeFile(path.join(tmpDir, 'lib/helper.js'), 'module.exports = { help: true };\n');
  await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Test Project\n');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('glob tool', () => {
  it('matches files with **/*.ts pattern', async () => {
    const result = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('app.ts');
    expect(result.content).toContain('utils.ts');
    expect(result.content).not.toContain('helper.js');
  });

  it('matches files with specific extension', async () => {
    const result = await globTool.execute({ pattern: '**/*.js' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('helper.js');
    expect(result.content).not.toContain('app.ts');
  });

  it('returns empty result for no matches', async () => {
    const result = await globTool.execute({ pattern: '**/*.py' }, ctx);
    expect(result.content).toContain('No files matched');
  });

  it('searches in a specific subdirectory', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: 'src' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('app.ts');
  });

  it('tool metadata is correct', () => {
    expect(globTool.name).toBe('glob');
    expect(globTool.readOnly).toBe(true);
    expect(globTool.riskLevel).toBe('low');
  });
});

describe('grep tool', () => {
  it.skipIf(!hasRg)('finds pattern in files', async () => {
    const result = await grepTool.execute(
      { pattern: 'function', path: tmpDir },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('function');
    expect(result.content).toContain('main');
  });

  it.skipIf(!hasRg)('filters by glob pattern', async () => {
    const result = await grepTool.execute(
      { pattern: 'export', path: tmpDir, glob: '*.ts' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export');
    // Should not search .js files
    expect(result.content).not.toContain('module.exports');
  });

  it.skipIf(!hasRg)('returns no matches result', async () => {
    const result = await grepTool.execute(
      { pattern: 'ZZZZNOTFOUND', path: tmpDir },
      ctx,
    );
    expect(result.content).toContain('No matches');
  });

  it.skipIf(!hasRg)('includes context lines when requested', async () => {
    const result = await grepTool.execute(
      { pattern: 'console\\.log', path: tmpDir, context: 1 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    // Should have surrounding context
    expect(result.content).toContain('function main');
  });

  it.skipIf(!hasRg)('supports regex patterns', async () => {
    const result = await grepTool.execute(
      { pattern: 'a:\\s+number', path: tmpDir },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('add');
  });

  it('falls back to native grep when rg is missing', async () => {
    if (hasRg) {
      // When rg is installed, skip this test — it tests the fallback path
      return;
    }
    const result = await grepTool.execute(
      { pattern: 'test', path: tmpDir },
      ctx,
    );
    // With the native grep fallback, missing rg no longer errors
    expect(result.isError).toBeFalsy();
  });

  it('tool metadata is correct', () => {
    expect(grepTool.name).toBe('grep');
    expect(grepTool.readOnly).toBe(true);
    expect(grepTool.riskLevel).toBe('low');
  });
});
