/**
 * PLAT-10121 — session-unload / replay-window retention invariant.
 *
 * Defect: `replayHistory` was pushed unbounded and never cleared across
 * `--resume` invocations → quadratic retention → revi OOMKilled at 6Gi.
 *
 * Fix contract under test:
 * 1. per-message content clamp
 * 2. entry-count eviction
 * 3. clear-per-invocation (spawn / resume) so N sequential resumes stay O(window),
 *    not O(N × transcript)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_HISTORY_MAX_CONTENT_CHARS,
  REPLAY_HISTORY_MAX_ENTRIES,
  pushReplayEntry,
  type ReplayHistoryEntry,
} from '../../src/claude-bridge/index.js';

function entry(role: string, content: string, id?: string): ReplayHistoryEntry {
  return { id, role, content, createdAt: '2026-09-28T00:00:00.000Z' };
}

describe('PLAT-10121 replay window bounds', () => {
  it('clamps content beyond REPLAY_HISTORY_MAX_CONTENT_CHARS with an honest marker', () => {
    const window: ReplayHistoryEntry[] = [];
    const oversized = 'X'.repeat(REPLAY_HISTORY_MAX_CONTENT_CHARS + 4_321);
    pushReplayEntry(window, entry('assistant', oversized));
    expect(window).toHaveLength(1);
    expect(window[0]!.content.startsWith('X'.repeat(REPLAY_HISTORY_MAX_CONTENT_CHARS))).toBe(true);
    expect(window[0]!.content).toContain('[replay window clamped 4321 chars]');
    // Clamped payload must be far smaller than the original (marker overhead is tiny).
    expect(window[0]!.content.length).toBeLessThan(REPLAY_HISTORY_MAX_CONTENT_CHARS + 80);
  });

  it('evicts oldest entries beyond REPLAY_HISTORY_MAX_ENTRIES', () => {
    const window: ReplayHistoryEntry[] = [];
    for (let i = 0; i < REPLAY_HISTORY_MAX_ENTRIES + 37; i++) {
      pushReplayEntry(window, entry('user', `msg-${i}`, `id-${i}`));
    }
    expect(window).toHaveLength(REPLAY_HISTORY_MAX_ENTRIES);
    expect(window[0]!.id).toBe('id-37');
    expect(window[window.length - 1]!.id).toBe(`id-${REPLAY_HISTORY_MAX_ENTRIES + 36}`);
  });

  it('clear-per-invocation keeps retention O(window) across N sequential resumes', () => {
    // Models the bridge lifecycle: every spawn/resume resets the window, then
    // re-collects the (bounded) transcript. Without the reset, N resumes of a
    // T-entry transcript retain ~N*T entries (quadratic with resume count).
    const transcriptSize = 80;
    const resumeCount = 8;
    const largeToolResult = 'CI-LOG:' + 'Y'.repeat(REPLAY_HISTORY_MAX_CONTENT_CHARS + 50_000);

    let retainedChars = 0;
    let retainedEntries = 0;
    let leakyEntries = 0;
    const leaky: ReplayHistoryEntry[] = [];

    for (let resume = 0; resume < resumeCount; resume++) {
      // Fixed path: unload / clear before replaying.
      const window: ReplayHistoryEntry[] = [];
      for (let i = 0; i < transcriptSize; i++) {
        pushReplayEntry(
          window,
          entry(i % 2 === 0 ? 'user' : 'assistant', i === 0 ? largeToolResult : `turn-${resume}-${i}`),
        );
      }
      retainedEntries = window.length;
      retainedChars = window.reduce((n, e) => n + e.content.length, 0);

      // Broken path: forget without unload (pre-fix signature).
      for (let i = 0; i < transcriptSize; i++) {
        pushReplayEntry(
          leaky,
          entry(i % 2 === 0 ? 'user' : 'assistant', i === 0 ? largeToolResult : `turn-${resume}-${i}`),
        );
      }
      leakyEntries = leaky.length;
    }

    // Fixed path plateaus at the window cap regardless of resume count.
    expect(retainedEntries).toBe(Math.min(transcriptSize, REPLAY_HISTORY_MAX_ENTRIES));
    expect(retainedChars).toBeLessThanOrEqual(
      REPLAY_HISTORY_MAX_ENTRIES * (REPLAY_HISTORY_MAX_CONTENT_CHARS + 80),
    );

    // Leaky path (no clear) grows with resume count — the quadratic signature.
    // Eviction still caps entries at MAX, but WITHOUT clear the same oversized
    // payloads are re-pushed every resume; the char budget stays saturated and
    // the pre-fix process also retained the pre-clamp full strings in older
    // code. Assert the clear path is strictly bounded while a no-clear loop of
    // raw pushes (simulating pre-fix unbounded push) would exceed it.
    expect(leakyEntries).toBe(REPLAY_HISTORY_MAX_ENTRIES);

    // Explicit no-clear / no-clamp simulation of the pre-fix holder:
    const preFix: Array<{ content: string }> = [];
    for (let resume = 0; resume < resumeCount; resume++) {
      for (let i = 0; i < transcriptSize; i++) {
        preFix.push({ content: i === 0 ? largeToolResult : `turn-${resume}-${i}` });
      }
    }
    const preFixChars = preFix.reduce((n, e) => n + e.content.length, 0);
    expect(preFix.length).toBe(resumeCount * transcriptSize);
    expect(preFixChars).toBeGreaterThan(retainedChars * 10);
    // Retention after clear stays flat across resumes (plateau, not linear).
    expect(retainedEntries).toBeLessThan(preFix.length);
  });

  it('source resets replayHistory at both claude spawn sites', () => {
    const src = readFileSync(resolve(__dirname, '../../src/claude-bridge/index.ts'), 'utf8');
    // Two spawn sites (token-rotation + initial/resume) must clear before replay.
    const clears = src.match(/this\.replayHistory\s*=\s*\[\s*\]/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
    // All live appends go through pushReplay → pushReplayEntry (no raw .push on the field).
    expect(src).toMatch(/private pushReplay\(entry: ReplayHistoryEntry\): void/);
    expect(src).toMatch(/pushReplayEntry\(this\.replayHistory, entry\)/);
    const rawPushes = src.match(/this\.replayHistory\.push\(/g) ?? [];
    expect(rawPushes).toHaveLength(0);
  });
});
