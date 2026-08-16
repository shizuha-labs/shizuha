import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentProcess } from '../../src/gateway/agent-process.js';
import type { ChatMessage } from '../../src/provider/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Operator 2026-08-08: restart re-serialization must be provably identical.
// The gateway persists the exact payload sent (captureProviderWirePayload)
// and every history rewrite invalidates it through the replaceMessages
// choke-point.

const wire = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` } as ChatMessage));

function makeHarness() {
  const saved: Array<{ sessionId: string; sourceCount: number; json: string }> = [];
  return {
    saved,
    harness: {
      sessionId: 'agent-session-x',
      providerWirePrefix: null as null | { sourceCount: number; messages: ChatMessage[] },
      store: {
        saveWirePrefix: vi.fn((sessionId: string, sourceCount: number, json: string) => {
          saved.push({ sessionId, sourceCount, json });
        }),
      },
    },
  };
}

const capture = (h: unknown, cm: ChatMessage[], n: number) =>
  (AgentProcess.prototype as unknown as {
    captureProviderWirePayload: (cm: ChatMessage[], n: number) => void;
  }).captureProviderWirePayload.call(h, cm, n);

describe('gateway wire-prefix capture and invalidation', () => {
  beforeEach(() => { delete process.env['SHIZUHA_WIRE_PREFIX_RESUME']; });

  it('capture persists the exact payload bytes and updates the in-process prefix', () => {
    const { harness, saved } = makeHarness();
    const payload = wire(3);
    capture(harness, payload, 3);
    expect(harness.providerWirePrefix).toEqual({ sourceCount: 3, messages: payload });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.json).toBe(JSON.stringify(payload));
    expect(JSON.parse(saved[0]!.json)).toEqual(payload);
  });

  it('is disabled by SHIZUHA_WIRE_PREFIX_RESUME=0', () => {
    process.env['SHIZUHA_WIRE_PREFIX_RESUME'] = '0';
    const { harness, saved } = makeHarness();
    capture(harness, wire(2), 2);
    expect(harness.providerWirePrefix).toBeNull();
    expect(saved).toHaveLength(0);
  });

  it('a store failure never breaks the turn', () => {
    const { harness } = makeHarness();
    harness.store.saveWirePrefix = vi.fn(() => { throw new Error('disk'); });
    expect(() => capture(harness, wire(2), 2)).not.toThrow();
  });
});
