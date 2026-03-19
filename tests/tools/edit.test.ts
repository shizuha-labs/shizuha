import { describe, it, expect } from 'vitest';
import { applyEdit } from '../../src/utils/diff.js';

describe('applyEdit', () => {
  it('replaces a unique string', () => {
    const content = 'hello world\nfoo bar\nbaz qux';
    const { result, replacements } = applyEdit(content, 'foo bar', 'replaced');
    expect(result).toBe('hello world\nreplaced\nbaz qux');
    expect(replacements).toBe(1);
  });

  it('throws if old_string not found', () => {
    expect(() => applyEdit('hello', 'missing', 'new')).toThrow('old_string not found');
  });

  it('throws if old_string matches multiple locations', () => {
    const content = 'aaa\nbbb\naaa';
    expect(() => applyEdit(content, 'aaa', 'ccc')).toThrow('multiple locations');
  });

  it('replaces all with replace_all=true', () => {
    const content = 'aaa\nbbb\naaa';
    const { result, replacements } = applyEdit(content, 'aaa', 'ccc', true);
    expect(result).toBe('ccc\nbbb\nccc');
    expect(replacements).toBe(2);
  });

  it('throws if old_string equals new_string', () => {
    expect(() => applyEdit('hello', 'hello', 'hello')).toThrow('must be different');
  });

  it('provides helpful error when first line matches but full block does not', () => {
    const content = '  function foo() {\n    return 1;\n  }';
    // "function foo() {\n  return 1;" doesn't exist exactly (wrong indentation)
    expect(() =>
      applyEdit(content, 'function foo() {\n  return 1;', 'function bar() {\n  return 2;'),
    ).toThrow('Check whitespace');
  });

  it('handles empty new_string (deletion)', () => {
    const content = 'line1\nline2\nline3';
    const { result } = applyEdit(content, '\nline2', '');
    expect(result).toBe('line1\nline3');
  });
});
