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
 * Requires: tmux, SHIZUHA_RUN_TMUX_RENDER_E2E=1
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const projectDir = path.resolve(import.meta.dirname!, '../..');
const NEEDLE = 'RESUMED-TRANSCRIPT-NEEDLE-8f31c2';
const HEAD_NEEDLE = 'INTERNAL-SCROLL-HEAD-2bc91a';
const MIDDLE_NEEDLE = 'INTERNAL-SCROLL-MIDDLE-56e4fd';
const TAIL_NEEDLE = 'INTERNAL-SCROLL-TAIL-f86d11';

function hasTmux(): boolean {
  try {
    execSync('tmux -V', { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

const run = hasTmux() && process.env['SHIZUHA_RUN_TMUX_RENDER_E2E'] === '1';
const tempHomes: string[] = [];

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

describe.skipIf(!run)('TUI resumed-session transcript', () => {
  it('uses an empty tmux history and scrolls the complete transcript internally', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-internal-scroll-'));
    tempHomes.push(home);
    const sessionId = await seedScrollableSession(home);
    const sessionName = `scli-internal-scroll-${process.pid}`;

    execFileSync('tmux', [
      // Match the operator's shizuha1/shizuha2 panes exactly.
      'new-session', '-d', '-s', sessionName, '-x', '96', '-y', '43',
      `cd ${projectDir} && HOME=${home} node dist/shizuha.js resume ${sessionId} 2>/dev/null`,
    ]);
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      const paneState = execFileSync('tmux', [
        'display-message', '-p', '-t', sessionName,
        '#{alternate_on} #{history_size} #{mouse_any_flag}',
      ], { encoding: 'utf-8' }).trim();
      expect(paneState).toBe('1 0 1');

      const initial = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
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

      // Ink strips the leading ESC before useInput; this raw tmux path proves
      // the real SGR mouse report is decoded and does not enter the composer.
      for (let i = 0; i < 12; i++) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', '\x1b[<64;20;12M']);
      }
      await new Promise((r) => setTimeout(r, 500));
      const mouseScrolled = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      // Wheel decoding/viewport geometry may land a few rows apart across tmux
      // versions. Assert that we moved into the earlier third of the transcript
      // instead of pinning the test to one incidental top-row number.
      expect(mouseScrolled).toMatch(/scrollable answer line (?:1\d|2\d|3\d)/);
      expect(mouseScrolled).not.toContain(TAIL_NEEDLE);
      expect(mouseScrolled).not.toContain('[<64;20;12M');
      expect(mouseScrolled).toContain('Type a message');

      for (let i = 0; i < 4; i++) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', '\x1b[<65;20;12M']);
      }
      await new Promise((r) => setTimeout(r, 500));
      const middle = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      expect(middle).toContain(MIDDLE_NEEDLE);

      for (let i = 0; i < 3; i++) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, 'PageUp']);
      }
      await new Promise((r) => setTimeout(r, 500));
      const head = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      expect(head).toContain(HEAD_NEEDLE);
      expect(head).toContain('Type a message');

      for (let i = 0; i < 6; i++) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, 'PageDown']);
      }
      await new Promise((r) => setTimeout(r, 500));
      const bottom = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      expect(bottom).toContain(TAIL_NEEDLE);
      const historyAfter = execFileSync('tmux', [
        'display-message', '-p', '-t', sessionName, '#{history_size}',
      ], { encoding: 'utf-8' }).trim();
      expect(historyAfter).toBe('0');
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  }, 120_000);

  it('restores the primary screen, cursor, and mouse mode on exit', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-screen-restore-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const sessionName = `scli-screen-restore-${process.pid}`;
    const restoredMarker = 'SCLI-PRIMARY-SCREEN-RESTORED';

    execFileSync('tmux', [
      'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40',
      `bash -lc 'cd ${projectDir}; HOME=${home} node dist/shizuha.js resume ${sessionId} 2>/dev/null; printf "${restoredMarker}\\n"; sleep 30'`,
    ]);
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      const active = execFileSync('tmux', [
        'display-message', '-p', '-t', sessionName, '#{alternate_on} #{mouse_any_flag}',
      ], { encoding: 'utf-8' }).trim();
      expect(active).toBe('1 1');

      execFileSync('tmux', ['send-keys', '-t', sessionName, 'C-c']);
      let restored = '';
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        restored = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
          encoding: 'utf-8',
        });
        if (restored.includes(restoredMarker)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(restored).toContain(restoredMarker);
      const inactive = execFileSync('tmux', [
        'display-message', '-p', '-t', sessionName, '#{alternate_on} #{mouse_any_flag}',
      ], { encoding: 'utf-8' }).trim();
      expect(inactive).toBe('0 0');
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  }, 120_000);

  it('renders the existing transcript instead of a blank pane', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-e2e-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const sessionName = `scli-resume-${process.pid}`;

    execFileSync('tmux', [
      'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40',
      `cd ${projectDir} && HOME=${home} node dist/shizuha.js resume ${sessionId} 2>/dev/null`,
    ]);
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      // VISIBLE pane only — no -S. This distinction is the whole test.
      // The first version of this test captured with `-S -300`, which includes
      // tmux SCROLLBACK, and therefore passed against the broken build: Ink's
      // <Static> had written the transcript into scrollback while leaving the
      // screen empty. The operator's report was "i see nothing", i.e. about the
      // visible pane. Assert on what a human is actually looking at.
      const visible = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      const scrollback = execFileSync(
        'tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-300'], { encoding: 'utf-8' },
      );

      const nonBlank = visible.split('\n').filter((l) => l.trim().length > 0).length;
      // A blank pane still carries header + input box + status bar (~4 lines);
      // the regression produced exactly that and nothing else.
      expect(nonBlank, `only ${nonBlank} non-blank lines ON SCREEN:\n${visible}`)
        .toBeGreaterThan(8);
      expect(visible, 'seeded transcript must be ON SCREEN after resume, not just in scrollback')
        .toContain(NEEDLE);
      // Sanity: if the needle is in scrollback but not on screen, that is the
      // exact failure mode — make the message say so rather than just "missing".
      if (!visible.includes(NEEDLE) && scrollback.includes(NEEDLE)) {
        throw new Error('transcript went to scrollback but never rendered on screen');
      }
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  }, 120_000);

  it('keeps the transcript on screen while the user types, and echoes every key', async () => {
    // Two regressions in one assertion, both hit on 2026-08-04:
    //  - a render that paints once and then blanks on the next frame (Static),
    //  - a per-keystroke cost that scales with transcript length and drops keys
    //    ("t hius is s a" for "this is a").
    // Typing is what forces a re-render, so it is the right trigger for both.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-type-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const sessionName = `scli-resume-type-${process.pid}`;

    execFileSync('tmux', [
      'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40',
      `cd ${projectDir} && HOME=${home} node dist/shizuha.js resume ${sessionId} 2>/dev/null`,
    ]);
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      const typed = 'the quick brown fox';
      for (const ch of typed) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, ch === ' ' ? 'Space' : ch]);
      }
      const additionalRows = ['second draft row', 'third draft row', 'fourth draft row'];
      for (const row of additionalRows) {
        execFileSync('tmux', ['send-keys', '-t', sessionName, 'C-j']);
        execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', row]);
      }
      await new Promise((r) => setTimeout(r, 2_500));
      const visible = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });

      // Every character arrived, in order — no drops, no reordering.
      expect(visible, `input did not echo faithfully:\n${visible}`).toContain(typed);
      for (const row of additionalRows) expect(visible).toContain(row);
      // ...and the transcript is STILL on screen after the re-render.
      expect(visible, `transcript vanished once the user typed:\n${visible}`)
        .toContain(NEEDLE);
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  }, 120_000);

  it('keeps key echo bounded with a huge resumed transcript', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-latency-'));
    tempHomes.push(home);
    const sessionId = await seedLargeSession(home);
    const sessionName = `scli-resume-latency-${process.pid}`;

    execFileSync('tmux', [
      'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40',
      `cd ${projectDir} && HOME=${home} node dist/shizuha.js resume ${sessionId} 2>/dev/null`,
    ]);
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      const probe = 'K7mQ2vN9xR4pL8sT';
      let expected = '';
      const samples: number[] = [];
      for (const char of probe) {
        expected += char;
        const startedAt = performance.now();
        execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', char]);
        let visible = '';
        while (performance.now() - startedAt < 2_000) {
          visible = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
            encoding: 'utf-8',
          });
          if (visible.includes(expected)) break;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(visible, `input did not echo ${expected}`).toContain(expected);
        samples.push(performance.now() - startedAt);
      }

      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);
      console.log(`huge resumed transcript key echo: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
      // tmux send/capture process startup dominates this black-box gate. The
      // in-process bench enforces the few-ms renderer target; this catches the
      // old 0.7s transcript-length regression from the operator's vantage.
      expect(p95, `huge-transcript key echo p95=${p95.toFixed(1)}ms`).toBeLessThan(75);
      const visible = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      expect(visible).toContain(NEEDLE);
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  }, 120_000);

  it('survives a resize without losing the transcript', async () => {
    // A reflow re-renders everything; a write-once render can lose its content
    // there even when the first paint looked correct.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-resume-resize-'));
    tempHomes.push(home);
    const sessionId = await seedSession(home);
    const sessionName = `scli-resume-resize-${process.pid}`;

    execFileSync('tmux', [
      'new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40',
      `cd ${projectDir} && HOME=${home} node dist/shizuha.js resume ${sessionId} 2>/dev/null`,
    ]);
    try {
      await new Promise((r) => setTimeout(r, 12_000));
      execFileSync('tmux', ['resize-window', '-t', sessionName, '-x', '100', '-y', '30']);
      await new Promise((r) => setTimeout(r, 3_000));
      const visible = execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
        encoding: 'utf-8',
      });
      expect(visible, `transcript lost after resize:\n${visible}`).toContain(NEEDLE);
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  }, 120_000);
});
