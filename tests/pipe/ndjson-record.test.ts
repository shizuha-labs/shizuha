import { describe, it, expect } from 'vitest';
import {
  classifyPipeLine,
  validateDecodedPipeRecord,
  invalidRecordEvent,
  PIPE_MAX_LINE_BYTES,
} from '../../src/pipe/ndjson-record.js';

describe('pipe NDJSON record validation (SCLI-399)', () => {
  it('skips blank lines silently', () => {
    expect(classifyPipeLine('')).toBeNull();
    expect(classifyPipeLine('   ')).toBeNull();
    expect(classifyPipeLine('\t')).toBeNull();
  });

  it('rejects JSON null without throwing', () => {
    const r = classifyPipeLine('null');
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    if (!r!.ok) {
      expect(r.kind).toBe('null');
      expect(r.error).not.toMatch(/TypeError|shizuha\.js|stack/i);
    }
  });

  it('rejects arrays and scalars', () => {
    for (const line of ['[]', '[1]', '42', '"hi"', 'true', 'false']) {
      const r = classifyPipeLine(line)!;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(['array', 'scalar']).toContain(r.kind);
      }
    }
  });

  it('rejects malformed JSON', () => {
    const r = classifyPipeLine('{not json')!;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('malformed_json');
  });

  it('rejects unknown / non-user objects and empty content', () => {
    expect(classifyPipeLine('{}')!.ok).toBe(false);
    expect(classifyPipeLine('{"type":"assistant"}')!.ok).toBe(false);
    expect(classifyPipeLine('{"type":"user"}')!.ok).toBe(false);
    expect(classifyPipeLine('{"type":"user","message":{}}')!.ok).toBe(false);
    expect(classifyPipeLine('{"type":"user","message":{"content":"  "}}')!.ok).toBe(false);
  });

  it('accepts a valid user message and extracts content + session', () => {
    const line = JSON.stringify({
      type: 'user',
      session_id: 'sess-1',
      message: { content: 'hello world' },
    });
    const r = classifyPipeLine(line)!;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userContent).toBe('hello world');
      expect(r.incomingSessionId).toBe('sess-1');
    }
  });

  it('invalid then valid: classifier stays usable across records (continuation)', () => {
    const bad = classifyPipeLine('null')!;
    expect(bad.ok).toBe(false);
    const good = classifyPipeLine(JSON.stringify({
      type: 'user',
      message: { content: 'next' },
    }))!;
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.userContent).toBe('next');
  });

  it('invalidRecordEvent is bounded and machine-readable', () => {
    const bad = validateDecodedPipeRecord(null);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const ev = invalidRecordEvent(bad, 3);
      expect(ev.type).toBe('error');
      expect(ev.subtype).toBe('invalid_record');
      expect(ev.line).toBe(3);
      const s = JSON.stringify(ev);
      expect(s).not.toMatch(/TypeError|\/opt\/|node:internal|stack/i);
    }
  });

  it('rejects oversized nonblank lines', () => {
    const huge = 'x'.repeat(PIPE_MAX_LINE_BYTES + 1);
    const r = classifyPipeLine(huge)!;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('malformed_json');
  });
});
