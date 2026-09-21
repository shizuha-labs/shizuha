/**
 * SCLI-692 Finding 1 — the Gemini-style API rejects `additionalProperties`
 * in function declarations. The Google provider must strip the unsupported
 * keyword recursively from internal tool schemas before sending them.
 */
import { describe, expect, it } from 'vitest';

import { toGeminiSchema } from '../../src/provider/google.js';

describe('SCLI-692 — Gemini schema sanitizer', () => {
  it('strips additionalProperties at the root', () => {
    expect(toGeminiSchema({
      type: 'object',
      properties: { command: { type: 'string' } },
      additionalProperties: false,
    })).toEqual({
      type: 'object',
      properties: { command: { type: 'string' } },
    });
  });

  it('strips additionalProperties at every nesting level', () => {
    const out = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: true,
          properties: {
            deep: { type: 'array', items: { type: 'string', additionalProperties: false } },
          },
        },
      },
    });
    expect(JSON.stringify(out)).not.toContain('additionalProperties');
    expect((out as any).properties.nested.properties.deep.items).toEqual({ type: 'string' });
  });

  it('strips $schema and preserves everything else', () => {
    const out = toGeminiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', description: 'x' } },
    });
    expect(out).toEqual({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', description: 'x' } },
    });
  });

  it('handles arrays and primitives', () => {
    expect(toGeminiSchema([{ type: 'string', additionalProperties: false }, 'x', 3, null])).toEqual([
      { type: 'string' }, 'x', 3, null,
    ]);
    expect(toGeminiSchema('plain')).toBe('plain');
  });
});
