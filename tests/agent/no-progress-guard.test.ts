import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { NoProgressGuard } = await import('../../src/agent/tool-loop-guard.js');

type Guard = InstanceType<typeof NoProgressGuard>;

function makeCall(name: string, input: Record<string, unknown> = {}) {
  return { id: 'tc1', name, input };
}

describe('NoProgressGuard', () => {
  describe('empty toolCalls (text-only turn)', () => {
    it('returns ok and resets counter', () => {
      const g: Guard = new NoProgressGuard(3);
      const tc = makeCall('read', { file_path: '/x' });
      g.record([tc]); // first occurrence — new
      g.record([tc]); // seen → noProgressTurns=1
      g.record([tc]); // seen → noProgressTurns=2
      // text-only turn should reset
      expect(g.record([])).toBe('ok');
      expect(g.turnsWithoutProgress).toBe(0);
    });

    it('never triggers stuck on back-to-back text-only turns', () => {
      const g: Guard = new NoProgressGuard(2);
      for (let i = 0; i < 10; i++) {
        expect(g.record([])).toBe('ok');
      }
    });
  });

  describe('new tool calls (progress)', () => {
    it('returns ok when new calls appear each turn', () => {
      const g: Guard = new NoProgressGuard(3);
      expect(g.record([makeCall('read', { file_path: '/a' })])).toBe('ok');
      expect(g.record([makeCall('read', { file_path: '/b' })])).toBe('ok');
      expect(g.record([makeCall('glob', { pattern: '*.ts' })])).toBe('ok');
    });

    it('resets counter when a new call appears', () => {
      const g: Guard = new NoProgressGuard(3);
      const old = makeCall('read', { file_path: '/x' });
      g.record([old]); // new → seenSigs.add, noProgressTurns=0
      g.record([old]); // allSeen → noProgressTurns=1
      // new call → noProgressTurns resets to 0
      g.record([makeCall('read', { file_path: '/y' })]);
      expect(g.turnsWithoutProgress).toBe(0);
    });
  });

  describe('stuck detection (alternating already-seen sets)', () => {
    it('returns stuck after threshold consecutive all-seen turns', () => {
      const g: Guard = new NoProgressGuard(3);
      const a = makeCall('read', { file_path: '/a' });
      const b = makeCall('read', { file_path: '/b' });
      g.record([a]); // new
      g.record([b]); // new
      g.record([a]); // allSeen → noProgressTurns=1 → ok
      g.record([b]); // allSeen → noProgressTurns=2 → ok
      expect(g.record([a])).toBe('stuck'); // noProgressTurns=3 ≥ threshold
    });

    it('turnsWithoutProgress reflects the count', () => {
      const g: Guard = new NoProgressGuard(5);
      const tc = makeCall('read', { file_path: '/x' });
      g.record([tc]); // new
      g.record([tc]); // 1
      g.record([tc]); // 2
      expect(g.turnsWithoutProgress).toBe(2);
    });

    it('key-stable: {a:1,b:2} and {b:2,a:1} are the same signature', () => {
      const g: Guard = new NoProgressGuard(2);
      g.record([makeCall('write', { a: 1, b: 2 })]); // adds sig
      // same content, different key order — should be seen (key-stable)
      expect(g.record([makeCall('write', { b: 2, a: 1 })])).toBe('ok'); // noProgressTurns=1, not stuck yet
      expect(g.turnsWithoutProgress).toBe(1);
    });
  });

  describe('threshold=1 (aggressive)', () => {
    it('stucks on the first repeat', () => {
      const g: Guard = new NoProgressGuard(1);
      const tc = makeCall('bash', { command: 'ls' });
      expect(g.record([tc])).toBe('ok'); // new
      expect(g.record([tc])).toBe('stuck'); // allSeen, noProgressTurns=1 ≥ 1
    });
  });
});
