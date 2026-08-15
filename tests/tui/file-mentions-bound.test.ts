import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadInlineFileForMention,
  maxInlineFileChars,
  maxTotalInlineFileChars,
} from '../../src/tui/utils/fileMentions.js';

describe('SCLI-389 bounded @file mention inlining', () => {
  let tmpDir: string;
  const prevPerFile = process.env['SHIZUHA_TUI_MAX_INLINE_FILE_CHARS'];
  const prevTotal = process.env['SHIZUHA_TUI_MAX_TOTAL_INLINE_CHARS'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-389-'));
    process.env['SHIZUHA_TUI_MAX_INLINE_FILE_CHARS'] = '2000';
    process.env['SHIZUHA_TUI_MAX_TOTAL_INLINE_CHARS'] = '5000';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevPerFile === undefined) delete process.env['SHIZUHA_TUI_MAX_INLINE_FILE_CHARS'];
    else process.env['SHIZUHA_TUI_MAX_INLINE_FILE_CHARS'] = prevPerFile;
    if (prevTotal === undefined) delete process.env['SHIZUHA_TUI_MAX_TOTAL_INLINE_CHARS'];
    else process.env['SHIZUHA_TUI_MAX_TOTAL_INLINE_CHARS'] = prevTotal;
  });

  it('reads env caps', () => {
    expect(maxInlineFileChars()).toBe(2000);
    expect(maxTotalInlineFileChars()).toBe(5000);
  });

  it('inlines small files fully', () => {
    const p = path.join(tmpDir, 'small.txt');
    fs.writeFileSync(p, 'hello world');
    const loaded = loadInlineFileForMention(p, 5000);
    expect(loaded.truncated).toBe(false);
    expect(loaded.skipped).toBe(false);
    expect(loaded.originalChars).toBe(11);
    expect(loaded.block).toContain('hello world');
    expect(loaded.block).toContain(`path="${p}"`);
  });

  it('truncates oversize text files with a clear marker', () => {
    const p = path.join(tmpDir, 'big.txt');
    const body = 'A'.repeat(8000);
    fs.writeFileSync(p, body);
    const loaded = loadInlineFileForMention(p, 5000);
    expect(loaded.truncated).toBe(true);
    expect(loaded.skipped).toBe(false);
    expect(loaded.originalChars).toBe(8000);
    expect(loaded.block.length).toBeLessThan(body.length);
    expect(loaded.block).toMatch(/truncated \d+ of 8000 chars/);
    expect(loaded.block).toContain('use the read tool');
    // Head + tail retained
    expect(loaded.block).toContain('AAAA');
  });

  it('respects remaining total budget even when per-file cap is higher', () => {
    const p = path.join(tmpDir, 'mid.txt');
    fs.writeFileSync(p, 'B'.repeat(3000));
    const loaded = loadInlineFileForMention(p, 500); // remaining budget 500 < per-file 2000
    expect(loaded.truncated).toBe(true);
    expect(loaded.block).toMatch(/@mention inline cap 500/);
  });

  it('emits a skip notice when total budget is exhausted', () => {
    const p = path.join(tmpDir, 'late.txt');
    fs.writeFileSync(p, 'still here');
    const loaded = loadInlineFileForMention(p, 0);
    expect(loaded.skipped).toBe(true);
    expect(loaded.truncated).toBe(true);
    expect(loaded.block).toContain('budget exhausted');
    expect(loaded.block).not.toContain('still here');
  });

  it('refuses multi-MB blobs without reading them into the prompt', () => {
    const p = path.join(tmpDir, 'huge.bin');
    // hardByteCap = max(perFile*4, 512_000) = max(8000, 512000) = 512000 with test env
    // Write just over the cap via sparse-ish content.
    const fd = fs.openSync(p, 'w');
    fs.ftruncateSync(fd, 600_000);
    fs.closeSync(fd);
    const loaded = loadInlineFileForMention(p, 5_000_000);
    expect(loaded.truncated).toBe(true);
    expect(loaded.originalChars).toBe(600_000);
    expect(loaded.block).toContain('too large to inline');
    expect(loaded.block.length).toBeLessThan(2000);
  });

  it('regression: a multi-MB attachment must not expand to multi-MB prompt text', () => {
    // The incident class: @path of a multi-MB file used to dump the entire
    // contents into the user message, forcing multi-minute pre-turn compaction.
    process.env['SHIZUHA_TUI_MAX_INLINE_FILE_CHARS'] = '120000';
    process.env['SHIZUHA_TUI_MAX_TOTAL_INLINE_CHARS'] = '200000';
    const p = path.join(tmpDir, 'incident-log.txt');
    const mb = 3 * 1024 * 1024;
    const fd = fs.openSync(p, 'w');
    // Write real content at the start so truncation path is exercised if under hard cap.
    fs.writeSync(fd, Buffer.alloc(100_000, 0x41)); // 'A' * 100k
    fs.ftruncateSync(fd, mb);
    fs.closeSync(fd);

    const loaded = loadInlineFileForMention(p, maxTotalInlineFileChars());
    // Either hard-cap notice OR truncated body — never the full 3MB.
    expect(loaded.block.length).toBeLessThan(300_000);
    expect(loaded.truncated || loaded.skipped).toBe(true);
  });
});
