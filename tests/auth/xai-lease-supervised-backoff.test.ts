import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 2026-11-18 TokenPool grant-contract boot-crash face (waka receipt, PLAT-13371
// cmt 1296798): saki boot-crashed 3x on `Hive xAI TokenPool lease failed: ...`
// at _AgentProcess.initialize and healed on the 4th boot — a transiently
// empty/cooling xAI pool must not be a fatal process exit. The cure ports the
// PLAT-879 supervised-backoff discipline (claude-bridge Anthropic lane) to the
// gateway xAI direct lane: bounded exponential backoff + jitter, no crash-loop,
// while a genuinely absent broker stays fail-loud (config face).
//
// initialize() pulls the whole gateway stack, so these pins are contract-level:
// they assert the control-flow shape of the initialize path rather than
// spawning a real AgentProcess.

const agentProcessSource = readFileSync(
  path.resolve(__dirname, '../../src/gateway/agent-process.ts'),
  'utf8',
);

function initializeBlock(): string {
  const start = agentProcessSource.indexOf('if (isHiveDirectXaiGrokModel(this.model)) {');
  expect(start, 'xAI direct-lane block present in initialize').toBeGreaterThan(0);
  // The block ends at the matching close brace; take a generous window that
  // provably ends before the next initialize stage (provider registry setup).
  const end = agentProcessSource.indexOf('this.providerReg = new ProviderRegistry(cfg);', start);
  expect(end).toBeGreaterThan(start);
  return agentProcessSource.slice(start, end);
}

describe('xAI direct-lane lease failure is supervised, not fatal', () => {
  it('never throws the old fatal lease error for a served-but-empty pool', () => {
    const block = initializeBlock();
    expect(block).not.toContain('needs an access-only coordinator lease');
  });

  it('retries with bounded exponential backoff instead of exiting', () => {
    const block = initializeBlock();
    expect(block).toContain('PLAT-879 (xAI direct lane)');
    expect(block).toContain('staying supervised');
    // Bounded exponential backoff: floor and cap, and the wait doubles.
    expect(block).toContain('SHIZUHA_XAI_LEASE_BACKOFF_INITIAL_MS');
    expect(block).toContain('SHIZUHA_XAI_LEASE_BACKOFF_MAX_MS');
    expect(block).toContain('waitMs * 2');
  });

  it('keeps the access-only contract line — refresh tokens stay in Hive', () => {
    const block = initializeBlock();
    expect(block).toContain('refresh tokens stay in Hive');
  });

  it('a genuinely absent broker stays fail-loud (config face)', () => {
    const block = initializeBlock();
    expect(block).toContain('if (!brokerExpected())');
    expect(block).toContain('broker not configured');
  });

  it('recovery is logged with the waited duration', () => {
    const block = initializeBlock();
    expect(block).toContain('TokenPool recovered');
  });
});
