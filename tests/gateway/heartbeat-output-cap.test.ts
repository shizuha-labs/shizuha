import { describe, expect, it } from 'vitest';
import { AgentProcess } from '../../src/gateway/agent-process.js';

/** 2026-08-09: the heartbeat output cap starved WORKING turns — the message
 *  source stays 'heartbeat' for the whole processing loop, so every turn ran
 *  at 4096 output tokens and thinking models truncated large Write tool calls
 *  mid-JSON ('max_tokens' incomplete turns). The cap must apply ONLY to the
 *  first (idle-check) turn; later turns mean the agent found real work. */
describe('heartbeat output cap is first-turn-only', () => {
  const call = (msg: unknown, turnIndex: number, maxOutputTokens = 32000): number =>
    (AgentProcess.prototype as any).maxOutputTokensForMessage.call(
      { maxOutputTokens }, msg, turnIndex,
    );

  it('caps only the first turn of a heartbeat message', () => {
    expect(call({ source: 'heartbeat' }, 0)).toBe(4096);
    expect(call({ source: 'heartbeat' }, 1)).toBe(32000);
    expect(call({ source: 'heartbeat' }, 7)).toBe(32000);
  });

  it('turnIndex defaults to the capped first turn for compatibility', () => {
    expect(
      (AgentProcess.prototype as any).maxOutputTokensForMessage.call(
        { maxOutputTokens: 32000 }, { source: 'heartbeat' },
      ),
    ).toBe(4096);
  });

  it('non-heartbeat messages always get the full budget', () => {
    expect(call({ source: 'connect' }, 0)).toBe(32000);
    expect(call({ source: 'cron' }, 0)).toBe(32000);
  });
});

describe('compaction validator tolerates source-shaped same-role runs (agent-kai 2026-08-09)', () => {
  const validate = (msgs: unknown[], source?: unknown[]): boolean =>
    (AgentProcess.prototype as any).validateCompactedMessages.call(
      Object.create(AgentProcess.prototype), msgs, source,
    );
  const u = (i: number) => ({ role: 'user', content: `u${i}` });
  const a = (i: number) => ({ role: 'assistant', content: `a${i}` });

  it('still rejects runs the source never had', () => {
    const source = [u(1), a(1), u(2), a(2)];
    const bad = [u(1), u(2), u(3), u(4), u(5), a(1)];
    expect(validate(bad, source)).toBe(false);
  });

  it('accepts a run that already exists in the source history', () => {
    // kai: 4 consecutive user messages (queued inbox + tool-result batches)
    // in the preserved suffix — the flat >3 gate doomed EVERY compaction and
    // the 299K summarization re-ran each turn forever.
    const source = [a(0), u(1), u(2), u(3), u(4), u(5), a(1)];
    const compacted = [u(9), a(9), u(1), u(2), u(3), u(4), u(5), a(1)];
    expect(validate(compacted, source)).toBe(true);
  });

  it('flat threshold still applies without a source', () => {
    const bad = [u(1), u(2), u(3), u(4), u(5)];
    expect(validate(bad)).toBe(false);
  });
});
