import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readTool } from '../../src/tools/builtin/read.js';
import { writeTool } from '../../src/tools/builtin/write.js';
import type { ToolContext } from '../../src/tools/types.js';

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-test-'));
  ctx = { cwd: tmpDir, sessionId: 'test-session' };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('read tool', () => {
  it('reads an existing file with line numbers', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3');
    const result = await readTool.execute({ file_path: 'test.txt' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('line1');
    expect(result.content).toContain('line2');
    expect(result.content).toContain('line3');
    // Should have line numbers
    expect(result.content).toMatch(/\d+\tline1/);
  });

  it('reads with offset and limit', async () => {
    await fs.writeFile(path.join(tmpDir, 'lines.txt'), 'a\nb\nc\nd\ne');
    const result = await readTool.execute(
      { file_path: 'lines.txt', offset: 1, limit: 2 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('b');
    expect(result.content).toContain('c');
    expect(result.content).not.toContain('\ta\n');
    expect(result.content).not.toContain('\td\n');
  });

  it('returns error for nonexistent file', async () => {
    const result = await readTool.execute({ file_path: 'nope.txt' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error');
  });

  it('reads image files and returns base64 + metadata', async () => {
    // Create a minimal 1x1 PNG (valid PNG header)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, // bit depth, color
    ]);
    await fs.writeFile(path.join(tmpDir, 'test.png'), pngHeader);
    const result = await readTool.execute({ file_path: 'test.png' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.image).toBeDefined();
    expect(result.image!.mediaType).toBe('image/png');
    expect(result.image!.base64).toBeTruthy();
    expect(result.content).toContain('test.png');
  });

  it('handles empty files', async () => {
    await fs.writeFile(path.join(tmpDir, 'empty.txt'), '');
    const result = await readTool.execute({ file_path: 'empty.txt' }, ctx);
    expect(result.isError).toBeFalsy();
  });

  it('tool metadata is correct', () => {
    expect(readTool.name).toBe('read');
    expect(readTool.readOnly).toBe(true);
    expect(readTool.riskLevel).toBe('low');
  });
});

describe('write tool', () => {
  it('creates a new file', async () => {
    const result = await writeTool.execute(
      { file_path: 'new.txt', content: 'hello world' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const written = await fs.readFile(path.join(tmpDir, 'new.txt'), 'utf-8');
    expect(written).toBe('hello world');
  });

  it('overwrites an existing file', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'old');
    const result = await writeTool.execute(
      { file_path: 'existing.txt', content: 'new' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const written = await fs.readFile(path.join(tmpDir, 'existing.txt'), 'utf-8');
    expect(written).toBe('new');
  });

  it('creates parent directories', async () => {
    const result = await writeTool.execute(
      { file_path: 'sub/dir/file.txt', content: 'nested' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const written = await fs.readFile(path.join(tmpDir, 'sub/dir/file.txt'), 'utf-8');
    expect(written).toBe('nested');
  });

  it('writes empty content', async () => {
    const result = await writeTool.execute(
      { file_path: 'empty.txt', content: '' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const written = await fs.readFile(path.join(tmpDir, 'empty.txt'), 'utf-8');
    expect(written).toBe('');
  });

  it('reports line count in result', async () => {
    const result = await writeTool.execute(
      { file_path: 'multi.txt', content: 'a\nb\nc' },
      ctx,
    );
    expect(result.content).toContain('3 lines');
  });

  it('tool metadata is correct', () => {
    expect(writeTool.name).toBe('write');
    expect(writeTool.readOnly).toBe(false);
    expect(writeTool.riskLevel).toBe('medium');
  });
});
