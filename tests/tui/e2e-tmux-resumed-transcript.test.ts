/**
 * A resumed session must actually SHOW its transcript.
 *
 * The source-backed viewport must keep resumed history visible without either
 * laying out the full transcript or leaking it into tmux's finite history.
 *
 * The existing tmux e2e suites went 13/13 + 2/2 green against that build, which
 * was true and useless: every case starts a FRESH session and asserts on newly
 * streamed output. None resumed a session with an existing transcript, which is
 * the only path where the bug appears — and the path operators actually use.
 *
 * The guard this replaces asserted "App.tsx imports Static", i.e. the fix
 * rather than the requirement, so it defended the bug instead of catching it.
 * This test asserts the requirement: resume a session that has content, and
 * the content is on screen. It passes for ANY render implementation that
 * works, and fails for any that blanks the pane.
 *
 * Runs in default CI whenever tmux is installed. Missing tmux in CI is a
 * failure, not an env-var skip.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  altMouseFlags,
  capture,
  captureVisible,
  ensureDistBuilt,
  historySize,
  killTmux,
  launchTmux,
  paneFlags,
  projectDir,
  resizeWindow,
  sendKeys,
  sendLiteral,
  sendWheel,
  shQuote,
  sleepMs,
  tmuxE2eDescribe,
  uniqueMarker,
  waitForPattern,
} from './helpers/tmux-e2e.js';

const NEEDLE = 'RESUMED-TRANSCRIPT-NEEDLE-8f31c2';
const HEAD_NEEDLE = 'INTERNAL-SCROLL-HEAD-2bc91a';
const MIDDLE_NEEDLE = 'INTERNAL-SCROLL-MIDDLE-56e4fd';
const TAIL_NEEDLE = 'INTERNAL-SCROLL-TAIL-f86d11';
const tempHomes: string[] = [];

function launchResume(home: string, sessionId: string, width: number, height: number, name: string) {
  return launchTmux(
    name,
    width,
    height,
    `cd ${projectDir} && HOME=${shQuote(home)} SHIZUHA_DISABLE_MCP_JSON=1 FORCE_COLOR=0 node dist/shizuha.js resume ${sessionId}`,
  );
}

afterAll(() => {
  for (const dir of tempHomes) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Seed a session with real transcript content through the app's own StateStore. */
async function seedSession(home: string): Promise<string> {
  const { StateStore } = await import('../../src/state/store.js');
  const dbPath = path.join(home, '.config', 'shizuha', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new StateStore(dbPath);
  const session = store.createSession('test-model', projectDir);
  // Enough turns that the transcript is unmistakably non-empty on screen.
  for (let i = 0; i < 6; i++) {
    store.appendMessage(session.id, {
      role: 'user', content: `probe question ${i}`, timestamp: Date.now(),
    });
    store.appendMessage(session.id, {
      role: 'assistant',
      content: i === 5 ? `answer ${i} ${NEEDLE}` : `answer ${i}`,
      timestamp: Date.now(),
    });
  }
  return session.id;
}

/** Seed the shape that caused the production lag: many large recent entries. */
async function seedLargeSession(home: string): Promise<string> {
  const { StateStore } = await import('../../src/state/store.js');
  const dbPath = path.join(home, '.config', 'shizuha', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new StateStore(dbPath);
  const session = store.createSession('test-model', projectDir);
  for (let turn = 0; turn < 32; turn++) {
    store.appendMessage(session.id, {
      role: 'user', content: `large probe question ${turn}`, timestamp: Date.now() + turn * 2,
    });
    const rows = Array.from({ length: 250 }, (_, row) => `HUGE-${turn}-${row}`);
    if (turn === 31) rows.push(NEEDLE);
    store.appendMessage(session.id, {
      role: 'assistant', content: rows.join('\n'), timestamp: Date.now() + turn * 2 + 1,
    });
  }
  return session.id;
}

async function seedScrollableSession(home: string): Promise<string> {
  const { StateStore } = await import('../../src/state/store.js');
  const dbPath = path.join(home, '.config', 'shizuha', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new StateStore(dbPath);
  const session = store.createSession('test-model', projectDir);
  const lines = Array.from({ length: 90 }, (_, row) => {
    if (row === 0) return `${HEAD_NEEDLE}  `;
    if (row === 45) return `${MIDDLE_NEEDLE}  `;
    if (row === 89) return TAIL_NEEDLE;
    // CommonMark single newlines are soft breaks and may render as spaces.
    // Use an explicit hard break so this fixture really creates 90 visual rows
    // and therefore exercises the internal viewport instead of fitting as one
    // wrapped paragraph.
    return `scrollable answer line ${row}  `;
  });
  store.appendMessage(session.id, {
    role: 'user', content: 'show the complete scrollable answer', timestamp: Date.now(),
  });
  store.appendMessage(session.id, {
    role: 'assistant', content: lines.join('\n'), timestamp: Date.now() + 1,
  });
  return session.id;
}

function percentile(sorted: number[], p: number): number {
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

tmuxE2eDescribe('TUI resumed-session transcript', () => {
  beforeAll(() => {
    ensureDistBuilt();
  }, 60_000);

  it('uses an empty tmux history and scrolls the complete transcript internally', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-internal-scroll-'));
    tempHomes.push(home);
    const sessionId = await seedScrollableSession(home);
    const { session, target } = launchResume(home, sessionId, 96, 43, 'scli-internal-scroll');
    try {
      const initial = await waitForPattern(target, new RegExp(TAIL_NEEDLE), 20_000);
      expect(paneFlags(target)).toBe('1 0 1');
      expect(initial).toContain(TAIL_NEEDLE);
      expect(initial).not.toContain(HEAD_NEEDLE);
      expect(initial).toContain('Type a message');
      const initialLines = initial.split('\n');
      const tailRow = initialLines.findIndex((line) => line.includes(TAIL_NEEDLE));
      const composerRow = initialLines.findIndex((line) => line.includes('Type a message'));
      const finalTranscriptRow = initialLines
        .slice(0, composerRow)
        .reduce((last, line, index) => line.trim().length > 0 ? index : last, -1);
      expect(tailRow).toBeGreaterThanOrEqual(0);
      expect(finalTranscriptRow).toBeGreaterThanOrEqual(tailRow);
      expect(composerRow).toBeGreaterThan(finalTranscriptRow);
      expect(
        composerRow - finalTranscriptRow,
        `conversation left ${composerRow - finalTranscriptRow - 1} blank row(s) before the composer:\n${initial}`,
      ).toBeLessThanOrEqual(3);

      sendWheel(target, 'up', 12);
      await sleepMs(400);
      const mouseScrolled = captureVisible(target);
      expect(mouseScrolled).not.toBe(initial);
      expect(mouseScrolled).toMatch(/scrollable answer line (?:1\d|2\d|3\d)/);
      expect(mouseScrolled).not.toContain(TAIL_NEEDLE);
      expect(mouseScrolled).not.toContain('[<64;20;12M');
      expect(mouseScrolled).toContain('Type a message');

      sendWheel(target, 'down', 4);
      await sleepMs(400);
      const middle = captureVisible(target);
      expect(middle).toContain(MIDDLE_NEEDLE);

      for (let i = 0; i < 3; i++) sendKeys(target, 'PageUp');
      await sleepMs(400);
      const head = captureVisible(target);
      expect(head).toContain(HEAD_NEEDLE);
      expect(head).toContain('Type a message');

      for (let i = 0; i < 6; i++) sendKeys(target, 'PageDown');
      await sleepMs(400);
      const bottom = captureVisible(target);
      expect(bottom).toContain(TAIL_NEEDLE);
      const bottomLines = bottom.split('\n');
      const tailAtBottom = bottomLines.findIndex((line) => line.includes(TAIL_NEEDLE));
      const composerAtBottom = bottomLines.findIndex((line) => line.includes('Type a message'));
      const gapBeforeWheel = composerAtBottom - tailAtBottom;

      sendWheel(target, 'down', 16);
      await sleepMs(400);
      const overscroll = captureVisible(target);
      expect(overscroll).toContain(TAIL_NEEDLE);
      expect(overscroll).toContain('Type a message');
      expect(overscroll).not.toContain('[<65;20;12M');
      const overLines = overscroll.split('\n');
      const tailAfter = overLines.findIndex((line) => line.includes(TAIL_NEEDLE));
      const composerAfter = overLines.findIndex((line) => line.includes('Type a message'));
      expect(
        composerAfter - tailAfter,
        `wheel-down at tail grew the blank gap:\n${overscroll}`,
      ).toBeLessThanOrEqual(Math.max(6, gapBeforeWheel));
      expect(historySize(target)).toBe('0');
    } finally {
      killTmux(session);
    }
  }, 60_000);

  it('restores the primary screen, cursor, and mouse mode on exit', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-screen-restore-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const restoredMarker = 'SCLI-PRIMARY-SCREEN-RESTORED';
    const { session, target } = launchTmux(
      'scli-screen-restore',
      120,
      40,
      `bash -lc 'cd ${projectDir}; HOME=${shQuote(home)} SHIZUHA_DISABLE_MCP_JSON=1 FORCE_COLOR=0 node dist/shizuha.js resume ${sessionId}; printf "${restoredMarker}\\n"; sleep 30'`,
    );
    try {
      await waitForPattern(target, /Type a message|❯/, 20_000);
      expect(altMouseFlags(target)).toBe('1 1');
      sendKeys(target, 'C-c');
      const restored = await waitForPattern(target, new RegExp(restoredMarker), 8_000);
      expect(restored).toContain(restoredMarker);
      expect(altMouseFlags(target)).toBe('0 0');
    } finally {
      killTmux(session);
    }
  }, 40_000);

  it('renders the existing transcript instead of a blank pane', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-e2e-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const { session, target } = launchResume(home, sessionId, 120, 40, 'scli-resume-e2e');
    try {
      const visible = await waitForPattern(target, new RegExp(NEEDLE), 20_000);
      const scrollback = capture(target, -300);
      const nonBlank = visible.split('\n').filter((l) => l.trim().length > 0).length;
      expect(nonBlank, `only ${nonBlank} non-blank lines ON SCREEN:\n${visible}`)
        .toBeGreaterThan(8);
      expect(visible).toContain(NEEDLE);
      if (!visible.includes(NEEDLE) && scrollback.includes(NEEDLE)) {
        throw new Error('transcript went to scrollback but never rendered on screen');
      }
    } finally {
      killTmux(session);
    }
  }, 40_000);

  it('keeps the transcript on screen while the user types, and echoes every key', async () => {
    // Two regressions in one assertion, both hit on 2026-08-04:
    //  - a render that paints once and then blanks on the next frame (Static),
    //  - a per-keystroke cost that scales with transcript length and drops keys
    //    ("t hius is s a" for "this is a").
    // Typing is what forces a re-render, so it is the right trigger for both.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-type-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const { session, target } = launchResume(home, sessionId, 120, 40, 'scli-resume-type');
    try {
      await waitForPattern(target, new RegExp(NEEDLE), 20_000);
      const typed = 'the quick brown fox';
      sendLiteral(target, typed);
      const additionalRows = ['second draft row', 'third draft row', 'fourth draft row'];
      for (const row of additionalRows) {
        sendKeys(target, 'C-j');
        sendLiteral(target, row);
      }
      const visible = await waitForPattern(target, /fourth draft row/, 8_000);
      expect(visible, `input did not echo faithfully:\n${visible}`).toContain(typed);
      for (const row of additionalRows) expect(visible).toContain(row);
      expect(visible, `transcript vanished once the user typed:\n${visible}`).toContain(NEEDLE);
    } finally {
      killTmux(session);
    }
  }, 40_000);

  it('keeps key echo bounded with a huge resumed transcript', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-latency-'));
    tempHomes.push(home);
    const sessionId = await seedLargeSession(home);
    const { session, target } = launchResume(home, sessionId, 120, 40, 'scli-resume-latency');
    try {
      await waitForPattern(target, new RegExp(NEEDLE), 20_000);
      const probe = uniqueMarker('k').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      let expected = '';
      const samples: number[] = [];
      for (const char of probe) {
        expected += char;
        const startedAt = performance.now();
        sendLiteral(target, char);
        let visible = '';
        while (performance.now() - startedAt < 2_000) {
          visible = captureVisible(target);
          if (visible.includes(expected)) break;
          await sleepMs(1);
        }
        expect(visible, `input did not echo ${expected}`).toContain(expected);
        samples.push(performance.now() - startedAt);
      }
      samples.sort((a, b) => a - b);
      const p95 = percentile(samples, 95);
      expect(p95, `huge-transcript key echo p95=${p95.toFixed(1)}ms`).toBeLessThan(75);
      expect(captureVisible(target)).toContain(NEEDLE);
    } finally {
      killTmux(session);
    }
  }, 40_000);

  it('survives a resize without losing the transcript', async () => {
    // A reflow re-renders everything; a write-once render can lose its content
    // there even when the first paint looked correct.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-resize-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const { session, target } = launchResume(home, sessionId, 120, 40, 'scli-resume-resize');
    try {
      await waitForPattern(target, new RegExp(NEEDLE), 20_000);
      resizeWindow(session, 100, 30);
      const visible = await waitForPattern(target, new RegExp(NEEDLE), 8_000);
      expect(visible, `transcript lost after resize:\n${visible}`).toContain(NEEDLE);
    } finally {
      killTmux(session);
    }
  }, 40_000);
});
