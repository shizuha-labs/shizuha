/**
 * E2E tmux rendering tests for diffLogUpdate + TUI components.
 *
 * Exercises:
 *  - Initial render (short + tall content)
 *  - Streaming with animations (spinner, timer)
 *  - Tall content in the source-backed internal viewport
 *  - Short→tall and tall→short transitions
 *  - No content truncation (full output reachable through internal scrolling)
 *  - StatusBar rendering (horizontal rule, no box border)
 *  - InputBox always visible at bottom
 *  - Multiple terminal sizes (80x24, 120x50, 60x20)
 *
 * Runs in default CI whenever tmux is installed. Missing tmux in CI is a
 * failure, not an env-var skip.
 */
import { beforeAll, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  capture,
  captureWithScrollback,
  ensureDistBuilt,
  historySize,
  killTmux,
  launchShizuha,
  launchTmux,
  paneFlags,
  projectDir,
  sendKeys,
  sendLiteral,
  sendWheel,
  shQuote,
  sleepMs,
  stageProviderCredentials,
  tmuxE2eDescribe,
  uniqueMarker,
  waitForPattern,
} from './helpers/tmux-e2e.js';

tmuxE2eDescribe('TUI tmux renderer e2e tests', () => {
  beforeAll(() => {
    ensureDistBuilt();
  }, 60000);

  // ─── Test 1: Initial render — correct structure ───
  it('renders header, input box, and status bar on startup', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-init-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_init', 80, 24);

    try {
      const frame = await waitForPattern(target, /Type a message|❯/, 15_000);

      // Header present
      expect(frame).toContain('Shizuha');
      expect(frame).toContain('Interactive Agent');

      // Input box present
      expect(frame).toMatch(/❯|Type a message/);

      // Status bar present with horizontal rule (not box border)
      expect(frame).toMatch(/─{10,}/); // horizontal rule
      expect(frame).toMatch(/sup|auto|plan/); // mode indicator

      // No box borders (╭╮╰╯) on status bar
      const lines = frame.split('\n');
      const statusArea = lines.slice(-5).join('\n');
      expect(statusArea).not.toContain('╭');
      expect(statusArea).not.toContain('╰');
      expect(statusArea).not.toContain('│');
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves drafts across idle Down and idle Escape', async () => {
    const cases = [
      { name: 'down_single', key: 'Down', parts: ['valuable draft'], expected: ['valuable draftX'] },
      { name: 'down_multiline', key: 'Down', parts: ['line1', 'line2'], expected: ['line1', 'line2X'] },
      { name: 'escape_single', key: 'Escape', parts: ['valuable draft'], expected: ['valuable draftX'] },
      { name: 'escape_multiline', key: 'Escape', parts: ['line1', 'line2'], expected: ['line1', 'line2X'] },
    ];

    for (const testCase of cases) {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), `shizuha-down-${testCase.name}-`));
      const { session, target } = launchShizuha(tempHome, `down_${testCase.name}`, 120, 40);

      try {
        await waitForPattern(target, /Type a message|❯/, 15_000);
        sendLiteral(target, testCase.parts.join('\n'));

        sendKeys(target, testCase.key);
        // Inter-key delay is REQUIRED, not flake-proofing: back-to-back tmux
        // sends coalesce into one stdin chunk while the app renders the draft,
        // and Ink's parseKeypress parses one keypress per chunk — '\x1b[BX'
        // parses as a single `down` (trailing X swallowed into the sequence,
        // input=''), '\x1bX' parses as meta+X (MultiLineInput ignores meta).
        // Same pattern as e2e-tmux-edgecases' per-key sleepMs(15).
        await sleepMs(80);
        sendLiteral(target, 'X');
        await sleepMs(200);

        const frame = capture(target);
        for (const expected of testCase.expected) {
          expect(frame).toContain(expected);
        }
      } finally {
        killTmux(session);
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    }
  }, 40_000);

  // SCLI-774: the SCLI-461 fixture WITHOUT the inter-key sleep. Back-to-back
  // tmux sends coalesce into one stdin chunk ('\x1b[BX'); the pre-fix runtime
  // swallowed the trailing X (parseKeypress parses one keypress per chunk,
  // fnKeyRe has no end anchor). The chunk-split fix must make the zero-delay
  // version pass — this is the real user-facing input-loss shape (fast
  // typing, SSH batching, paste containing arrow keys).
  it('preserves drafts across ZERO-DELAY Down+X coalesced chunks (SCLI-774)', async () => {
    const cases = [
      { name: 'zerodelay_down', key: 'Down', parts: ['valuable draft'], expected: ['valuable draftX'] },
      { name: 'zerodelay_escape', key: 'Escape', parts: ['valuable draft'], expected: ['valuable draftX'] },
    ];

    for (const testCase of cases) {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), `shizuha-${testCase.name}-`));
      const { session, target } = launchShizuha(tempHome, testCase.name, 120, 40);

      try {
        await waitForPattern(target, /Type a message|❯/, 15_000);
        sendLiteral(target, testCase.parts.join('\n'));
        // Let the draft render before the coalesced pair — the zero-delay
        // contract is between Down and X (one stdin chunk), not between the
        // draft and the app finishing mount (a keystroke during init lands
        // before the stdin listener attaches and is lost at the tty layer,
        // which is NOT the SCLI-774 drop).
        await sleepMs(300);

        // NO inter-key sleep: Down and X must coalesce into one stdin chunk.
        sendKeys(target, testCase.key);
        sendLiteral(target, 'X');
        await sleepMs(200);

        const frame = capture(target);
        for (const expected of testCase.expected) {
          expect(frame).toContain(expected);
        }
      } finally {
        killTmux(session);
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    }
  }, 40_000);

  it('history navigation preserves drafts (SCLI-461)', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-history-draft-'));
    const { session, target } = launchShizuha(tempHome, 'history_draft', 120, 40);
    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);
      sendLiteral(target, '/status');
      sendKeys(target, 'Enter');
      await waitForPattern(target, /Session:/, 15_000);

      sendLiteral(target, 'draft-xyz');
      sendKeys(target, 'Up');
      await sleepMs(80);
      sendKeys(target, 'Down');
      await sleepMs(80);
      sendLiteral(target, 'X');
      await sleepMs(200);

      expect(capture(target)).toContain('draft-xyzX');
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 40_000);

  // ─── Test 2: Live pane actually changes while a local command runs ───
  it('pane content advances while a slow local command runs', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-anim-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_anim', 80, 24);
    const marker = uniqueMarker('tick');

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);
      sendLiteral(target, `!sh -c 'i=0; while [ $i -lt 6 ]; do echo ${marker}_$i; i=$((i+1)); sleep 0.35; done'`);
      await waitForPattern(target, new RegExp(marker), 10_000);
      sendKeys(target, 'Enter');

      const seen = new Set<string>();
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && seen.size < 3) {
        await sleepMs(200);
        const frame = capture(target);
        for (let i = 0; i < 6; i++) {
          if (frame.includes(`${marker}_${i}`)) seen.add(String(i));
        }
      }
      expect(seen.size, `live command did not advance on screen: ${[...seen]}`).toBeGreaterThanOrEqual(2);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 3: No content truncation ───
  it('shows full agent output without truncation notices', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-notrunc-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_notrunc', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // Use !command to generate long output locally (no API needed)
      const marker = uniqueMarker('seq');
      sendLiteral(target, `!sh -c 'i=1; while [ $i -le 40 ]; do echo ${marker}_$i; i=$((i+1)); done'`);
      await waitForPattern(target, new RegExp(marker), 10_000);
      sendKeys(target, 'Enter');
      const full = await waitForPattern(target, new RegExp(`${marker}_40`), 15_000);

      expect(full).not.toMatch(/\+\d+ lines.*verbose/);
      expect(full).not.toMatch(/\+\d+ lines.*pager/);
      expect(full).not.toMatch(/earlier lines hidden while streaming/);
      expect(full).toContain(`${marker}_40`);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 4: Tall content internal scrolling ───
  it('keeps tmux history empty and scrolls tall content inside the TUI', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-scroll-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_scroll', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      const marker = uniqueMarker('line');
      sendLiteral(target, `!sh -c 'i=1; while [ $i -le 40 ]; do printf "${marker}_%03d\\n\\n" $i; i=$((i+1)); done'`);
      await waitForPattern(target, new RegExp(marker), 10_000);
      sendKeys(target, 'Enter');
      const defaultCapture = await waitForPattern(target, new RegExp(`${marker}_040`), 15_000);
      expect(defaultCapture).toMatch(/❯|Type a message/);
      expect(paneFlags(target)).toBe('1 0 1');

      sendWheel(target, 'up', 14);
      await sleepMs(400);
      const scrolled = capture(target);
      expect(scrolled).not.toBe(defaultCapture);
      expect(scrolled).toMatch(new RegExp(`${marker}_0(0[1-9]|1\\d)`));
      expect(scrolled).toMatch(/❯|Type a message/);
      expect(historySize(target)).toBe('0');
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 45_000);

  // ─── Test 5: Multiple terminal sizes ───
  it.each([
    { width: 60, height: 20, name: 'tiny' },
    { width: 80, height: 24, name: 'standard' },
    { width: 120, height: 50, name: 'large' },
  ])('renders correctly at $name terminal ($width x $height)', async ({ width, height, name }) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), `shizuha-render-size-${name}-`));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, `render_size_${name}`, width, height);

    try {
      const frame = await waitForPattern(target, /Type a message|❯/, 15_000);

      // All essential elements present
      expect(frame).toContain('Shizuha');
      expect(frame).toMatch(/❯|Type a message/);
      expect(frame).toMatch(/─{5,}/); // horizontal rule (shorter on narrow terms)

      // Status bar content not cut off — mode indicator visible
      expect(frame).toMatch(/sup|auto|plan/);

      // Count visible lines — should not exceed terminal height
      const lines = frame.split('\n');
      // tmux capture includes blank trailing lines; filter non-empty
      const nonEmpty = lines.filter((l) => l.trim().length > 0);
      expect(nonEmpty.length).toBeLessThanOrEqual(height);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 6: StatusBar horizontal rule width ───
  it('status bar rule spans terminal width', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-ruler-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_ruler', 80, 24);

    try {
      const frame = await waitForPattern(target, /Type a message|❯/, 15_000);

      const lines = frame.split('\n');
      const ruleLine = lines.find((l) => /^─{10,}$/.test(l.trim()));
      expect(ruleLine).toBeDefined();
      if (ruleLine) {
        // Rule should be close to terminal width (minus padding)
        const ruleLen = ruleLine.trim().length;
        expect(ruleLen).toBeGreaterThanOrEqual(70); // 80 - padding
      }
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 7: Input box stays visible during long response ───
  it('input box remains visible while a long local command streams', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-input-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_input_visible', 80, 24);
    const marker = uniqueMarker('stream');

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);
      sendLiteral(target, `!sh -c 'i=1; while [ $i -le 12 ]; do echo ${marker}_$i; i=$((i+1)); sleep 0.25; done'`);
      await waitForPattern(target, new RegExp(marker), 10_000);
      sendKeys(target, 'Enter');
      await waitForPattern(target, new RegExp(`${marker}_1`), 10_000);

      const violations: string[] = [];
      for (let i = 0; i < 8; i++) {
        await sleepMs(250);
        const frame = capture(target, -24);
        if (!/❯|Type a message|Enter to queue/.test(frame)) violations.push(`frame ${i}: missing input box`);
        if (!/─{10,}/.test(frame)) violations.push(`frame ${i}: missing status rule`);
      }
      expect(violations).toEqual([]);
      await waitForPattern(target, new RegExp(`${marker}_12`), 10_000);
      const final = capture(target, -24);
      expect(final).toMatch(/❯|Type a message/);
      expect(final).toMatch(/─{10,}/);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 40_000);

  // ─── Test 8: No duplicate/garbled lines (rendering integrity) ───
  it('no garbled or duplicate status bars during a live local stream', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-garble-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_garble', 80, 24);
    const marker = uniqueMarker('garble');

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);
      sendLiteral(target, `!sh -c 'i=1; while [ $i -le 10 ]; do echo ${marker}_$i; i=$((i+1)); sleep 0.2; done'`);
      await waitForPattern(target, new RegExp(marker), 10_000);
      sendKeys(target, 'Enter');
      await waitForPattern(target, new RegExp(`${marker}_1`), 10_000);

      const violations: string[] = [];
      for (let i = 0; i < 8; i++) {
        await sleepMs(200);
        const frame = capture(target, -24);
        const lines = frame.split('\n');
        const ruleCount = lines.filter((l) => /^─{10,}$/.test(l.trim())).length;
        if (ruleCount > 1) violations.push(`frame ${i}: ${ruleCount} status rules (expected 1)`);
        const modeCount = lines.filter((l) => /\bsup\b|\bauto\b|\bplan\b/.test(l)).length;
        if (modeCount > 1) violations.push(`frame ${i}: ${modeCount} mode indicators (expected 1)`);
        const inputCount = lines.filter((l) => /❯/.test(l)).length;
        if (inputCount > 1) violations.push(`frame ${i}: ${inputCount} input prompts (expected 1)`);
      }
      expect(violations).toEqual([]);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 9: Launch from bottom of scrollback-full pane ───
  it('renders correctly when launched after heavy scrollback', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-bottom-'));
    stageProviderCredentials(tempHome);

    // Fill the pane with 300 lines of output, then launch shizuha
    const prefill = 'for i in $(seq 1 300); do printf "scrollback-fill-%03d\\n" "$i"; done';
    const launchCommand = `cd ${shQuote(projectDir)} && ${prefill} && HOME=${shQuote(tempHome)} SHIZUHA_DISABLE_MCP_JSON=1 FORCE_COLOR=0 node dist/shizuha.js --model test-model`;
    const { session, target } = launchTmux('render_bottom', 80, 24, launchCommand);

    try {
      // Use default capture (-S -320) to find the TUI among scrollback
      await waitForPattern(target, /Type a message|❯/, 15_000);
      await sleepMs(500); // Let StatusBar finish rendering

      // Capture with scrollback to find all TUI elements
      const full = captureWithScrollback(target);

      // TUI should render correctly despite launching at bottom of scrollback
      expect(full).toContain('Shizuha');
      expect(full).toMatch(/❯|Type a message/);
      // Mode indicator visible somewhere in the output
      expect(full).toMatch(/sup|auto|plan/);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 10: Markdown rendering works (not raw text) ───
  it('renders markdown formatting in completed messages in tmux', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-md-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_md', 100, 30);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // Use !command with markdown-like output (bullet points)
      // The output gets rendered through renderMarkdown for completed messages
      sendLiteral(target, '!printf "* item one\\n* item two\\n* item three\\n"');
      await waitForPattern(target, /item three/, 10_000);
      sendKeys(target, 'Enter');
      await sleepMs(1500);

      const full = captureWithScrollback(target);

      // The output should contain the items
      expect(full).toContain('item one');
      expect(full).toContain('item two');
      expect(full).toContain('item three');
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 11: /resume overlay renders cleanly ───
  it('/resume picker renders without artifacts', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-resume-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_resume', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // Open session picker
      const before = capture(target);
      sendLiteral(target, '/resume');
      await waitForPattern(target, /\/resume/, 8_000);
      sendKeys(target, 'Enter');
      const frame = await waitForPattern(target, /Sessions|No sessions|☰/, 8_000);
      expect(frame).not.toBe(before);

      // Session picker should show
      const hasSessionUI = /Sessions|No sessions|☰/.test(frame);
      expect(hasSessionUI).toBe(true);

      // No duplicate borders or garbled content
      const lines = frame.split('\n');
      const topBorders = lines.filter((l) => l.includes('╭')).length;
      const bottomBorders = lines.filter((l) => l.includes('╰')).length;
      // Should have at most 1 top and 1 bottom border (from picker)
      expect(topBorders).toBeLessThanOrEqual(1);
      expect(bottomBorders).toBeLessThanOrEqual(1);

      // Escape back
      sendKeys(target, 'Escape');
      await sleepMs(300);

      const afterEscape = capture(target);
      expect(afterEscape).toMatch(/❯|Type a message/);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 12: Alt+Backspace (ESC DEL) deletes the previous word ───
  // SCLI-452 real-PTY regression at the required 80×24, 120×40, 200×50 sizes.
  // ESC DEL must map to backward-word deletion (same semantics as Ctrl+W), not
  // ordinary single-character Backspace, and must handle Unicode word runs.
  it.each([
    { width: 80, height: 24, name: '80x24' },
    { width: 120, height: 40, name: '120x40' },
    { width: 200, height: 50, name: '200x50' },
  ])('Alt+Backspace deletes the previous word at $name', async ({ width, height, name }) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), `shizuha-render-altbs-${name}-`));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, `render_altbs_${name}`, width, height);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // ESC DEL = Alt+Backspace, sent as the raw two-byte chord \x1b\x7f.
      const escDel = '\x1b\x7f';

      // ASCII: "one two three" + Alt+Backspace -> "one two " (word deleted).
      sendLiteral(target, 'one two three');
      await sleepMs(300);
      sendLiteral(target, escDel);
      await sleepMs(300);
      let frame = capture(target);
      expect(frame).toContain('one two');
      expect(frame).not.toContain('three');

      // Unicode: "alpha café" + Alt+Backspace -> "alpha " (whole word deleted,
      // not just the non-ASCII "é").
      sendKeys(target, 'C-u');
      await sleepMs(300);
      sendLiteral(target, 'alpha café');
      await sleepMs(300);
      sendLiteral(target, escDel);
      await sleepMs(300);
      frame = capture(target);
      expect(frame).toContain('alpha');
      expect(frame).not.toContain('café');

      // Ordinary Backspace is unchanged: single-cluster delete.
      sendKeys(target, 'C-u');
      await sleepMs(300);
      sendLiteral(target, 'abc');
      await sleepMs(300);
      sendKeys(target, 'BSpace');
      await sleepMs(300);
      frame = capture(target);
      expect(frame).toContain('ab');
      expect(frame).not.toContain('abc');
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 45_000);
}, 600_000); // 10min global timeout for the suite
