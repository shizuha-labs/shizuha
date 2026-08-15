import { describe, expect, it, vi } from 'vitest';

import type { LLMProvider } from '../../src/provider/types.js';
import { AgentProcess } from '../../src/gateway/agent-process.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Warmups retired fleet-wide (operator 2026-08-07): a warmup racing the real
// turn re-prefilled the OLD home for 190s before being superseded (agent-sato),
// and the gateway's view of "home" can lag the router's rehome decisions, so a
// warmup can rebuild the wrong lane entirely. The mechanism survives ONLY
// behind SHIZUHA_PREWARM_ENABLE=1.
describe('prewarm retirement (default off)', () => {
  it('runPrewarmPrefixCache is a no-op success without the escape hatch', async () => {
    delete process.env.SHIZUHA_PREWARM_ENABLE;
    const chat = vi.fn();
    const provider = { name: 'cortex', chat } as unknown as LLMProvider;
    const harness = {
      messages: [{ role: 'user', content: 'x'.repeat(200_000) }],
      model: 'DeepSeek-V4-Flash',
      provider,
      systemPrompt: 'sys',
      toolDefs: [],
      maxContextTokens: 524_288,
      sessionId: 'sess-1',
      lastProviderPrefixSnapshot: null,
      cortexFirstTurnPrewarmPending: false,
      lastCortexPrewarmAt: 0,
    };
    const run = (AgentProcess.prototype as any).runPrewarmPrefixCache;
    const ok = await run.call(harness, harness.model, provider, { reason: 'restart' });
    expect(ok).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(harness.lastCortexPrewarmAt).toBe(0);
  });
});
