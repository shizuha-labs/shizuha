/**
 * A mid-response transport drop after tokens have arrived must RETRY
 * (operator 2026-08-10 / 2026-08-15). Cortex same-session supersede
 * cancels the abandoned upstream. Fail-closed salvage is what stranded
 * shizuha1: 348 tokens + a completed tool call, red banner, no replay.
 *
 * shizuha1, 2026-08-05. Operator, after finding the session idle:
 *
 *   it is hard to imagine that such an intelligent model wouldn't do a tool
 *   call here .. investigate this in great detail .. assume that something else
 *   may have gone wrong instead of blaming that the model did not return a tool
 *   call .. it could be a cortex initiated interruption as well
 *
 * The operator was right. Cortex's UsageRecord for the request shows
 * `client_disconnect` at 1037 completion tokens — the SERVER was still
 * decoding. Client-side: TTFT 1.8s, ~700 tokens streamed, then the chunk
 * stream went silent until STREAM_STALL_MS fired. The provider's salvage path
 * then yielded the partial text as a completed turn with reason 'stop',
 * betting the loop's thinking-only recovery would re-prompt — and that
 * recovery refused the 2,720-char narration (the old 700-char classifier
 * cliff). Two designed mechanisms composed into a 55-minute silent stall.
 *
 * The fix has two halves, both pinned here at the source level:
 *  - the provider yields a DISTINCT reason ('stall_salvage'), so downstream
 *    can tell a half-turn from a real stop without text classification;
 *  - every loop marks it incomplete and refuses automatic replay.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const vllmSrc = fs.readFileSync(
  path.resolve(import.meta.dirname!, '../../src/provider/vllm.ts'), 'utf-8',
);

describe('the provider distinguishes a salvaged half-turn', () => {
  it("yields reason 'stall_salvage', not a plain 'stop'", () => {
    const start = vllmSrc.lastIndexOf('if (stallRecovered) {');
    const block = vllmSrc.slice(start, vllmSrc.indexOf('const finalInputTokens', start));
    expect(block).toContain("reason: 'stall_salvage'");
    expect(
      block,
      "a salvaged turn masquerading as reason 'stop' is what made the "
        + 'half-turn indistinguishable downstream',
    ).not.toContain("reason: 'stop' }");
  });
});

describe('the provider retries a mid-response transport drop', () => {
  it('throws retryable instead of salvaging a half-turn as terminal', () => {
    expect(vllmSrc).toContain("code: 'stream_interrupted_retrying'");
    expect(vllmSrc).toContain('mid-response transport drop');
    expect(vllmSrc).toContain('replaying the turn (supersede protects upstream)');
    const dropAt = vllmSrc.indexOf('stream dropped after partial output');
    const dropBlock = vllmSrc.slice(dropAt, dropAt + 1800);
    expect(dropBlock).toContain('retryable = true');
    expect(dropBlock).toContain('throw err');
    expect(dropBlock).not.toContain('refusing automatic replay');
  });
});

describe('truncated (max_tokens) tool calls stay dropped; stall ones do not', () => {
  const turnSrc = fs.readFileSync(
    path.resolve(import.meta.dirname!, '../../src/agent/turn.ts'), 'utf-8',
  );
  it('only drops tool calls on max_tokens, not stall_salvage', () => {
    expect(turnSrc).toContain("stopReason === 'max_tokens' && toolCalls.length > 0");
    expect(turnSrc).not.toContain("stopReason === 'stall_salvage' || stopReason === 'max_tokens'");
  });
});
