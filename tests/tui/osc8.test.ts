import { describe, it, expect } from 'vitest';
import { wrapFileLinks } from '../../src/tui/utils/osc8.js';

describe('wrapFileLinks', () => {
  const cwd = '/home/user/project';

  it('wraps file path with directory', () => {
    const result = wrapFileLinks('src/index.ts', cwd);
    expect(result).toContain('\x1b]8;;file:///home/user/project/src/index.ts\x07');
    expect(result).toContain('\x1b]8;;\x07');
  });

  it('wraps file path with line number', () => {
    const result = wrapFileLinks('src/index.ts:42', cwd);
    expect(result).toContain('src/index.ts:42');
    expect(result).toContain('\x1b]8;;');
  });

  it('wraps file path with line and column', () => {
    const result = wrapFileLinks('src/index.ts:42:10', cwd);
    expect(result).toContain('src/index.ts:42:10');
    expect(result).toContain('\x1b]8;;');
  });

  it('wraps absolute file paths', () => {
    const result = wrapFileLinks('/tmp/project/test.ts:5', cwd);
    expect(result).toContain('file:///tmp/project/test.ts');
  });

  it('skips URLs with protocols', () => {
    const input = 'Visit https://example.com/path/file.ts for info';
    const result = wrapFileLinks(input, cwd);
    expect(result).not.toContain('file:///home/user/project');
  });

  it('handles multiple file references in one line', () => {
    const result = wrapFileLinks('Error in src/a.ts:10 and src/b.ts:20', cwd);
    const matches = result.match(/\x1b\]8;;file:\/\//g);
    expect(matches?.length).toBe(2);
  });

  it('handles text with no file references', () => {
    const result = wrapFileLinks('hello world no files here', cwd);
    expect(result).toBe('hello world no files here');
  });

  it('handles relative paths with ../', () => {
    const result = wrapFileLinks('../other/file.ts', cwd);
    expect(result).toContain('\x1b]8;;');
  });

  it('handles ./ relative paths', () => {
    const result = wrapFileLinks('./local/file.js', cwd);
    expect(result).toContain('\x1b]8;;');
  });

  it('wraps deeply nested paths', () => {
    const result = wrapFileLinks('src/tui/components/StatusBar.tsx:42', cwd);
    expect(result).toContain('file:///home/user/project/src/tui/components/StatusBar.tsx');
  });
});
