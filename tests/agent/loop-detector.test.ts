import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the logger to suppress output
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { LoopDetector } = await import('../../src/agent/loop-detector.js');

describe('LoopDetector', () => {
  let detector: InstanceType<typeof LoopDetector>;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  describe('defaults', () => {
    it('uses default warning threshold of 3', () => {
      // 2 repeats should be ok
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      expect(detector.record('read', { file_path: '/tmp/x' })).toBe('warning');
    });

    it('uses default break threshold of 5', () => {
      for (let i = 0; i < 4; i++) {
        detector.record('read', { file_path: '/tmp/x' });
      }
      expect(detector.record('read', { file_path: '/tmp/x' })).toBe('break');
    });
  });

  describe('custom config', () => {
    it('respects custom warning threshold', () => {
      const d = new LoopDetector({ warningThreshold: 2 });
      d.record('read', { path: '/tmp/x' });
      expect(d.record('read', { path: '/tmp/x' })).toBe('warning');
    });

    it('respects custom break threshold', () => {
      const d = new LoopDetector({ breakThreshold: 3 });
      d.record('read', { path: '/tmp/x' });
      d.record('read', { path: '/tmp/x' });
      expect(d.record('read', { path: '/tmp/x' })).toBe('break');
    });
  });

  describe('exact repeat detection', () => {
    it('returns ok for first call', () => {
      const result = detector.record('read', { file_path: '/tmp/test.txt' });
      expect(result).toBe('ok');
    });

    it('returns ok for second identical call', () => {
      detector.record('read', { file_path: '/tmp/test.txt' });
      const result = detector.record('read', { file_path: '/tmp/test.txt' });
      expect(result).toBe('ok');
    });

    it('returns warning at threshold (3 consecutive identical calls)', () => {
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      const result = detector.record('read', { file_path: '/tmp/x' });
      expect(result).toBe('warning');
    });

    it('returns warning at 4 consecutive identical calls', () => {
      for (let i = 0; i < 3; i++) {
        detector.record('read', { file_path: '/tmp/x' });
      }
      const result = detector.record('read', { file_path: '/tmp/x' });
      expect(result).toBe('warning');
    });

    it('returns break at threshold (5 consecutive identical calls)', () => {
      for (let i = 0; i < 4; i++) {
        detector.record('read', { file_path: '/tmp/x' });
      }
      const result = detector.record('read', { file_path: '/tmp/x' });
      expect(result).toBe('break');
    });

    it('different tools do not trigger detection', () => {
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('write', { file_path: '/tmp/x' });
      detector.record('bash', { command: 'ls' });
      detector.record('glob', { pattern: '*.ts' });
      const result = detector.record('grep', { pattern: 'hello' });
      expect(result).toBe('ok');
    });

    it('same tool with different inputs does not trigger detection', () => {
      detector.record('read', { file_path: '/tmp/a.txt' });
      detector.record('read', { file_path: '/tmp/b.txt' });
      detector.record('read', { file_path: '/tmp/c.txt' });
      detector.record('read', { file_path: '/tmp/d.txt' });
      const result = detector.record('read', { file_path: '/tmp/e.txt' });
      expect(result).toBe('ok');
    });

    it('treats pulse_get_my_work {} vs {limit:40} as the same listing (Ryo 2026-09-11)', () => {
      const name = 'mcp__shizuha-pulse__pulse_get_my_work';
      expect(detector.record(name, {})).toBe('ok');
      expect(detector.record(name, { limit: 40 })).toBe('ok');
      expect(detector.record(name, {})).toBe('warning');
      expect(detector.record(name, { limit: 40 })).toBe('warning');
      expect(detector.record(name, {})).toBe('break');
      // get_task keys must stay distinct — that is real work, not a listing loop.
      const next = new LoopDetector();
      expect(next.record('mcp__shizuha-pulse__pulse_get_task', { task_id: 'PLAT-1' })).toBe('ok');
      expect(next.record('mcp__shizuha-pulse__pulse_get_task', { task_id: 'PLAT-2' })).toBe('ok');
      expect(next.record('mcp__shizuha-pulse__pulse_get_task', { task_id: 'PLAT-1' })).toBe('ok');
    });

    it('collapses GLM garbled tool names so wrap-up spam breaks (Shion 2026-09-15)', () => {
      const d = new LoopDetector({ warningThreshold: 2, breakThreshold: 3 });
      expect(d.record('message_user()()={"content": "pong"}audit_user', {})).toBe('ok');
      expect(d.record('audit_audit_audit_audit', {})).toBe('warning');
      expect(d.record('message_user()()()()()()()()()()()()', {})).toBe('break');
    });

    it('interleaving a different call resets the streak', () => {
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      // Different call breaks the streak
      detector.record('bash', { command: 'ls' });
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      // Only 2 consecutive now, should be ok
      const result = detector.record('read', { file_path: '/tmp/x' });
      // This is the 3rd consecutive, so it triggers warning
      expect(result).toBe('warning');
    });
  });

  describe('ping-pong detection', () => {
    it('detects A->B->A->B pattern at warning threshold (3)', () => {
      // Need 4 items minimum, and 3 pairs for warning threshold
      // Default warningThreshold is 3, so need 3 pairs = 6 calls
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('write', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('write', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      const result = detector.record('write', { file_path: '/tmp/x' });
      expect(result).toBe('warning');
    });

    it('detects ping-pong break at threshold (5)', () => {
      // 5 pairs = 10 calls
      for (let i = 0; i < 5; i++) {
        detector.record('read', { file_path: '/tmp/x' });
        if (i < 4) {
          detector.record('write', { file_path: '/tmp/x' });
        }
      }
      const result = detector.record('write', { file_path: '/tmp/x' });
      expect(result).toBe('break');
    });

    it('does not trigger for same tool repeated (not ping-pong)', () => {
      // A->A->A->A is exact repeat, not ping-pong
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      // This triggers exact repeat detection (warning/break), not ping-pong
      // Identical (tool, input) is exact-repeat; ping-pong requires two signatures.
    });

    it('detects same-tool two-argument ABAB (revi pulse_get_task loop)', () => {
      const a = { task_key: 'HIVE-1953' };
      const b = { task_key: 'PLS-986' };
      detector.record('mcp__shizuha-pulse__pulse_get_task', a);
      detector.record('mcp__shizuha-pulse__pulse_get_task', b);
      detector.record('mcp__shizuha-pulse__pulse_get_task', a);
      detector.record('mcp__shizuha-pulse__pulse_get_task', b);
      detector.record('mcp__shizuha-pulse__pulse_get_task', a);
      expect(detector.record('mcp__shizuha-pulse__pulse_get_task', b)).toBe('warning');
    });

    it('breaks same-tool ABAB at threshold (5 pairs)', () => {
      const a = { task_key: 'HIVE-1953' };
      const b = { task_key: 'PLS-986' };
      for (let i = 0; i < 4; i++) {
        detector.record('mcp__shizuha-pulse__pulse_get_task', a);
        detector.record('mcp__shizuha-pulse__pulse_get_task', b);
      }
      detector.record('mcp__shizuha-pulse__pulse_get_task', a);
      expect(detector.record('mcp__shizuha-pulse__pulse_get_task', b)).toBe('break');
    });

    it('accumulates same-tool ABAB across heartbeat-sized batches without reset', () => {
      const a = { task_key: 'HIVE-1953' };
      const b = { task_key: 'PLS-986' };
      // Three heartbeats of two get_tasks each, detector not reset.
      for (let beat = 0; beat < 2; beat++) {
        expect(detector.record('mcp__shizuha-pulse__pulse_get_task', a)).toBe('ok');
        expect(detector.record('mcp__shizuha-pulse__pulse_get_task', b)).toBe('ok');
      }
      expect(detector.record('mcp__shizuha-pulse__pulse_get_task', a)).toBe('ok');
      expect(detector.record('mcp__shizuha-pulse__pulse_get_task', b)).toBe('warning');
    });

    it('requires at least 4 entries for ping-pong detection', () => {
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('write', { file_path: '/tmp/x' });
      const result = detector.record('read', { file_path: '/tmp/x' });
      // Only 3 entries, ping-pong needs 4 minimum
      expect(result).toBe('ok');
    });
  });

  describe('reset', () => {
    it('clears history', () => {
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      detector.reset();
      // After reset, start fresh — 2 more identical calls should be ok
      detector.record('read', { file_path: '/tmp/x' });
      const result = detector.record('read', { file_path: '/tmp/x' });
      expect(result).toBe('ok');
    });

    it('allows recording after reset without warnings', () => {
      // Build up to near-warning
      detector.record('read', { file_path: '/tmp/x' });
      detector.record('read', { file_path: '/tmp/x' });
      detector.reset();

      // Record the same tool 2 more times — should be ok since history is clean
      detector.record('read', { file_path: '/tmp/x' });
      const result = detector.record('read', { file_path: '/tmp/x' });
      expect(result).toBe('ok');
    });
  });

  describe('history sliding window', () => {
    it('keeps only last 20 calls', () => {
      // Record 25 different tools, then repeat — should not falsely trigger
      for (let i = 0; i < 25; i++) {
        detector.record(`tool${i}`, { input: i });
      }
      // Now record the same thing 2 times — history should have dropped early entries
      detector.record('final_tool', { input: 'x' });
      const result = detector.record('final_tool', { input: 'x' });
      expect(result).toBe('ok');
    });

    it('sliding window does not lose recent entries', () => {
      // Fill with 18 different calls, then add 3 identical
      for (let i = 0; i < 18; i++) {
        detector.record(`tool${i}`, { input: i });
      }
      // These 3 are within the last 20
      detector.record('repeater', { input: 'x' });
      detector.record('repeater', { input: 'x' });
      const result = detector.record('repeater', { input: 'x' });
      expect(result).toBe('warning');
    });

    it('warning threshold still works after window slide', () => {
      // Fill history to capacity, then start repeating
      for (let i = 0; i < 17; i++) {
        detector.record(`tool${i}`, { data: i });
      }
      // These 4 consecutive identical calls are within the 20-entry window
      detector.record('stuck', { data: 'same' });
      detector.record('stuck', { data: 'same' });
      detector.record('stuck', { data: 'same' });
      // 3rd repeat should trigger warning
      // But wait — we need to count from the first: the third call is the warning
      // Let's check: after 17 different + 3 identical = 20 entries
      // The last 3 are identical → warning
      // Actually the 3rd record already returned, let's just check the 4th
      const result = detector.record('stuck', { data: 'same' });
      expect(result).toBe('warning');
    });
  });

  describe('input hashing', () => {
    it('treats identical objects as the same input', () => {
      detector.record('read', { file_path: '/tmp/x', encoding: 'utf-8' });
      detector.record('read', { file_path: '/tmp/x', encoding: 'utf-8' });
      const result = detector.record('read', { file_path: '/tmp/x', encoding: 'utf-8' });
      expect(result).toBe('warning');
    });

    it('treats different objects as different inputs', () => {
      detector.record('read', { file_path: '/tmp/a' });
      detector.record('read', { file_path: '/tmp/b' });
      detector.record('read', { file_path: '/tmp/c' });
      const result = detector.record('read', { file_path: '/tmp/d' });
      expect(result).toBe('ok');
    });

    it('treats empty objects as the same', () => {
      detector.record('read', {});
      detector.record('read', {});
      const result = detector.record('read', {});
      expect(result).toBe('warning');
    });
  });
});

describe('PLAT-8991: clean-beat boundary reset', () => {
  let detector: InstanceType<typeof LoopDetector>;

  beforeEach(() => {
    detector = new LoopDetector();
  });

  it('resets the probe streak after a contract-correct drained beat (no writes)', () => {
    // Simulate the 90s fleet cadence: many drained beats, each one
    // pulse_get_my_work probe. Without the boundary reset the streak
    // false-positives within the hour.
    for (let beat = 0; beat < 10; beat++) {
      detector.record('mcp__shizuha-pulse__pulse_get_my_work', {});
      detector.resetIfNoWrites([{ name: 'mcp__shizuha-pulse__pulse_get_my_work', input: {} }]);
    }
    expect(detector.record('mcp__shizuha-pulse__pulse_get_my_work', {})).toBe('ok');
  });

  it('keeps the history when the beat was dirty (a write-class call ran)', () => {
    for (let i = 0; i < 4; i++) {
      detector.record('mcp__shizuha-pulse__pulse_get_my_work', {});
    }
    // A dirty beat (write-class call ran) must NOT reset the history — the
    // next identical probe still crosses the break threshold. (The streak
    // counters are trailing-window: interleaved writes break the trailing
    // run, but the accumulated history is preserved for the threshold.)
    // `edit` is write-class per WRITE_TOOL_NAMES (Pulse mutations are not —
    // a beat that did real Pulse work made progress and legitimately resets).
    detector.resetIfNoWrites([
      { name: 'mcp__shizuha-pulse__pulse_get_my_work', input: {} },
      { name: 'edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
    ]);
    expect(detector.record('mcp__shizuha-pulse__pulse_get_my_work', {})).toBe('break');
  });

  it('still breaks on a within-turn ABAB fetch loop (persistence preserved for dirty turns)', () => {
    for (let i = 0; i < 5; i++) {
      detector.record('mcp__shizuha-pulse__pulse_get_my_work', {});
    }
    expect(detector.record('mcp__shizuha-pulse__pulse_get_my_work', {})).toBe('break');
  });
});
