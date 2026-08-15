import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parsePageRange } from '../../src/utils/page-range.js';
import { pdfExtractTool } from '../../src/tools/builtin/pdf-extract.js';
import type { ToolContext } from '../../src/tools/types.js';

// ── parsePageRange tests ──

describe('parsePageRange', () => {
  const TOTAL = 10;

  describe('"all" spec', () => {
    it('returns all pages for "all"', () => {
      const result = parsePageRange('all', TOTAL);
      expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('returns all pages for "ALL" (case insensitive)', () => {
      const result = parsePageRange('ALL', TOTAL);
      expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('returns all pages for empty string', () => {
      const result = parsePageRange('', TOTAL);
      expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('returns all pages for whitespace', () => {
      const result = parsePageRange('  ', TOTAL);
      expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  describe('single page', () => {
    it('parses single page number', () => {
      const result = parsePageRange('1', TOTAL);
      expect(result).toEqual([0]); // 0-indexed
    });

    it('parses last page', () => {
      const result = parsePageRange('10', TOTAL);
      expect(result).toEqual([9]);
    });

    it('throws for page 0', () => {
      expect(() => parsePageRange('0', TOTAL)).toThrow(/must be a positive integer/);
    });

    it('throws for page exceeding total', () => {
      expect(() => parsePageRange('11', TOTAL)).toThrow(/exceeds total pages/);
    });

    it('throws for negative page number', () => {
      expect(() => parsePageRange('-1', TOTAL)).toThrow(/must be a positive integer/);
    });

    it('throws for non-numeric page', () => {
      expect(() => parsePageRange('abc', TOTAL)).toThrow(/must be a positive integer/);
    });
  });

  describe('page range (start-end)', () => {
    it('parses inclusive range', () => {
      const result = parsePageRange('1-5', TOTAL);
      expect(result).toEqual([0, 1, 2, 3, 4]);
    });

    it('parses single-page range', () => {
      const result = parsePageRange('3-3', TOTAL);
      expect(result).toEqual([2]);
    });

    it('clamps end to total pages', () => {
      const result = parsePageRange('8-15', TOTAL);
      expect(result).toEqual([7, 8, 9]); // 8, 9, 10 (clamped to total)
    });

    it('throws for inverted range (start > end)', () => {
      expect(() => parsePageRange('5-1', TOTAL)).toThrow(/start must be <= end/);
    });

    it('throws for start exceeding total pages', () => {
      expect(() => parsePageRange('11-15', TOTAL)).toThrow(/start page 11 exceeds total pages/);
    });

    it('throws for range with page 0', () => {
      expect(() => parsePageRange('0-5', TOTAL)).toThrow(/page numbers must be >= 1/);
    });

    it('handles spaces around hyphen', () => {
      const result = parsePageRange('2 - 4', TOTAL);
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('mixed comma-separated', () => {
    it('parses comma-separated single pages', () => {
      const result = parsePageRange('1,3,5', TOTAL);
      expect(result).toEqual([0, 2, 4]);
    });

    it('parses mixed singles and ranges', () => {
      const result = parsePageRange('1,3,5-7', TOTAL);
      expect(result).toEqual([0, 2, 4, 5, 6]);
    });

    it('deduplicates overlapping pages', () => {
      const result = parsePageRange('1-3,2-4', TOTAL);
      expect(result).toEqual([0, 1, 2, 3]); // 1,2,3 + 2,3,4 deduplicated and sorted
    });

    it('sorts result in ascending order', () => {
      const result = parsePageRange('5,1,3', TOTAL);
      expect(result).toEqual([0, 2, 4]); // sorted: 1, 3, 5 (0-indexed)
    });

    it('handles trailing comma', () => {
      const result = parsePageRange('1,2,', TOTAL);
      expect(result).toEqual([0, 1]);
    });

    it('handles empty parts between commas', () => {
      const result = parsePageRange('1,,3', TOTAL);
      expect(result).toEqual([0, 2]);
    });
  });

  describe('edge cases', () => {
    it('works with totalPages = 1', () => {
      expect(parsePageRange('all', 1)).toEqual([0]);
      expect(parsePageRange('1', 1)).toEqual([0]);
    });

    it('throws for totalPages with page exceeding it', () => {
      expect(() => parsePageRange('2', 1)).toThrow(/exceeds total pages/);
    });
  });
});

// ── pdfExtractTool tests ──

describe('pdfExtractTool', () => {
  let tmpDir: string;
  let context: ToolContext;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-pdf-test-'));
    context = { cwd: tmpDir, sessionId: 'test-pdf' };
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct name and metadata', () => {
    expect(pdfExtractTool.name).toBe('pdf_extract');
    expect(pdfExtractTool.readOnly).toBe(true);
    expect(pdfExtractTool.riskLevel).toBe('low');
  });

  // ── Text fallback for non-PDF files ──

  describe('text fallback', () => {
    it('reads .txt files as plain text', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(filePath, 'Hello, world!');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Hello, world!');
      expect(result.content).toContain('test.txt');
    });

    it('reads .md files as plain text', async () => {
      const filePath = path.join(tmpDir, 'readme.md');
      await fs.writeFile(filePath, '# Heading\n\nParagraph text');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('# Heading');
      expect(result.content).toContain('Paragraph text');
    });

    it('reads .csv files as plain text', async () => {
      const filePath = path.join(tmpDir, 'data.csv');
      await fs.writeFile(filePath, 'name,age\nAlice,30\nBob,25');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('name,age');
    });

    it('reads .json files as plain text', async () => {
      const filePath = path.join(tmpDir, 'config.json');
      await fs.writeFile(filePath, '{"key": "value"}');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('{"key": "value"}');
    });

    it('supports markdown output format for text files', async () => {
      const filePath = path.join(tmpDir, 'test-fmt.txt');
      await fs.writeFile(filePath, 'Some content');

      const result = await pdfExtractTool.execute(
        { file_path: filePath, format: 'markdown' },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('# test-fmt.txt');
      expect(result.content).toContain('```txt');
    });

    it('supports text output format (default)', async () => {
      const filePath = path.join(tmpDir, 'test-default.txt');
      await fs.writeFile(filePath, 'Some content');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('File: test-default.txt');
      expect(result.content).toContain('='.repeat(40));
    });
  });

  // ── File not found ──

  describe('file not found', () => {
    it('returns error for non-existent file', async () => {
      const result = await pdfExtractTool.execute(
        { file_path: path.join(tmpDir, 'nonexistent.pdf') },
        context,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('File not found');
    });
  });

  // ── Unsupported extension ──

  describe('unsupported extension', () => {
    it('returns error for unsupported file types', async () => {
      const filePath = path.join(tmpDir, 'photo.jpg');
      await fs.writeFile(filePath, 'fake image data');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unsupported file type');
      expect(result.content).toContain('.jpg');
    });

    it('lists supported extensions in error message', async () => {
      const filePath = path.join(tmpDir, 'file.zip');
      await fs.writeFile(filePath, 'fake zip data');

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('.pdf');
      expect(result.content).toContain('.txt');
      expect(result.content).toContain('.md');
    });
  });

  // ── Output truncation ──

  describe('output truncation', () => {
    it('truncates output at 50KB for text files', async () => {
      const filePath = path.join(tmpDir, 'large.txt');
      // Create a file slightly larger than 50KB
      const content = 'x'.repeat(60 * 1024);
      await fs.writeFile(filePath, content);

      const result = await pdfExtractTool.execute(
        { file_path: filePath },
        context,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('[Output truncated at 51200 bytes]');
      // The content part should be at most 50KB of 'x'
      expect(result.content.length).toBeLessThan(60 * 1024);
    });
  });

  // ── Parameter validation ──

  describe('parameter validation', () => {
    it('requires file_path parameter', () => {
      const result = pdfExtractTool.parameters.safeParse({});
      expect(result.success).toBe(false);
    });

    it('accepts file_path only', () => {
      const result = pdfExtractTool.parameters.safeParse({
        file_path: '/tmp/test.pdf',
      });
      expect(result.success).toBe(true);
    });

    it('accepts optional pages parameter', () => {
      const result = pdfExtractTool.parameters.safeParse({
        file_path: '/tmp/test.pdf',
        pages: '1-5',
      });
      expect(result.success).toBe(true);
    });

    it('accepts optional format parameter', () => {
      const result = pdfExtractTool.parameters.safeParse({
        file_path: '/tmp/test.pdf',
        format: 'markdown',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid format', () => {
      const result = pdfExtractTool.parameters.safeParse({
        file_path: '/tmp/test.pdf',
        format: 'html',
      });
      expect(result.success).toBe(false);
    });
  });
});
