import { describe, expect, it } from 'vitest';
import { inert, isInert, MAX_INERT_FIELD } from '../src/utils/display.js';

describe('display.inert — terminal-safe rendering (SCLI-407)', () => {
  it('passes ordinary text through unchanged', () => {
    expect(inert('abc-123')).toBe('abc-123');
    expect(inert('')).toBe('');
  });

  it('neutralizes ANSI SGR ESC sequences', () => {
    expect(inert('\u001b[31mFAKE\u001b[0m')).toBe('\\x1b[31mFAKE\\x1b[0m');
  });

  it('collapses caller LF to a space (no forged line)', () => {
    expect(inert('fake\nERROR: forged-success')).toBe('fake ERROR: forged-success');
  });

  it('neutralizes CR and CRLF (no overwrite)', () => {
    expect(inert('fake\rOVERRIDDEN')).toBe('fake OVERRIDDEN');
    expect(inert('fake\r\nOVERRIDDEN')).toBe('fake OVERRIDDEN');
  });

  it('neutralizes C0/C1, bidi RLO, isolate markers, zero-width, and OSC/BEL', () => {
    expect(inert('SAFE\u0008SPOOF')).toBe('SAFE\\x08SPOOF');
    expect(inert('SAFE\u202e321DI')).toBe('SAFE\\x202e321DI');
    expect(inert('a\u2066b\u2069c')).toBe('a\\x2066b\\x2069c');
    expect(inert('x\u200by')).toBe('x\\x200by');
    expect(inert('bell\u0007')).toBe('bell\\x07');
  });

  it('preserves ordinary international Unicode (no ASCII-only regression)', () => {
    expect(inert('Mika-東京-🧪')).toBe('Mika-東京-🧪');
    expect(inert('linux-μ')).toBe('linux-μ');
  });

  it('bounds oversized fields to MAX_INERT_FIELD with an ellipsis', () => {
    const big = 'x'.repeat(10_000);
    const out = inert(big);
    expect(out.length).toBeLessThanOrEqual(MAX_INERT_FIELD);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('display.isInert — bounded ID validation gate (SCLI-407)', () => {
  it('accepts clean canonical IDs', () => {
    expect(isInert('session-abc123')).toBe(true);
    expect(isInert('Mika-東京')).toBe(true);
  });

  it('rejects control-bearing and newline payloads', () => {
    expect(isInert('\u001b[31mFAKE\u001b[0m')).toBe(false);
    expect(isInert('fake\nforged')).toBe(false);
    expect(isInert('fake\rOVERRIDDEN')).toBe(false);
    expect(isInert('SAFE\u202e321DI')).toBe(false);
  });

  it('treats traversal-shaped, oversized, and plain missing IDs as inert (bounded rendering, not rejection)', () => {
    // These are not control-bearing: they must render as inert text (via inert()),
    // and isInert should accept them so the command proceeds to the (missing) lookup.
    expect(isInert('../../etc/passwd')).toBe(true);
    expect(isInert('a'.repeat(5000))).toBe(true);
    expect(isInert('no-such-session-plain')).toBe(true);
    expect(isInert('')).toBe(true);
  });

  it('bounds traversal/oversized/normal missing IDs to MAX_INERT_FIELD when rendered', () => {
    const out = inert('../../etc/passwd');
    expect(out).toBe('../../etc/passwd');
    const big = inert('a'.repeat(5000));
    expect(big.length).toBeLessThanOrEqual(MAX_INERT_FIELD);
    expect(inert('no-such-session-plain')).toBe('no-such-session-plain');
  });
});
