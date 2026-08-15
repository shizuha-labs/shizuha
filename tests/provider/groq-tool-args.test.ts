import { describe, expect, it } from 'vitest';
import { parseGroqToolArguments, GroqProvider } from '../../src/provider/groq.js';

/** SCLI-29: Groq tool-call argument quirks. */

describe('parseGroqToolArguments', () => {
  it('returns {} for empty / whitespace / nullish input', () => {
    expect(parseGroqToolArguments('')).toEqual({});
    expect(parseGroqToolArguments('   ')).toEqual({});
    expect(parseGroqToolArguments(null as unknown as string)).toEqual({});
    expect(parseGroqToolArguments(undefined as unknown as string)).toEqual({});
  });

  it('parses normal JSON object arguments', () => {
    expect(parseGroqToolArguments('{"city":"SF","units":"c"}')).toEqual({ city: 'SF', units: 'c' });
  });

  it('strips a ```json … ``` markdown fence', () => {
    expect(parseGroqToolArguments('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a bare ``` … ``` fence', () => {
    expect(parseGroqToolArguments('```\n{"b":2}\n```')).toEqual({ b: 2 });
  });

  it('unwraps double-encoded JSON-string arguments', () => {
    const doubleEncoded = JSON.stringify('{"a":1,"nested":{"x":true}}');
    expect(parseGroqToolArguments(doubleEncoded)).toEqual({ a: 1, nested: { x: true } });
  });

  it('returns {} for a non-object JSON value (array / scalar / null)', () => {
    expect(parseGroqToolArguments('[1,2,3]')).toEqual({});
    expect(parseGroqToolArguments('42')).toEqual({});
    expect(parseGroqToolArguments('"just a string"')).toEqual({});
    expect(parseGroqToolArguments('null')).toEqual({});
  });

  it('returns {} for malformed JSON (never throws)', () => {
    expect(parseGroqToolArguments('{not valid')).toEqual({});
    expect(parseGroqToolArguments('{"a":}')).toEqual({});
  });

  it('preserves nested structures', () => {
    expect(parseGroqToolArguments('{"items":[1,2],"meta":{"ok":true}}'))
      .toEqual({ items: [1, 2], meta: { ok: true } });
  });

  it('GroqProvider.parseToolCallArguments delegates to the quirk parser', () => {
    const p = new GroqProvider('test-key');
    const parse = (p as unknown as { parseToolCallArguments(s: string): unknown }).parseToolCallArguments.bind(p);
    expect(parse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parse('')).toEqual({});
  });
});
