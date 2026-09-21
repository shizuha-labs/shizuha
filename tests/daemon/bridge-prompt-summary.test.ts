/**
 * SCLI-546: claude-bridge startup summary must never disclose prompt text.
 *
 * The startup summary previously serialized `firstLine` of the --context-prompt
 * into ordinary bridge logs (QA found a 65,536-byte single-line prompt
 * amplified one log line by 65 KiB, and prompt content reached every log sink).
 * Now it emits only non-sensitive metadata: present, bounded length, a boolean
 * identity-header flag, and a one-way SHA-256 digest.
 */
import { describe, expect, it } from 'vitest';
import { summarizePromptForLog } from '../../src/claude-bridge/index.js';

const MARKER = 'QA_MARKER_ASCII';

describe('summarizePromptForLog (SCLI-546)', () => {
  it('never discloses prompt text or first-line content', () => {
    const summary = summarizePromptForLog(`First line ${MARKER}\nsecond line\nthird`);
    expect(summary.present).toBe(true);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.hasIdentityHeader).toBe(false);
    // The marker must not appear anywhere in the summary (no firstLine, no
    // escaped controls, no prefix).
    expect(JSON.stringify(summary)).not.toContain(MARKER);
    expect(JSON.stringify(summary)).not.toContain('First line');
    expect('firstLine' in summary).toBe(false);
  });

  it('emits a one-way SHA-256 digest (64 hex chars) instead of content', () => {
    const summary = summarizePromptForLog(MARKER);
    expect(typeof summary.digest).toBe('string');
    expect((summary.digest as string).length).toBe(64);
    expect((summary.digest as string)).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic for the same input.
    expect(summarizePromptForLog(MARKER).digest).toBe(summary.digest);
  });

  it('stays bounded for a 65 KiB single-line prompt', () => {
    const big = MARKER + 'x'.repeat(65_536);
    const summary = summarizePromptForLog(big);
    expect(summary.length).toBe(big.length);
    // The serialized record stays tiny — no prompt content, just a 64-char digest.
    const serialized = JSON.stringify(summary);
    expect(serialized.length).toBeLessThan(300);
    expect(serialized).not.toContain(MARKER);
  });

  it('reports present=false and digest=null for empty/blank prompts', () => {
    expect(summarizePromptForLog('')).toEqual({
      present: false, length: 0, hasIdentityHeader: false, digest: null,
    });
    expect(summarizePromptForLog('   \n  ')).toEqual({
      present: false, length: 0, hasIdentityHeader: false, digest: null,
    });
    expect(summarizePromptForLog(null)).toEqual({
      present: false, length: 0, hasIdentityHeader: false, digest: null,
    });
    expect(summarizePromptForLog(undefined)).toEqual({
      present: false, length: 0, hasIdentityHeader: false, digest: null,
    });
  });

  it('still reports the identity-header boolean accurately', () => {
    const summary = summarizePromptForLog('## Shizuha Agent Identity\nsecret body');
    expect(summary.hasIdentityHeader).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('secret body');
  });
});
