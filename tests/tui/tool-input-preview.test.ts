import { describe, it, expect } from 'vitest';
import { previewToolInput } from '../../src/tui/utils/toolInputPreview.js';

describe('previewToolInput', () => {
  it('prioritizes grep-like keys and limits to 2-3 lines', () => {
    const lines = previewToolInput({
      cwd: '/tmp/repo',
      pattern: 'session_start',
      include: '*.ts',
      exclude: 'dist/**',
      another: 'value',
    }, 3);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('pattern:');
    expect(lines[1]).toContain('cwd:');
    expect(lines[2]).toContain('... +');
  });

  it('returns empty array for empty input', () => {
    expect(previewToolInput({}, 3)).toEqual([]);
  });

  it('truncates long values', () => {
    const long = 'x'.repeat(200);
    const lines = previewToolInput({ query: long }, 3);
    expect(lines[0]?.length).toBeLessThanOrEqual(110);
    expect(lines[0]).toContain('...');
  });
});

