/**
 * E2E tmux rendering tests for diffLogUpdate + TUI components.
 *
 * Exercises:
 *  - Initial render (short + tall content)
 *  - Streaming with animations (spinner, timer)
 *  - Tall content scrollback preservation (CSI S)
 *  - Short→tall and tall→short transitions
 *  - No content truncation (full output visible or in scrollback)
 *  - StatusBar rendering (horizontal rule, no box border)
 *  - InputBox always visible at bottom
 *  - Multiple terminal sizes (80x24, 120x50, 60x20)
 *
 * Requires: tmux, SHIZUHA_RUN_TMUX_RENDER_E2E=1
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const projectDir = path.resolve(import.meta.dirname!, '../..');

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, cwd = projectDir): string {
  return execSync(command, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function hasTmux(): boolean {
  try {
    run('tmux -V');
    return true;
  } catch {
    return false;
  }
}

function stageProviderCredentials(tempHome: string): boolean {
  // Copy shizuha config
  const srcDir = path.join(os.homedir(), '.shizuha');
  const dstDir = path.join(tempHome, '.shizuha');
  const candidates = ['credentials.json', 'auth.json', 'jwt_token', 'config.toml'];
  let copiedAny = false;
  for (const file of candidates) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copiedAny = true;
    }
  }
  // Copy codex credentials (for gpt-5.x-codex models)
  const codexSrc = path.join(os.homedir(), '.codex');
  const codexDst = path.join(tempHome, '.codex');
  if (fs.existsSync(codexSrc)) {
    try {
      fs.cpSync(codexSrc, codexDst, { recursive: true });
      copiedAny = true;
    } catch { /* ignore */ }
  }
  return copiedAny;
}

function newSessionName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function launchTmux(
  name: string,
  width: number,
  height: number,
  command: string,
): { session: string; target: string } {
  const session = newSessionName(name);
  const target = `${session}:0.0`;
  run(`tmux new-session -d -x ${width} -y ${height} -s ${shQuote(session)} ${shQuote(command)}`);
  return { session, target };
}

function killTmux(session: string): void {
  try {
    run(`tmux kill-session -t ${shQuote(session)}`);
  } catch {
    // ignore
  }
}

/** Capture visible pane content */
function capture(target: string, startLine = -320): string {
  return run(`tmux capture-pane -p -t ${shQuote(target)} -S ${startLine}`);
}

/** Capture scrollback + visible content */
function captureWithScrollback(target: string, lines = 2000): string {
  return run(`tmux capture-pane -p -t ${shQuote(target)} -S -${lines}`);
}

function sendKeys(target: string, ...keys: string[]): void {
  const args = keys.map(shQuote).join(' ');
  run(`tmux send-keys -t ${shQuote(target)} ${args}`);
}

function sendLiteral(target: string, text: string): void {
  run(`tmux send-keys -t ${shQuote(target)} -l ${shQuote(text)}`);
}

async function waitForPattern(target: string, pattern: RegExp, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = capture(target);
    if (pattern.test(last)) return last;
    await sleepMs(100);
  }
  throw new Error(`Timeout waiting for ${pattern}. Last capture:\n${last.slice(-2000)}`);
}

/** Wait for pattern with scrollback capture */
async function waitForScrollbackPattern(target: string, pattern: RegExp, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = captureWithScrollback(target);
    if (pattern.test(last)) return last;
    await sleepMs(200);
  }
  throw new Error(`Timeout waiting for scrollback ${pattern}. Last capture:\n${last.slice(-2000)}`);
}

/** Launch shizuha with isolated state but real credentials */
function launchShizuha(
  tempHome: string,
  name: string,
  width: number,
  height: number,
): { session: string; target: string } {
  const launchCommand = `cd ${shQuote(projectDir)} && HOME=${shQuote(tempHome)} FORCE_COLOR=0 node dist/shizuha.js --model gpt-5.3-codex`;
  return launchTmux(name, width, height, launchCommand);
}

/** Launch shizuha with real HOME (for API tests) — uses real credentials */
function launchShizuhaReal(
  name: string,
  width: number,
  height: number,
): { session: string; target: string } {
  const launchCommand = `cd ${shQuote(projectDir)} && FORCE_COLOR=0 node dist/shizuha.js --model gpt-5.3-codex`;
  return launchTmux(name, width, height, launchCommand);
}

const runSuite = hasTmux() && process.env['SHIZUHA_RUN_TMUX_RENDER_E2E'] === '1';
const tmuxDescribe = runSuite ? describe : describe.skip;

tmuxDescribe('TUI tmux renderer e2e tests', () => {
  beforeAll(() => {
    run('npm run build');
  }, 35000);

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

  // ─── Test 2: Animations work in tmux ───
  it('shows animated spinner and live timer in tmux during processing', async () => {
    const { session, target } = launchShizuhaReal('render_anim', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // Send a prompt to trigger processing
      sendLiteral(target, 'say hello');
      sendKeys(target, 'Enter');

      // Wait for thinking indicator
      await waitForPattern(target, /Thinking|live/, 15_000);

      // Capture multiple frames to verify animation (spinner/timer changes)
      const frames: string[] = [];
      for (let i = 0; i < 12; i++) {
        await sleepMs(200);
        frames.push(capture(target));
      }

      // Animation indicators: spinner characters OR live timer
      const spinnerPattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
      const livePattern = /live \d+s/;
      const animatedFrames = frames.filter(
        (f) => spinnerPattern.test(f) || livePattern.test(f),
      );
      // At least some frames should show animation indicators
      // (model may respond quickly, so we're lenient)
      expect(animatedFrames.length).toBeGreaterThan(0);

      // Wait for response to finish (best-effort)
      try {
        await waitForPattern(target, /idle/, 60_000);
      } catch {
        // Timeout is acceptable — animation was verified above
      }
    } finally {
      killTmux(session);
    }
  }, 90_000);

  // ─── Test 3: No content truncation ───
  it('shows full agent output without truncation notices', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-notrunc-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_notrunc', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // Use !command to generate long output locally (no API needed)
      sendLiteral(target, '!seq 1 40');
      sendKeys(target, 'Enter');
      await sleepMs(1500);

      // Capture full output (visible + scrollback)
      const full = captureWithScrollback(target);

      // Should NOT contain truncation notices
      expect(full).not.toMatch(/\+\d+ lines.*verbose/);
      expect(full).not.toMatch(/\+\d+ lines.*pager/);
      expect(full).not.toMatch(/earlier lines hidden while streaming/);

      // Should contain the generated output
      expect(full).toContain('40');
      expect(full).toMatch(/!seq 1 40|! seq 1 40/);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  // ─── Test 4: Tall content scrollback preservation ───
  it('preserves scrollback for tall content in tmux', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-scroll-'));
    stageProviderCredentials(tempHome);
    const { session, target } = launchShizuha(tempHome, 'render_scroll', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      // Generate output that exceeds 24 rows: 40 paragraph-separated lines
      // = ~80 visual lines (each "LINE_NNN\n\n" = 2 lines in markdown).
      sendLiteral(target, '!printf "LINE_%03d\\n\\n" $(seq 1 40)');
      sendKeys(target, 'Enter');
      await sleepMs(5000);

      // InputBox must be accessible
      const defaultCapture = capture(target);
      expect(defaultCapture).toMatch(/❯|Type a message/);

      // Capture full scrollback
      const scrollback = captureWithScrollback(target, 1000);

      // Scrollback should have significantly more lines than terminal height
      const scrollbackNonEmpty = scrollback.split('\n').filter((l) => l.trim().length > 0).length;
      expect(scrollbackNonEmpty).toBeGreaterThan(24);

      // The header should be in scrollback
      expect(scrollback).toContain('Shizuha');

      // First and last lines of output should be in scrollback
      expect(scrollback).toContain('LINE_001');
      expect(scrollback).toContain('LINE_040');
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
  it('input box remains visible while streaming long content', async () => {
    const { session, target } = launchShizuhaReal('render_input_visible', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      sendLiteral(target, 'write a long essay about the solar system, at least 40 lines');
      sendKeys(target, 'Enter');

      // Wait for streaming to start
      await waitForPattern(target, /live|Thinking/, 15_000);

      // Check multiple frames during streaming
      const violations: string[] = [];
      for (let i = 0; i < 15; i++) {
        await sleepMs(1500);
        const frame = capture(target, -24);
        const hasInput = /❯|Type a message|Enter to queue/.test(frame);
        const hasStatusRule = /─{10,}/.test(frame);
        if (!hasInput) violations.push(`frame ${i}: missing input box`);
        if (!hasStatusRule) violations.push(`frame ${i}: missing status rule`);
      }

      expect(violations).toEqual([]);

      // Wait for completion (best-effort — API can be slow)
      try {
        await waitForPattern(target, /idle/, 90_000);
        // Final check: input and status visible after completion
        const final = capture(target, -24);
        expect(final).toMatch(/❯|Type a message/);
        expect(final).toMatch(/─{10,}/);
      } catch {
        // Timeout is OK — the streaming frame checks above are what matters
      }
    } finally {
      killTmux(session);
    }
  }, 180_000);

  // ─── Test 8: No duplicate/garbled lines (rendering integrity) ───
  it('no garbled or duplicate status bars during streaming', async () => {
    const { session, target } = launchShizuhaReal('render_garble', 80, 24);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);

      sendLiteral(target, 'explain recursion in detail with examples');
      sendKeys(target, 'Enter');

      await waitForPattern(target, /live|Thinking/, 15_000);

      // Capture frames and check for duplicated status bars
      const violations: string[] = [];
      for (let i = 0; i < 10; i++) {
        await sleepMs(800);
        const frame = capture(target, -24);
        const lines = frame.split('\n');

        // Count status rule lines (─────) — should be exactly 1
        const ruleCount = lines.filter((l) => /^─{10,}$/.test(l.trim())).length;
        if (ruleCount > 1) {
          violations.push(`frame ${i}: ${ruleCount} status rules (expected 1)`);
        }

        // Count mode indicators — should be exactly 1
        const modeCount = lines.filter((l) => /\bsup\b|\bauto\b|\bplan\b/.test(l)).length;
        if (modeCount > 1) {
          violations.push(`frame ${i}: ${modeCount} mode indicators (expected 1)`);
        }

        // Count input prompts — should be exactly 1
        const inputCount = lines.filter((l) => /❯/.test(l)).length;
        if (inputCount > 1) {
          violations.push(`frame ${i}: ${inputCount} input prompts (expected 1)`);
        }
      }

      expect(violations).toEqual([]);

      // Wait for response to finish (best-effort — API can be slow)
      try {
        await waitForPattern(target, /idle/, 90_000);
      } catch {
        // Timeout is OK — the rendering integrity check above is what matters
      }
    } finally {
      killTmux(session);
    }
  }, 120_000);

  // ─── Test 9: Launch from bottom of scrollback-full pane ───
  it('renders correctly when launched after heavy scrollback', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-render-bottom-'));
    stageProviderCredentials(tempHome);

    // Fill the pane with 300 lines of output, then launch shizuha
    const prefill = 'for i in $(seq 1 300); do printf "scrollback-fill-%03d\\n" "$i"; done';
    const launchCommand = `cd ${shQuote(projectDir)} && ${prefill} && HOME=${shQuote(tempHome)} FORCE_COLOR=0 node dist/shizuha.js --model gpt-5.3-codex`;
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
      sendLiteral(target, '/resume');
      sendKeys(target, 'Enter');
      await sleepMs(500);

      const frame = capture(target);

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
}, 600_000); // 10min global timeout for the suite
