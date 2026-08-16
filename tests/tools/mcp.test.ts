import { describe, it, expect } from 'vitest';
import { processToolOutput } from '../../src/tools/mcp/client.js';
import { deriveReadOnly, deriveRiskLevel } from '../../src/tools/mcp/bridge.js';
import type { MCPToolAnnotations } from '../../src/tools/mcp/client.js';

// ── processToolOutput ──

describe('processToolOutput', () => {
  it('handles text content', () => {
    const result = processToolOutput([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ]);
    expect(result.content).toBe('Hello\nWorld');
    expect(result.isError).toBe(false);
    expect(result.image).toBeUndefined();
  });

  it('handles image content — first image extracted', () => {
    const result = processToolOutput([
      { type: 'text', text: 'Before image' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
      { type: 'image', data: 'def456', mimeType: 'image/jpeg' },
    ]);
    expect(result.image).toEqual({ base64: 'abc123', mediaType: 'image/png' });
    // Second image becomes a text placeholder
    expect(result.content).toContain('[Image: image/jpeg]');
    expect(result.content).toContain('Before image');
  });

  it('handles audio content as placeholder', () => {
    const result = processToolOutput([
      { type: 'audio', data: 'binarydata', mimeType: 'audio/mpeg' },
    ]);
    expect(result.content).toBe('[Audio: audio/mpeg]');
  });

  it('handles embedded resource with text', () => {
    const result = processToolOutput([
      { type: 'resource', resource: { uri: 'file://test.txt', text: 'File content here' } },
    ]);
    expect(result.content).toBe('File content here');
  });

  it('handles embedded resource with blob', () => {
    const result = processToolOutput([
      { type: 'resource', resource: { uri: 'file://test.bin', blob: 'base64data' } },
    ]);
    expect(result.content).toBe('[Binary resource: file://test.bin]');
  });

  it('handles resource_link as placeholder', () => {
    const result = processToolOutput([
      { type: 'resource_link', uri: 'https://example.com/data', name: 'My Data' },
    ]);
    expect(result.content).toBe('[Resource: My Data (https://example.com/data)]');
  });

  it('passes through isError flag', () => {
    const result = processToolOutput([{ type: 'text', text: 'error occurred' }], true);
    expect(result.isError).toBe(true);
    expect(result.content).toBe('error occurred');
  });

  it('handles empty content array', () => {
    const result = processToolOutput([]);
    expect(result.content).toBe('');
    expect(result.isError).toBe(false);
  });

  it('handles unsupported image types as placeholder', () => {
    const result = processToolOutput([
      { type: 'image', data: 'abc', mimeType: 'image/tiff' },
    ]);
    expect(result.content).toBe('[Image: image/tiff]');
    expect(result.image).toBeUndefined();
  });
});

// ── Output truncation ──

describe('processToolOutput — truncation', () => {
  it('truncates output exceeding 25K token limit', () => {
    // 25K tokens ~ 100K chars. Create 120K chars of text
    const longText = 'x'.repeat(120_000);
    const result = processToolOutput([{ type: 'text', text: longText }]);
    // Should be truncated — output should be less than original
    expect(result.content.length).toBeLessThan(120_000);
    expect(result.content).toContain('[Output truncated:');
    expect(result.content).toContain('token limit]');
  });

  it('does not truncate output within limit', () => {
    const shortText = 'Hello world';
    const result = processToolOutput([{ type: 'text', text: shortText }]);
    expect(result.content).toBe(shortText);
    expect(result.content).not.toContain('[Output truncated:');
  });
});

// ── Annotation → readOnly / riskLevel ──

describe('deriveReadOnly', () => {
  it('returns false when no annotations', () => {
    expect(deriveReadOnly(undefined)).toBe(false);
  });

  it('returns true when readOnlyHint is true', () => {
    expect(deriveReadOnly({ readOnlyHint: true })).toBe(true);
  });

  it('returns false when readOnlyHint is false', () => {
    expect(deriveReadOnly({ readOnlyHint: false })).toBe(false);
  });

  it('returns false when readOnlyHint is undefined', () => {
    expect(deriveReadOnly({ destructiveHint: true })).toBe(false);
  });
});

describe('deriveRiskLevel', () => {
  it('returns medium when no annotations', () => {
    expect(deriveRiskLevel(undefined)).toBe('medium');
  });

  it('returns low for read-only tools', () => {
    expect(deriveRiskLevel({ readOnlyHint: true })).toBe('low');
  });

  it('returns medium for non-destructive write tools', () => {
    expect(deriveRiskLevel({ readOnlyHint: false, destructiveHint: false })).toBe('medium');
  });

  it('returns high for destructive write tools (destructiveHint=true)', () => {
    expect(deriveRiskLevel({ readOnlyHint: false, destructiveHint: true })).toBe('high');
  });

  it('returns high when destructiveHint is undefined (default destructive)', () => {
    expect(deriveRiskLevel({ readOnlyHint: false })).toBe('high');
  });

  it('returns high when only destructiveHint is present', () => {
    const annotations: MCPToolAnnotations = { destructiveHint: true };
    expect(deriveRiskLevel(annotations)).toBe('high');
  });
});
